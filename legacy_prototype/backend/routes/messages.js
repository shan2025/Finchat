// routes/messages.js — Send messages, fetch history, proof log, fraud log, token ledger
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
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
router.get('/channels', requireAuth, async (req, res) => {
  try {
    const resChannels = await query('SELECT *, channel_id as id FROM channels ORDER BY name');
    res.json({ channels: resChannels.rows });
  } catch (err) {
    console.error('Fetch channels error:', err);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// ── GET /api/messages/:channelId ─────────────────────────────
router.get('/:channelId', requireAuth, async (req, res) => {
  try {
    const { limit = 50, before } = req.query;

    let sql = `
      SELECT m.*, m.message_id as id, u.name as sender_name, u.role as sender_role,
             p.hash, p.prev_hash, p.chain_height, p.ipfs_cid, p.ipfs_url,
             p.solana_tx, p.solana_confirmed,
             f.risk_level, f.reason as fraud_reason, f.token_penalty
      FROM messages m
      JOIN users u ON m.sender_id = u.user_id
      LEFT JOIN proof_chain p ON p.message_id = m.message_id
      LEFT JOIN fraud_logs f ON f.message_id = m.message_id
      WHERE m.channel_id = $1 AND m.is_deleted = 0
    `;
    const params = [req.params.channelId];
    let paramIdx = 2;

    if (before) {
      sql += ` AND m.created_at < $${paramIdx}`;
      params.push(before);
      paramIdx++;
    }
    sql += ` ORDER BY m.created_at DESC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const resMsgs = await query(sql, params);
    const messages = resMsgs.rows.reverse();
    res.json({ messages });
  } catch (err) {
    console.error('Fetch messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── POST /api/messages/:channelId ─────────────────────────────
router.post('/:channelId', requireAuth, upload.array('files', 5), async (req, res) => {
  const senderId = req.user.id;
  const channelId = req.params.channelId;
  const { content } = req.body;
  const files = req.files || [];

  if (!content && !files.length)
    return res.status(400).json({ error: 'Message content or file required' });

  try {
    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [senderId]);
    const user = resUser.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.token_balance < 5)
      return res.status(402).json({ error: 'Insufficient tokens', balance: user.token_balance });

    const messageId = uuidv4();
    const msgType = files.length && !content ? 'file' : 'text';

    await query(`
      INSERT INTO messages (message_id, channel_id, sender_id, content, message_type)
      VALUES ($1, $2, $3, $4, $5)
    `, [messageId, channelId, senderId, content || null, msgType]);

    const newBalance1 = user.token_balance - 5;
    await query('UPDATE users SET token_balance = $1 WHERE user_id = $2', [newBalance1, senderId]);
    await query(`
      INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason, message_id)
      VALUES ($1, $2, -5, $3, 'spend', 'Message sent', $4)
    `, [uuidv4(), senderId, newBalance1, messageId]);

    const fraudResult = await detectFraud(content || '[file attachment]');
    const penalty = getPenalty(fraudResult.risk);
    const isQuarantined = fraudResult.risk === 'HIGH' ? 1 : 0;

    await query(`
      INSERT INTO fraud_logs (fraud_log_id, message_id, sender_id, risk_level, reason, indicators, model_used, token_penalty)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      uuidv4(), messageId, senderId, fraudResult.risk,
      fraudResult.reason, JSON.stringify(fraudResult.indicators),
      fraudResult.model || 'simulation', penalty
    ]);

    let finalBalance = newBalance1;
    if (penalty > 0) {
      finalBalance = Math.max(0, newBalance1 - penalty);
      await query('UPDATE users SET token_balance = $1 WHERE user_id = $2', [finalBalance, senderId]);
      await query(`
        INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason, message_id)
        VALUES ($1, $2, $3, $4, 'penalty', $5, $6)
      `, [
        uuidv4(), senderId, -penalty, finalBalance,
        `Fraud penalty — ${fraudResult.risk} risk`, messageId
      ]);
    }

    if (isQuarantined) {
      await query('UPDATE messages SET is_quarantined = 1 WHERE message_id = $1', [messageId]);
    }

    if (finalBalance <= 0) {
      await query('UPDATE users SET is_frozen = 1 WHERE user_id = $1', [senderId]);
    }

    const proof = await createProof(messageId, senderId, content || '', channelId);

    const savedFiles = [];
    for (const f of files) {
      const fileId = uuidv4();
      await query(`
        INSERT INTO files (file_id, message_id, uploader_id, filename, mimetype, size_bytes, local_path)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [fileId, messageId, senderId, f.originalname, f.mimetype, f.size, f.path]);
      savedFiles.push({ id: fileId, filename: f.originalname, size: f.size, mimetype: f.mimetype });
    }

    const resFraud = await query('SELECT *, fraud_log_id as id FROM fraud_logs WHERE message_id = $1', [messageId]);
    const fraudLog = resFraud.rows[0];

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

    setImmediate(async () => {
      try {
        const senderFullRes = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [senderId]);
        const messageFullRes = await query('SELECT *, message_id as id FROM messages WHERE message_id = $1', [messageId]);
        const senderFull = senderFullRes.rows[0];
        const messageFull = messageFullRes.rows[0];

        const proofDoc = buildProofDocument(proof, messageFull, senderFull, fraudLog);
        const ipfsResult = await pinJSON(proofDoc, `finchat-proof-${proof.chain_height}`);
        if (ipfsResult.cid) {
          await updateProofIPFS(proof.id, ipfsResult.cid, ipfsResult.url);
        }

        for (const f of files) {
          const fileRecordRes = await query('SELECT *, file_id as id FROM files WHERE local_path = $1', [f.path]);
          const fileRecord = fileRecordRes.rows[0];
          if (fileRecord) {
            const fileIPFS = await pinFile(f.path, f.originalname);
            if (fileIPFS.cid) {
              await query('UPDATE files SET ipfs_cid = $1, ipfs_url = $2 WHERE file_id = $3', [fileIPFS.cid, fileIPFS.url, fileRecord.id]);
            }
          }
        }

        const { isCheckpoint } = require('../services/proof');
        if (isCheckpoint(proof.chain_height)) {
          const solanaResult = await anchorHash(proof.hash, proof.chain_height);
          if (solanaResult.tx) {
            await updateProofSolana(proof.id, solanaResult.tx, solanaResult.solana_slot || solanaResult.slot);
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

// ── GET /api/messages/proof/global ───────────────────────────
router.get('/proof/global', requireAuth, async (req, res) => {
  try {
    const resChain = await query(`
      SELECT p.*, p.proof_id as id, COALESCE(u.name, 'SYSTEM') as sender_name, COALESCE(u.role, 'system') as sender_role,
             f.risk_level, f.reason as fraud_reason,
             m.content, m.message_type, m.channel_id
      FROM proof_chain p
      LEFT JOIN messages m ON p.message_id = m.message_id
      LEFT JOIN users u ON p.sender_id = u.user_id
      LEFT JOIN fraud_logs f ON f.message_id = m.message_id
      ORDER BY p.chain_height DESC
      LIMIT 100
    `);

    const agg = await query(`
      SELECT COUNT(*)::int AS total_blocks,
             COUNT(*) FILTER (WHERE solana_confirmed = 1)::int AS anchored_blocks,
             COALESCE(MAX(chain_height), 0) AS max_height
      FROM proof_chain
    `);

    res.json({ chain: resChain.rows, stats: agg.rows[0] || { total_blocks: 0, anchored_blocks: 0, max_height: 0 } });
  } catch (err) {
    console.error('Fetch global proof chain error:', err);
    res.status(500).json({ error: 'Failed to fetch global proof chain' });
  }
});

// ── GET /api/messages/:channelId/proof ───────────────────────
router.get('/:channelId/proof', requireAuth, async (req, res) => {
  try {
    const resChain = await query(`
      SELECT p.*, p.proof_id as id, u.name as sender_name, u.role as sender_role,
             f.risk_level, f.reason as fraud_reason,
             m.content, m.message_type
      FROM proof_chain p
      JOIN messages m ON p.message_id = m.message_id
      JOIN users u ON p.sender_id = u.user_id
      LEFT JOIN fraud_logs f ON f.message_id = m.message_id
      WHERE m.channel_id = $1
      ORDER BY p.chain_height ASC
    `, [req.params.channelId]);

    const verification = await verifyChain(req.params.channelId);
    res.json({ chain: resChain.rows, verification });
  } catch (err) {
    console.error('Fetch chain proof error:', err);
    res.status(500).json({ error: 'Failed to fetch proof chain' });
  }
});

// ── GET /api/messages/:channelId/fraud ───────────────────────
router.get('/:channelId/fraud', requireAuth, requireRole(['admin', 'auditor']), async (req, res) => {
  try {
    const resLogs = await query(`
      SELECT f.*, f.fraud_log_id as id, u.name as sender_name, m.content
      FROM fraud_logs f
      JOIN users u ON f.sender_id = u.user_id
      JOIN messages m ON f.message_id = m.message_id
      WHERE m.channel_id = $1
      ORDER BY f.created_at DESC
    `, [req.params.channelId]);
    res.json({ logs: resLogs.rows });
  } catch (err) {
    console.error('Fetch fraud logs error:', err);
    res.status(500).json({ error: 'Failed to fetch fraud logs' });
  }
});

// ── GET /api/tokens/ledger ────────────────────────────────────
router.get('/tokens/ledger', requireAuth, async (req, res) => {
  try {
    const resUser = await query('SELECT user_id as id, name, token_balance, is_frozen FROM users WHERE user_id = $1', [req.user.id]);
    const resLedger = await query(`
      SELECT *, ledger_id as id FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
    `, [req.user.id]);
    const user = resUser.rows[0];
    res.json({ balance: user.token_balance, frozen: !!user?.is_frozen, ledger: resLedger.rows });
  } catch (err) {
    console.error('Fetch token ledger error:', err);
    res.status(500).json({ error: 'Failed to fetch token ledger' });
  }
});

module.exports = router;
