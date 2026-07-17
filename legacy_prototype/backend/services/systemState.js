// services/systemState.js — Live system state snapshot for Plato's dynamic awareness
const { query } = require('../database');
const { isReachable } = require('./solana');

async function getSystemSnapshot() {
  const now = new Date().toISOString();

  const resTotalUsers = await query('SELECT COUNT(*) as c FROM users');
  const totalUsers = resTotalUsers.rows[0].c;
  const resFrozenUsers = await query('SELECT COUNT(*) as c FROM users WHERE is_frozen = 1');
  const frozenUsers = resFrozenUsers.rows[0].c;
  const activeUsers = totalUsers - frozenUsers;
  const resRoles = await query(`
    SELECT role, COUNT(*) as c FROM users GROUP BY role
  `);
  const roleCounts = resRoles.rows;
  const roleBreakdown = roleCounts.map(r => `${r.role}: ${r.c}`).join(', ');

  const resFrozenList = await query(`
    SELECT name, email, token_balance FROM users WHERE is_frozen = 1 LIMIT 10
  `);
  const frozenList = resFrozenList.rows;
  const frozenDetails = frozenList.length > 0
    ? frozenList.map(u => `  • ${u.name} (${u.email}) — balance: ${u.token_balance}`).join('\n')
    : '  None';

  const resTotalMessages = await query('SELECT COUNT(*) as c FROM messages');
  const totalMessages = resTotalMessages.rows[0].c;
  const resQuarantined = await query('SELECT COUNT(*) as c FROM messages WHERE is_quarantined = 1');
  const quarantinedMessages = resQuarantined.rows[0].c;

  const resTokenStats = await query(`
    SELECT 
      COALESCE(AVG(token_balance), 0) as avg_balance,
      COALESCE(SUM(token_balance), 0) as total_supply,
      COALESCE(MIN(token_balance), 0) as min_balance,
      COALESCE(MAX(token_balance), 0) as max_balance
    FROM users
  `);
  const tokenStats = resTokenStats.rows[0];

  const resChainHeight = await query('SELECT COALESCE(MAX(chain_height), 0) as h FROM proof_chain');
  const chainHeight = resChainHeight.rows[0].h;
  const resLatestProof = await query('SELECT hash, timestamp FROM proof_chain ORDER BY chain_height DESC LIMIT 1');
  const latestProof = resLatestProof.rows[0];
  const resSolCheck = await query('SELECT COUNT(*) as c FROM proof_chain WHERE solana_confirmed = 1');
  const solanaCheckpoints = resSolCheck.rows[0].c;
  const resLastCheck = await query(`
    SELECT solana_tx, timestamp FROM proof_chain 
    WHERE solana_confirmed = 1 ORDER BY chain_height DESC LIMIT 1
  `);
  const lastCheckpoint = resLastCheck.rows[0];

  const resTotalFraud = await query('SELECT COUNT(*) as c FROM fraud_logs');
  const totalFraud = resTotalFraud.rows[0].c;
  const resFraudByLevel = await query(`
    SELECT risk_level, COUNT(*) as c FROM fraud_logs GROUP BY risk_level
  `);
  const fraudByLevel = resFraudByLevel.rows;
  const fraudBreakdown = fraudByLevel.map(f => `${f.risk_level}: ${f.c}`).join(', ') || 'None';

  const resRecentFraud = await query(`
    SELECT f.risk_level, f.reason, f.created_at, u.name as user_name
    FROM fraud_logs f
    LEFT JOIN users u ON f.sender_id = u.user_id
    ORDER BY f.created_at DESC LIMIT 5
  `);
  const recentFraud = resRecentFraud.rows;

  const recentFraudText = recentFraud.length > 0
    ? recentFraud.map(f => `  • [${f.risk_level}] ${f.user_name || 'unknown'}: ${f.reason} (${f.created_at})`).join('\n')
    : '  No fraud events recorded';

  const resTotalZKP = await query('SELECT COUNT(*) as c FROM zkp_proofs');
  const totalZKP = resTotalZKP.rows[0].c;
  const resRecentZKP = await query(`
    SELECT z.proof_type, z.reason, z.created_at, 
           a.name as admin_name, u.name as target_name
    FROM zkp_proofs z
    LEFT JOIN users a ON z.admin_id = a.user_id
    LEFT JOIN users u ON z.target_user_id = u.user_id
    ORDER BY z.created_at DESC LIMIT 5
  `);
  const recentZKP = resRecentZKP.rows;

  const recentZKPText = recentZKP.length > 0
    ? recentZKP.map(z => `  • ${z.proof_type} by ${z.admin_name || 'admin'} for ${z.target_name || 'user'}: ${z.reason || 'no reason'} (${z.created_at})`).join('\n')
    : '  No ZKP proofs issued';

  let solanaStatus = 'UNKNOWN';
  try {
    const reachable = await isReachable();
    solanaStatus = reachable ? 'CONNECTED' : 'OFFLINE (simulating)';
  } catch {
    solanaStatus = 'ERROR';
  }

  const resChannels = await query('SELECT name, type FROM channels');
  const channels = resChannels.rows;
  const channelText = channels.map(c => `${c.name} (${c.type})`).join(', ');

  const uptimeSeconds = process.uptime();
  const uptimeH = Math.floor(uptimeSeconds / 3600);
  const uptimeM = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeM}m` : `${uptimeM}m`;
  const aiModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

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
  Database: PostgreSQL (Supabase Pool)

=== END LIVE STATE ===`.trim();
}

module.exports = { getSystemSnapshot };
