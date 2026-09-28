// services/agents/SentinelAgent.js — Execution Middleware & Governance Watchdog
const crypto = require('crypto');
const { query } = require('../../database');
const { eventBus } = require('../cognitive/EventBus');
const { checkBudget } = require('../cognitive/ExecutionManager');

// The words in each pattern must sit close together (G = up to ~25 chars,
// never across a sentence or line) and form a request, not a mention. The old
// `a.*b` forms spanned whole messages, so a long pasted document containing
// "account" and, paragraphs later, "details" wiped a user's balance.
const G = "[^.!?\\n]{0,25}";
const rx = (src) => new RegExp(src, 'i');

// EXTREME fraud patterns — asking for credentials, urgent money movement,
// building attack tooling
const EXTREME_PATTERNS = [
  rx(`\\b(send|share|give|tell|forward)\\s+(me\\s+|us\\s+)?(the\\s+|your\\s+|that\\s+|this\\s+)?(otp|one[\\s-]time\\s+(password|code))\\b`),
  rx(`\\b(send|share|give|tell|enter)\\b${G}\\b(cvv|card\\s+number|atm\\s+pin|upi\\s+pin)\\b`),
  rx(`\\b(send|share|give|tell|enter)\\b${G}\\byour\\s+(password|ssn|aadhaar|pin)\\b`),
  rx(`\\b(send|share|give|tell)\\b${G}\\b(bank\\s+)?account\\s+(number|details|credentials)\\b`),
  rx(`\\bsend\\b${G}\\bmoney\\b${G}\\burgent(ly)?\\b|\\burgent(ly)?\\s+(pay|payment|wire)\\b|\\btransfer\\b${G}\\bimmediately\\b`),
  rx(`\\bvia\\s+western\\s+union\\b`),
  rx(`\\bpretend\\s+to\\s+be\\s+(my|a|an|the)\\s+(bank|officer|police|manager|ceo|government)\\b`),
  rx(`\\b(write|create|build|make|generate|code)\\b${G}\\b(phishing|malware|ransomware|keylogger)\\b`)
];

// HIGH fraud patterns — scam phrasing, suspicious but less severe
const HIGH_PATTERNS = [
  rx(`\\bclick\\s+(on\\s+)?(this|the\\s+link|here)\\b${G}\\b(verify|claim|unlock|reset)\\b|\\bverify\\b${G}https?:\\/\\/`),
  rx(`\\byou('ve|\\s+have)?\\s+won\\b${G}\\b(lottery|prize|jackpot)\\b|\\bclaim\\s+your\\s+prize\\b`),
  rx(`\\bdon'?t\\s+tell\\s+anyone\\b|\\bkeep\\s+(this|it)\\s+(a\\s+)?secret\\b`),
  rx(`\\bguaranteed\\s+(\\d+%\\s+)?returns?\\b|\\bno[\\s-]risk\\s+investment\\b|\\b100%\\s+profit\\b`)
];

/**
 * Classify fraud severity for a message.
 */
function classifyFraudSeverity(message) {
  if (EXTREME_PATTERNS.some(p => p.test(message))) return 'EXTREME';
  if (HIGH_PATTERNS.some(p => p.test(message))) return 'HIGH';
  return 'LOW';
}

/**
 * Helper to ensure foreign key targets exist in users, channels, messages tables.
 */
async function ensureForeignKeys(userId, messageId = null, messageContent = '') {
  try {
    const uid = userId || 'system';
    // Ensure user exists with notNull name column
    await query(`
      INSERT INTO users (user_id, email, name, role, password_hash)
      VALUES ($1, $1 || '@system.finchat.local', 'System User ' || $1, 'user', 'none')
      ON CONFLICT (user_id) DO NOTHING
    `, [uid]);

    if (messageId) {
      // Ensure system channel exists
      await query(`
        INSERT INTO channels (channel_id, name, type)
        VALUES ('system_channel', 'System Channel', 'system')
        ON CONFLICT (channel_id) DO NOTHING
      `);

      // Ensure message exists
      await query(`
        INSERT INTO messages (message_id, channel_id, sender_id, content)
        VALUES ($1, 'system_channel', $2, $3)
        ON CONFLICT (message_id) DO NOTHING
      `, [messageId, uid, messageContent]);
    }
  } catch (err) {
    console.error('⚠️ Sentinel helper failed to verify foreign keys:', err.message);
  }
}

