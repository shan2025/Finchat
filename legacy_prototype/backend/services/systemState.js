// services/systemState.js — Live system state snapshot for Plato's dynamic awareness
// Queries DB and services to build a real-time context string injected into Plato's prompt

const { getDB } = require('../database');
const { isReachable } = require('./solana');

/**
 * Generate a live system snapshot string for Plato's system prompt.
 * Called every time a user chats with Plato so it always has fresh data.
 */
async function getSystemSnapshot() {
  const db = getDB();
  const now = new Date().toISOString();

  // ── User Stats ──────────────────────────────────────────────
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const frozenUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_frozen = 1').get().c;
  const activeUsers = totalUsers - frozenUsers;
  const roleCounts = db.prepare(`
    SELECT role, COUNT(*) as c FROM users GROUP BY role
  `).all();
  const roleBreakdown = roleCounts.map(r => `${r.role}: ${r.c}`).join(', ');

  // ── Frozen user details ─────────────────────────────────────
  const frozenList = db.prepare(`
    SELECT name, email, token_balance FROM users WHERE is_frozen = 1 LIMIT 10
  `).all();
  const frozenDetails = frozenList.length > 0
    ? frozenList.map(u => `  • ${u.name} (${u.email}) — balance: ${u.token_balance}`).join('\n')
    : '  None';

  // ── Message Stats ───────────────────────────────────────────
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const quarantinedMessages = db.prepare('SELECT COUNT(*) as c FROM messages WHERE is_quarantined = 1').get().c;

  // ── Token Stats ─────────────────────────────────────────────
  const tokenStats = db.prepare(`
    SELECT 
      COALESCE(AVG(token_balance), 0) as avg_balance,
      COALESCE(SUM(token_balance), 0) as total_supply,
      COALESCE(MIN(token_balance), 0) as min_balance,
      COALESCE(MAX(token_balance), 0) as max_balance
    FROM users
  `).get();

  // ── Proof Chain Stats ───────────────────────────────────────
  const chainHeight = db.prepare('SELECT COALESCE(MAX(chain_height), 0) as h FROM proof_chain').get().h;
  const latestProof = db.prepare('SELECT hash, timestamp FROM proof_chain ORDER BY chain_height DESC LIMIT 1').get();
  const solanaCheckpoints = db.prepare('SELECT COUNT(*) as c FROM proof_chain WHERE solana_confirmed = 1').get().c;
  const lastCheckpoint = db.prepare(`
    SELECT solana_tx, timestamp FROM proof_chain 
    WHERE solana_confirmed = 1 ORDER BY chain_height DESC LIMIT 1
  `).get();

  // ── Fraud Stats ─────────────────────────────────────────────
  const totalFraud = db.prepare('SELECT COUNT(*) as c FROM fraud_logs').get().c;
  const fraudByLevel = db.prepare(`
    SELECT risk_level, COUNT(*) as c FROM fraud_logs GROUP BY risk_level
  `).all();
  const fraudBreakdown = fraudByLevel.map(f => `${f.risk_level}: ${f.c}`).join(', ') || 'None';

  const recentFraud = db.prepare(`
    SELECT f.risk_level, f.reason, f.created_at, u.name as user_name
    FROM fraud_logs f
    LEFT JOIN users u ON f.sender_id = u.id
    ORDER BY f.created_at DESC LIMIT 5
  `).all();

  const recentFraudText = recentFraud.length > 0
    ? recentFraud.map(f => `  • [${f.risk_level}] ${f.user_name || 'unknown'}: ${f.reason} (${f.created_at})`).join('\n')
    : '  No fraud events recorded';

  // ── ZKP Proof Stats ─────────────────────────────────────────
  const totalZKP = db.prepare('SELECT COUNT(*) as c FROM zkp_proofs').get().c;
  const recentZKP = db.prepare(`
    SELECT z.proof_type, z.reason, z.created_at, 
           a.name as admin_name, u.name as target_name
    FROM zkp_proofs z
    LEFT JOIN users a ON z.admin_id = a.id
    LEFT JOIN users u ON z.target_user_id = u.id
    ORDER BY z.created_at DESC LIMIT 5
  `).all();

  const recentZKPText = recentZKP.length > 0
    ? recentZKP.map(z => `  • ${z.proof_type} by ${z.admin_name || 'admin'} for ${z.target_name || 'user'}: ${z.reason || 'no reason'} (${z.created_at})`).join('\n')
    : '  No ZKP proofs issued';

  // ── Solana Status ───────────────────────────────────────────
  let solanaStatus = 'UNKNOWN';
  try {
    const reachable = await isReachable();
    solanaStatus = reachable ? 'CONNECTED' : 'OFFLINE (simulating)';
  } catch {
    solanaStatus = 'ERROR';
  }

  // ── Channel Stats ───────────────────────────────────────────
  const channels = db.prepare('SELECT name, type FROM channels').all();
  const channelText = channels.map(c => `${c.name} (${c.type})`).join(', ');

  // ── Server Info ─────────────────────────────────────────────
  const uptimeSeconds = process.uptime();
  const uptimeH = Math.floor(uptimeSeconds / 3600);
  const uptimeM = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeM}m` : `${uptimeM}m`;
  const aiModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

  // ── Build the snapshot ──────────────────────────────────────
  return `
=== LIVE SYSTEM STATE (as of ${now}) ===

USERS:
  Total: ${totalUsers} | Active: ${activeUsers} | Frozen: ${frozenUsers}
  Roles: ${roleBreakdown}
  Frozen Accounts:
${frozenDetails}

MESSAGES:
  Total: ${totalMessages} | Quarantined: ${quarantinedMessages}

TOKEN ECONOMY:
  Total Supply: ${Math.round(tokenStats.total_supply)} CHAT tokens across all users
  Average Balance: ${Math.round(tokenStats.avg_balance)} | Min: ${tokenStats.min_balance} | Max: ${tokenStats.max_balance}

PROOF CHAIN:
  Chain Height: ${chainHeight}
  Latest Hash: ${latestProof ? latestProof.hash.substring(0, 16) + '...' : 'N/A'}
  Latest Timestamp: ${latestProof ? latestProof.timestamp : 'N/A'}

SOLANA BLOCKCHAIN:
  Status: ${solanaStatus}
  Anchored Checkpoints: ${solanaCheckpoints}
  Last Checkpoint TX: ${lastCheckpoint ? lastCheckpoint.solana_tx : 'None yet'}

FRAUD DETECTION:
  Total Events: ${totalFraud} | Breakdown: ${fraudBreakdown}
  Recent Fraud:
${recentFraudText}

ZKP GOVERNANCE PROOFS:
  Total: ${totalZKP}
  Recent:
${recentZKPText}

CHANNELS: ${channelText}

SERVER:
  Uptime: ${uptimeStr}
  AI Model: ${aiModel}
  Database: SQLite (WAL mode)

=== END LIVE STATE ===`.trim();
}

module.exports = { getSystemSnapshot };
