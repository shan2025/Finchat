// routes/messages.js — Send messages, fetch history, proof log, fraud log, token ledger
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { detectFraud, getPenalty } = require('../services/fraud');
const { createProof, verifyChain,
  updateProofIPFS, updateProofSolana } = require('../services/proof');
const { pinJSON, pinFile, buildProofDocument } = require('../services/ipfs');
const { anchorHash } = require('../services/solana');

// File upload config
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024 }
});

// ── GET /api/channels ─────────────────────────────────────────
router.get('/channels', requireAuth, (req, res) => {
  const db = getDB();
  const channels = db.prepare('SELECT * FROM channels ORDER BY name').all();
  res.json({ channels });
});

// ── GET /api/messages/:channelId ─────────────────────────────
router.get('/:channelId', requireAuth, (req, res) => {
  const db = getDB();
  const { limit = 50, before } = req.query;

  let query = `
    SELECT m.*, u.name as sender_name, u.role as sender_role,
           p.hash, p.prev_hash, p.chain_height, p.ipfs_cid, p.ipfs_url,
           p.solana_tx, p.solana_confirmed,
           f.risk_level, f.reason as fraud_reason, f.token_penalty
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN proof_chain p ON p.message_id = m.id
    LEFT JOIN fraud_logs f ON f.message_id = m.id
    WHERE m.channel_id = ? AND m.is_deleted = 0
  `;
  const params = [req.params.channelId];

  if (before) { query += ' AND m.created_at < ?'; params.push(before); }
  query += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const messages = db.prepare(query).all(...params).reverse();
  res.json({ messages });
});