/**
 * SentinelAgent acts as cross-cutting execution middleware wrapping both
 * Plato-routed (indirect) and direct-to-agent interactions.
 * It is NOT addressed directly by users — it monitors all traffic.
 */
class SentinelAgent {
  static classifyFraudSeverity(message) {
    return classifyFraudSeverity(message);
  }

  /**
   * Pre-execution check: evaluates fraud risk and budget constraints.
   * @param {string} message - User message/goal
   * @param {object} [options={}] - Execution options
   * @returns {Promise<{ allowed: boolean, reason?: string, fraudDetected?: boolean, fraudSeverity?: string }>}
   */
  static async preCheck(message, options = {}) {
    const severity = classifyFraudSeverity(message);
    const userId = options.userId || 'system';
    const msgId = options.executionId || `msg_sentinel_${Date.now()}`;

    // If extreme or high fraud severity detected, block execution immediately
    if (severity === 'EXTREME' || severity === 'HIGH') {
      const reason = `Security violation flagged (${severity} severity). Execution restricted by Sentinel governance protocols.`;

      try {
        await ensureForeignKeys(userId, msgId, message);
        const fraudLogId = `fraud_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await query(`
          INSERT INTO fraud_logs (fraud_log_id, message_id, sender_id, risk_level, reason, indicators, model_used, token_penalty, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        `, [
          fraudLogId,
          msgId,
          userId,
          severity,
          reason,
          'regex_pattern_match',
          'sentinel_precheck',
          0
        ]);
      } catch (err) {
        console.error('⚠️ Sentinel failed to write to fraud_logs:', err.message);
      }

      eventBus.emit('sentinel:fraud_blocked', {
        userId,
        message: message.substring(0, 100),
        severity,
        timestamp: new Date().toISOString()
      });

      return {
        allowed: false,
        reason,
        fraudDetected: true,
        fraudSeverity: severity
      };
    }

    // Check budget limits if executionId is provided
    if (options.executionId) {
      const budget = await checkBudget(options.executionId);
      if (budget && budget.breached) {
        eventBus.emit('sentinel:budget_breached', {
          executionId: options.executionId,
          reason: budget.reason,
          timestamp: new Date().toISOString()
        });

        return {
          allowed: false,
          reason: `Execution budget breached (${budget.reason}). Action halted by Sentinel protocols.`,
          fraudDetected: false
        };
      }
    }

    return { allowed: true, fraudSeverity: 'LOW' };
  }

  /**
   * Post-execution log: intercepts completed results, generates SHA-256 hash trace,
   * stores audit log, and prepares for blockchain/Hyperledger anchoring.
   * @param {object} result - Execution result returned by agent
   * @param {object} [options={}] - Execution context options
   */
  static async postLog(result, options = {}) {
    const executionId = result.executionId || options.executionId || `audit_${Date.now()}`;
    const userId = options.userId || 'system';
    const responseText = result.cleanResponse || result.response || '';

    // Generate SHA-256 cryptographic trace of input + output + agent
    const rawTrace = `${executionId}|${userId}|${options.goal || ''}|${responseText}|${result.delegatedAgent || 'plato'}`;
    const traceHash = crypto.createHash('sha256').update(rawTrace).digest('hex');

    try {
      await ensureForeignKeys(userId);
      const logId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      await query(`
        INSERT INTO audit_logs (log_id, user_id, action, target_type, target_id, details, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        logId,
        userId,
        'COGNITIVE_EXECUTION_COMPLETED',
        'execution',
        executionId,
        JSON.stringify({
          delegatedAgent: result.delegatedAgent || 'plato',
          traceHash,
          isDirect: Boolean(result.isDirect)
        })
      ]);
    } catch (err) {
      console.error('⚠️ Sentinel failed to write to audit_logs:', err.message);
    }

    // Emit event for real-time monitoring / Hyperledger anchoring
    eventBus.emit('sentinel:audit_logged', {
      executionId,
      userId,
      delegatedAgent: result.delegatedAgent || 'plato',
      traceHash,
      timestamp: new Date().toISOString()
    });

    // Attach trace metadata to the returned result object
    result.auditTraceHash = traceHash;
    return result;
  }
}

module.exports = { SentinelAgent, classifyFraudSeverity, EXTREME_PATTERNS, HIGH_PATTERNS };
