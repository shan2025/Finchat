// services/proof.js — SHA-256 hash chaining + proof of conversation
const crypto = require('crypto');
const { getDB } = require('../database');
const { v4: uuidv4 } = require('uuid');

// Periodic anchoring config
const CHECKPOINT_INTERVAL = 10;

function isCheckpoint(height) {
  return height > 0 && height % CHECKPOINT_INTERVAL === 0;
}

// SHA-256 helper
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Get the latest hash in the chain (per channel)
function getLatestHash(channelId) {
  const db = getDB();
  const row = db.prepare(`
    SELECT p.hash FROM proof_chain p
    JOIN messages m ON p.message_id = m.id
    WHERE m.channel_id = ?
    ORDER BY p.chain_height DESC
    LIMIT 1
  `).get(channelId);
  return row ? row.hash : '0000000000000000000000000000000000000000000000000000000000000000';
}

// Get next chain height per channel
function getNextHeight(channelId) {
  const db = getDB();
  const row = db.prepare(`
    SELECT MAX(p.chain_height) as h FROM proof_chain p
    JOIN messages m ON p.message_id = m.id
    WHERE m.channel_id = ?
  `).get(channelId);
  return (row.h || 0) + 1;
}

// Create a proof entry for a message (Atomic Transaction)
function createProof(messageId, senderId, content, channelId) {
  const db = getDB();

  // Wrap in transaction to prevent race conditions (two messages getting same height)
  const insertProof = db.transaction(() => {
    const prevHash = getLatestHash(channelId); // Safe inside tx (WAL mode serialization)
    const height = getNextHeight(channelId);
    const ts = new Date().toISOString();

    const contentHash = sha256((content || '').trim());
    const rawData = `${prevHash}|${height}|${senderId}|${contentHash}|${ts}`;
    const hash = sha256(rawData);

    const proof = {
      id: uuidv4(),
      message_id: messageId,
      chain_height: height,
      hash,
      prev_hash: prevHash,
      sender_id: senderId,
      content_hash: contentHash,
      timestamp: ts
    };

    db.prepare(`
      INSERT INTO proof_chain
        (id, message_id, chain_height, hash, prev_hash, sender_id, content_hash, timestamp)
      VALUES
        (@id, @message_id, @chain_height, @hash, @prev_hash, @sender_id, @content_hash, @timestamp)
    `).run(proof);

    return proof;
  });

  return insertProof();
}

// Verify the full chain integrity for a channel (checks content hash + block hash + chain links)
function verifyChain(channelId) {
  const db = getDB();
  const chain = db.prepare(`
    SELECT p.*, m.content, m.sender_id as msg_sender_id
    FROM proof_chain p
    JOIN messages m ON p.message_id = m.id
    WHERE m.channel_id = ?
    ORDER BY p.chain_height ASC
  `).all(channelId);

  let valid = true;
  const issues = [];

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];

    // 1. Check prev_hash link
    const expectedPrev = i === 0
      ? '0000000000000000000000000000000000000000000000000000000000000000'
      : chain[i - 1].hash;

    if (entry.prev_hash !== expectedPrev) {
      valid = false;
      issues.push(`Block #${entry.chain_height}: Broken Chain! prev_hash mismatch. Expected ${expectedPrev.substring(0, 8)}... got ${entry.prev_hash.substring(0, 8)}...`);
    }

    // 2. Check content integrity (re-hash content)
    const calculatedContentHash = sha256((entry.content || '').trim());
    if (calculatedContentHash !== entry.content_hash) {
      valid = false;
      issues.push(`Block #${entry.chain_height}: Content Tampered! Message content does not match stored content hash.`);
    }

    // 3. Check block hash integrity (re-hash the whole block)
    const rawData = `${entry.prev_hash}|${entry.chain_height}|${entry.sender_id}|${entry.content_hash}|${entry.timestamp}`;
    const calculatedHash = sha256(rawData);

    if (calculatedHash !== entry.hash) {
      valid = false;
      issues.push(`Block #${entry.chain_height}: Invalid Block Hash! The block signature is invalid.`);
    }
  }

  return { valid, totalBlocks: chain.length, issues };
}

// Update proof with IPFS CID after pinning
function updateProofIPFS(proofId, cid, url) {
  const db = getDB();
  db.prepare(`
    UPDATE proof_chain SET ipfs_cid = ?, ipfs_url = ?, ipfs_pinned = 1 WHERE id = ?
  `).run(cid, url, proofId);
}

// Update proof with Solana tx
function updateProofSolana(proofId, txSignature, slot) {
  const db = getDB();
  db.prepare(`
    UPDATE proof_chain SET solana_tx = ?, solana_slot = ?, solana_confirmed = 1 WHERE id = ?
  `).run(txSignature, slot, proofId);
}

module.exports = { createProof, verifyChain, updateProofIPFS, updateProofSolana, sha256, isCheckpoint };
