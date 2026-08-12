// services/proof.js — SHA-256 hash chaining + proof of conversation
const crypto = require('crypto');
const { query, getPool } = require('../database');
const { v4: uuidv4 } = require('uuid');

const CHECKPOINT_INTERVAL = 10;

function isCheckpoint(height) {
  return height > 0 && height % CHECKPOINT_INTERVAL === 0;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function getLatestHash(channelId) {
  const res = await query(`
    SELECT p.hash FROM proof_chain p
    JOIN messages m ON p.message_id = m.message_id
    WHERE m.channel_id = $1
    ORDER BY p.chain_height DESC
    LIMIT 1
  `, [channelId]);
  return res.rows[0] ? res.rows[0].hash : '0000000000000000000000000000000000000000000000000000000000000000';
}

async function getNextHeight(channelId) {
  const res = await query(`
    SELECT MAX(p.chain_height) as h FROM proof_chain p
    JOIN messages m ON p.message_id = m.message_id
    WHERE m.channel_id = $1
  `, [channelId]);
  return (res.rows[0]?.h || 0) + 1;
}

async function createProof(messageId, senderId, content, channelId) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const resLatest = await client.query(`
      SELECT p.hash FROM proof_chain p
      JOIN messages m ON p.message_id = m.message_id
      WHERE m.channel_id = $1
      ORDER BY p.chain_height DESC
      LIMIT 1
    `, [channelId]);
    const prevHash = resLatest.rows[0] ? resLatest.rows[0].hash : '0000000000000000000000000000000000000000000000000000000000000000';

    const resHeight = await client.query(`
      SELECT MAX(p.chain_height) as h FROM proof_chain p
      JOIN messages m ON p.message_id = m.message_id
      WHERE m.channel_id = $1
    `, [channelId]);
    const height = (resHeight.rows[0]?.h || 0) + 1;

    const ts = new Date().toISOString();
    const contentHash = sha256((content || '').trim());
    const rawData = `${prevHash}|${height}|${senderId}|${contentHash}|${ts}`;
    const hash = sha256(rawData);

    const proofId = uuidv4();
    await client.query(`
      INSERT INTO proof_chain
        (proof_id, message_id, chain_height, hash, prev_hash, sender_id, content_hash, timestamp)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [proofId, messageId, height, hash, prevHash, senderId, contentHash, ts]);

    await client.query('COMMIT');

    return {
      id: proofId,
      proof_id: proofId,
      message_id: messageId,
      chain_height: height,
      hash,
      prev_hash: prevHash,
      sender_id: senderId,
      content_hash: contentHash,
      timestamp: ts
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function verifyChain(channelId) {
  const res = await query(`
    SELECT p.*, p.proof_id as id, m.content, m.sender_id as msg_sender_id
    FROM proof_chain p
    JOIN messages m ON p.message_id = m.message_id
    WHERE m.channel_id = $1
    ORDER BY p.chain_height ASC
  `, [channelId]);
  const chain = res.rows;

  let valid = true;
  const issues = [];

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];

    const expectedPrev = i === 0
      ? '0000000000000000000000000000000000000000000000000000000000000000'
      : chain[i - 1].hash;

    if (entry.prev_hash !== expectedPrev) {
      valid = false;
      issues.push(`Block #${entry.chain_height}: Broken Chain! prev_hash mismatch. Expected ${expectedPrev.substring(0, 8)}... got ${entry.prev_hash.substring(0, 8)}...`);
    }

    const calculatedContentHash = sha256((entry.content || '').trim());
    if (calculatedContentHash !== entry.content_hash) {
      valid = false;
      issues.push(`Block #${entry.chain_height}: Content Tampered! Message content does not match stored content hash.`);
    }

    // The block hash was created over the ISO-8601 string form of the
    // timestamp (see createProof), but node-pg hands timestamptz columns back
    // as JS Date objects — interpolating those raw yields "Fri Jul 18 2026 …"
    // and every recomputed hash fails. Canonicalize back to the exact ISO
    // string that was hashed at creation time.
    const tsIso = entry.timestamp instanceof Date
      ? entry.timestamp.toISOString()
      : new Date(entry.timestamp).toISOString();
    const rawData = `${entry.prev_hash}|${entry.chain_height}|${entry.sender_id}|${entry.content_hash}|${tsIso}`;
    const calculatedHash = sha256(rawData);

    if (calculatedHash !== entry.hash) {
      valid = false;
      issues.push(`Block #${entry.chain_height}: Invalid Block Hash! The block signature is invalid.`);
    }
  }

  return { valid, totalBlocks: chain.length, issues };
}

async function updateProofIPFS(proofId, cid, url) {
  await query(`
    UPDATE proof_chain SET ipfs_cid = $1, ipfs_url = $2, ipfs_pinned = 1 WHERE proof_id = $3
  `, [cid, url, proofId]);
}

// `confirmed` must reflect whether the transaction really landed on-chain.
// anchorHash() falls back to a fake "sim_" signature when devnet is unreachable
// or the wallet cannot be funded, and recording those as confirmed made the
// audit trail claim on-chain proof that does not exist. Simulated anchors are
// still stored (they show the checkpoint was reached) but marked unconfirmed.
async function updateProofSolana(proofId, txSignature, slot, confirmed = true) {
  await query(`
    UPDATE proof_chain SET solana_tx = $1, solana_slot = $2, solana_confirmed = $3 WHERE proof_id = $4
  `, [txSignature, slot, confirmed ? 1 : 0, proofId]);
}

module.exports = { createProof, verifyChain, updateProofIPFS, updateProofSolana, sha256, isCheckpoint };
