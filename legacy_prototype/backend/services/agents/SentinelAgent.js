// services/agents/SentinelAgent.js — Execution Middleware & Governance Watchdog
const crypto = require('crypto');
const { query } = require('../../database');
const { eventBus } = require('../cognitive/EventBus');
const { checkBudget } = require('../cognitive/ExecutionManager');

// EXTREME fraud patterns — direct credential theft, wire fraud, impersonation
const EXTREME_PATTERNS = [
  /send.*otp|share.*otp|give.*otp/i,
  /credit.*card|cvv|pin.*number/i,
  /your.*password|your.*ssn|your.*aadhaar/i,
  /wire.*transfer|western.*union|urgent.*pay/i,
  /send.*money.*urgent|transfer.*immediately/i,
  /bank.*account.*number|account.*details/i,
  /impersonat|pretend.*to.*be/i,
  /phishing|malware|ransom/i
];

// HIGH fraud patterns — suspicious but less severe
const HIGH_PATTERNS = [
  /click.*link|verify.*http|password.*reset/i,
  /won.*lottery|claim.*prize|inheritance/i,
  /don'?t.*tell.*anyone|keep.*secret/i,
  /guaranteed.*return|no.*risk.*invest|100%.*profit/i
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