// ── POST /api/messages/:channelId ─────────────────────────────
// Main send — handles text + files, fraud detection, proof, IPFS, Solana
router.post('/:channelId', requireAuth, upload.array('files', 5), async (req, res) => {
  const db = getDB();
  const senderId = req.user.id;
  const channelId = req.params.channelId;
  const { content } = req.body;
  const files = req.files || [];

  if (!content && !files.length)
    return res.status(400).json({ error: 'Message content or file required' });

  // Check token balance
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(senderId);
  if (user.token_balance < 5)
    return res.status(402).json({ error: 'Insufficient tokens', balance: user.token_balance });

  try {
    // ── 1. Save message ───────────────────────────────────────
    const messageId = uuidv4();
    const msgType = files.length && !content ? 'file' : 'text';

    db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, content, message_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(messageId, channelId, senderId, content || null, msgType);

    // ── 2. Deduct base token cost ─────────────────────────────
    const newBalance1 = user.token_balance - 5;
    db.prepare('UPDATE users SET token_balance = ? WHERE id = ?').run(newBalance1, senderId);
    db.prepare(`
      INSERT INTO token_ledger (id, user_id, amount, balance, type, reason, message_id)
      VALUES (?, ?, -5, ?, 'spend', 'Message sent', ?)
    `).run(uuidv4(), senderId, newBalance1, messageId);

    // ── 3. Fraud detection (async, non-blocking response) ─────
    const fraudResult = await detectFraud(content || '[file attachment]');
    const penalty = getPenalty(fraudResult.risk);
    const isQuarantined = fraudResult.risk === 'HIGH' ? 1 : 0;

    db.prepare(`
      INSERT INTO fraud_logs (id, message_id, sender_id, risk_level, reason, indicators, model_used, token_penalty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), messageId, senderId, fraudResult.risk,
      fraudResult.reason, JSON.stringify(fraudResult.indicators),
      fraudResult.model || 'simulation', penalty);

    // Apply fraud penalty
    let finalBalance = newBalance1;
    if (penalty > 0) {
      finalBalance = Math.max(0, newBalance1 - penalty);
      db.prepare('UPDATE users SET token_balance = ? WHERE id = ?').run(finalBalance, senderId);
      db.prepare(`
        INSERT INTO token_ledger (id, user_id, amount, balance, type, reason, message_id)
        VALUES (?, ?, ?, ?, 'penalty', ?, ?)
      `).run(uuidv4(), senderId, -penalty, finalBalance,
        `Fraud penalty — ${fraudResult.risk} risk`, messageId);
    }

    // Mark as quarantined
    if (isQuarantined) {
      db.prepare('UPDATE messages SET is_quarantined = 1 WHERE id = ?').run(messageId);
    }

    // Freeze account if tokens depleted
    if (finalBalance <= 0) {
      db.prepare('UPDATE users SET is_frozen = 1 WHERE id = ?').run(senderId);
    }

    // ── 4. Create proof (synchronous — needed for response) ───
    const proof = createProof(messageId, senderId, content || '', channelId);

    // ── 5. Save file records ──────────────────────────────────
    const savedFiles = [];
    for (const f of files) {
      const fileId = uuidv4();
      db.prepare(`
        INSERT INTO files (id, message_id, uploader_id, filename, mimetype, size_bytes, local_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(fileId, messageId, senderId, f.originalname, f.mimetype, f.size, f.path);
      savedFiles.push({ id: fileId, filename: f.originalname, size: f.size, mimetype: f.mimetype });
    }

    // ── 6. Build full response immediately ───────────────────
    const fraudLog = db.prepare('SELECT * FROM fraud_logs WHERE message_id = ?').get(messageId);
    const response = {
      id: messageId,
      channel_id: channelId,
      sender_id: senderId,
      sender_name: user.name,
      sender_role: user.role,
      content,
      message_type: msgType,
      is_quarantined: isQuarantined,
      token_cost: 5 + penalty,
      token_balance: finalBalance,
      created_at: new Date().toISOString(),
      files: savedFiles,
      proof: {
        id: proof.id,
        hash: proof.hash,
        prev_hash: proof.prev_hash,
        chain_height: proof.chain_height,
        ipfs_cid: null,
        solana_tx: null,
        confirmed: false
      },
      fraud: {
        risk: fraudResult.risk,
        reason: fraudResult.reason,
        indicators: fraudResult.indicators,
        model: fraudResult.model || 'simulation',
        penalty
      }
    };

    res.status(201).json(response);

    // ── 7. Async: IPFS + Solana (after response sent) ────────
    setImmediate(async () => {
      try {
        const senderFull = db.prepare('SELECT * FROM users WHERE id = ?').get(senderId);
        const messageFull = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);

        // Pin proof to IPFS
        const proofDoc = buildProofDocument(proof, messageFull, senderFull, fraudLog);
        const ipfsResult = await pinJSON(proofDoc, `finchat-proof-${proof.chain_height}`);
        if (ipfsResult.cid) {
          updateProofIPFS(proof.id, ipfsResult.cid, ipfsResult.url);
        }

        // Pin files to IPFS
        for (const f of files) {
          const fileRecord = db.prepare('SELECT * FROM files WHERE local_path = ?').get(f.path);
          if (fileRecord) {
            const fileIPFS = await pinFile(f.path, f.originalname);
            if (fileIPFS.cid) {
              db.prepare('UPDATE files SET ipfs_cid = ?, ipfs_url = ? WHERE id = ?')
                .run(fileIPFS.cid, fileIPFS.url, fileRecord.id);
            }
          }
        }

        // Anchor to Solana (Periodic Checkpoint)
        const { isCheckpoint } = require('../services/proof');
        if (isCheckpoint(proof.chain_height)) {
          const solanaResult = await anchorHash(proof.hash, proof.chain_height);
          if (solanaResult.tx) {
            updateProofSolana(proof.id, solanaResult.tx, solanaResult.solana_slot || solanaResult.slot);
          }
          console.log(`✅ Async complete: msg ${messageId.substring(0, 8)} | IPFS: ${ipfsResult.cid || 'skipped'} | Solana: ${solanaResult.tx || 'skipped'} (Checkpoint #${proof.chain_height})`);
        } else {
          console.log(`✅ Async complete: msg ${messageId.substring(0, 8)} | IPFS: ${ipfsResult.cid || 'skipped'} | Solana: skipped (not a checkpoint)`);
        }
      } catch (asyncErr) {
        console.error('Async IPFS/Solana error:', asyncErr.message);
      }
    });

  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/messages/:channelId/proof ───────────────────────
router.get('/:channelId/proof', requireAuth, (req, res) => {
  const db = getDB();
  const chain = db.prepare(`
    SELECT p.*, u.name as sender_name, u.role as sender_role,
           f.risk_level, f.reason as fraud_reason,
           m.content, m.message_type
    FROM proof_chain p
    JOIN messages m ON p.message_id = m.id
    JOIN users u ON p.sender_id = u.id
    LEFT JOIN fraud_logs f ON f.message_id = m.id
    WHERE m.channel_id = ?
    ORDER BY p.chain_height ASC
  `).all(req.params.channelId);

  const verification = verifyChain(req.params.channelId);
  res.json({ chain, verification });
});

// ── GET /api/messages/:channelId/fraud ───────────────────────
// Admins and Auditors only
router.get('/:channelId/fraud', requireAuth, requireRole(['admin', 'auditor']), (req, res) => {
  const db = getDB();
  const logs = db.prepare(`
    SELECT f.*, u.name as sender_name, m.content
    FROM fraud_logs f
    JOIN users u ON f.sender_id = u.id
    JOIN messages m ON f.message_id = m.id
    WHERE m.channel_id = ?
    ORDER BY f.created_at DESC
  `).all(req.params.channelId);
  res.json({ logs });
});

// ── GET /api/tokens ───────────────────────────────────────────
router.get('/tokens/ledger', requireAuth, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id, name, token_balance, is_frozen FROM users WHERE id = ?').get(req.user.id);
  const ledger = db.prepare(`
    SELECT * FROM token_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ balance: user.token_balance, frozen: user.is_frozen, ledger });
});

module.exports = router;
