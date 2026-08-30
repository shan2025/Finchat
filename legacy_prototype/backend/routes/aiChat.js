// routes/aiChat.js — AI Persona Chat with hidden fraud detection
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { chatWithPersona, classifyFraudSeverity } = require('../services/aiChat');
const { listPersonas, getPersona } = require('../services/personas');
const { createProof, updateProofIPFS, updateProofSolana, isCheckpoint } = require('../services/proof');
const { anchorHash } = require('../services/solana');
const { pinJSON, buildProofDocument } = require('../services/ipfs');
const { createNotification } = require('../services/notifications');
const multer = require('multer');
const { extractFromUpload, persistUpload, buildAttachmentBlock } = require('../services/attachments');

const { cached } = require('../services/microCache');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 4 }
});

// The channel list is looked up on every chat message (twice, when fraud is
// detected) but effectively never changes. At ~108ms per Oregon→Tokyo round
// trip that was pure overhead on the hottest path in the app.
async function defaultChannelId(fallback) {
  const id = await cached('channels:first', 5 * 60_000, async () => {
    const res = await query('SELECT channel_id as id FROM channels LIMIT 1');
    return res.rows[0] ? res.rows[0].id : null;
  });
  return id || fallback;
}

// ── POST /api/ai-chat/upload ───────────────────────────────────
// Multipart upload for chat attachments. Extracts text from documents and
// describes images via a Groq vision model; returns the extracted context the
// client then passes to /send as `attachments`.
router.post('/upload', requireAuth, upload.array('files', 4), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded (field name: "files")' });
  }
  try {
    const attachments = [];
    for (const f of req.files) {
      persistUpload(f, req.user.id);
      const extracted = await extractFromUpload(f);
      // Keep the bytes of an IMAGE so the conversation can show it again after
      // a reload. Documents are already reduced to text above, so storing them
      // twice would buy nothing. See migration 043 for why this is the DB and
      // not the uploads/ directory.
      const isImage = (f.mimetype || '').startsWith('image/');
      const stored = await query(`
        INSERT INTO chat_attachments (user_id, original_name, mime, size_bytes, kind, data)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING attachment_id
      `, [req.user.id, f.originalname, f.mimetype || 'application/octet-stream',
        f.size, extracted.kind, isImage ? f.buffer : null]);
      extracted.id = stored.rows[0].attachment_id;
      attachments.push(extracted);
    }
    res.json({ attachments });
  } catch (err) {
    console.error('Attachment upload error:', err);
    res.status(500).json({ error: 'Failed to process attachments', details: err.message });
  }
});

// ── GET /api/ai-chat/attachment/:id ────────────────────────────
// Serve one stored image back to the person who uploaded it.
//
// Deliberately NOT a static file URL: `requireAuth` + the user_id match is the
// whole point, so an attachment id leaking tells you nothing without that
// user's session. The client fetches this with its bearer token and renders the
// blob, rather than putting a token in an <img src> where it would land in logs
// and referrers.
router.get('/attachment/:id', requireAuth, async (req, res) => {
  try {
    const r = await query(`
      SELECT original_name, mime, data FROM chat_attachments
      WHERE attachment_id = $1 AND user_id = $2
    `, [req.params.id, req.user.id]);
    const row = r.rows[0];
    // Same answer for "does not exist" and "is not yours" — the id space should
    // not be probeable for what other people uploaded.
    if (!row || !row.data) return res.status(404).json({ error: 'Attachment not found' });

    res.set('Content-Type', row.mime || 'application/octet-stream');
    // Private: this is one user's file, and it never changes once written.
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Disposition',
      `inline; filename="${String(row.original_name || 'attachment').replace(/["\r\n]/g, '')}"`);
    res.send(row.data);
  } catch (err) {
    console.error('Attachment fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

// ── GET /api/ai-chat/personas ──────────────────────────────────
router.get('/personas', requireAuth, (req, res) => {
  res.json({ personas: listPersonas() });
});

// ── POST /api/ai-chat/send ─────────────────────────────────────
router.post('/send', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { persona: personaId, sessionId, web, study, attachments } = req.body;
  let { message } = req.body;

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!personaId) return res.status(400).json({ error: 'Persona ID required' });
  if (!message && !hasAttachments) return res.status(400).json({ error: 'Message required' });
  if (!message) message = 'Please review the attached file(s).';

  const persona = getPersona(personaId);
  if (!persona) return res.status(400).json({ error: `Unknown persona: ${personaId}` });

  const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [userId]);
  const user = resUser.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_frozen)
    return res.status(403).json({ error: 'Account frozen — token balance depleted' });
  if (user.token_balance < 5)
    return res.status(402).json({ error: 'Insufficient tokens', balance: user.token_balance });

  const activeSession = sessionId || uuidv4();

  // userMsgId/botMsgId/channelId are needed by the post-response anchoring and
  // IPFS pinning below, which runs outside this try block.
  let userProof, botProof, lastCleanResponse, userMsgId, botMsgId, channelId;
  try {
    const resHistory = await query(`
      SELECT role, content FROM ai_conversations
      WHERE session_id = $1 AND user_id = $2 AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
      LIMIT 20
    `, [activeSession, userId]);
    const history = resHistory.rows;

    // Attachments: agent sees the extracted content; the stored/displayed
    // message keeps just the file names (the full extract would bloat history).
    const goalForAgent = hasAttachments ? message + buildAttachmentBlock(attachments) : message;
    const storedMessage = hasAttachments
      ? `${message}\n\n📎 Attached: ${attachments.map(a => a.name).join(', ')}`
      : message;

    const result = await chatWithPersona(personaId, goalForAgent, history, {
      userId,
      sessionId: activeSession,
      webAccess: web !== false, // composer WEB toggle; default on for API callers that don't send it
      studyMode: study === true  // composer STUDY toggle; off unless explicitly asked for
    });
    lastCleanResponse = result.cleanResponse;

    channelId = await defaultChannelId('general');

    userMsgId = uuidv4();
    await query(`
      INSERT INTO messages (message_id, channel_id, sender_id, content, message_type)
      VALUES ($1, $2, $3, $4, 'text')
    `, [userMsgId, channelId, userId, storedMessage]);

    userProof = await createProof(userMsgId, userId, storedMessage, channelId);

    // Bind the uploads to the message that carried them, so reopening the
    // conversation can find and re-render them. Scoped by user_id: an id from
    // someone else's upload matches nothing and is silently ignored.
    if (hasAttachments) {
      const ids = attachments.map(a => a && a.id).filter(Boolean);
      if (ids.length) {
        await query(`
          UPDATE chat_attachments SET message_id = $1, session_id = $2
          WHERE attachment_id = ANY($3::uuid[]) AND user_id = $4
        `, [userMsgId, activeSession, ids, userId]);
      }
    }

    await query(`
      INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content, message_id)
      VALUES ($1, $2, $3, $4, 'user', $5, $6)
    `, [uuidv4(), activeSession, userId, personaId, storedMessage, userMsgId]);

    botMsgId = uuidv4();
    const botContent = `[${persona.name}] ${result.cleanResponse}`;
    await query(`
      INSERT INTO messages (message_id, channel_id, sender_id, content, message_type)
      VALUES ($1, $2, $3, $4, 'system')
    `, [botMsgId, channelId, personaId.toUpperCase(), botContent]);

    botProof = await createProof(botMsgId, personaId.toUpperCase(), botContent, channelId);

    await query(`
      INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content, message_id)
      VALUES ($1, $2, $3, $4, 'assistant', $5, $6)
    `, [uuidv4(), activeSession, userId, personaId, result.cleanResponse, botMsgId]);

    // Study Mode is a property of the conversation, not the browser — remember it
    // so reopening this session anywhere comes back in card format.
    await query(`
      INSERT INTO ai_session_meta (session_id, user_id, study_mode, deleted, updated_at)
      VALUES ($1, $2, $3, false, NOW())
      ON CONFLICT (session_id) DO UPDATE SET study_mode = $3, updated_at = NOW()
    `, [activeSession, userId, study === true]);

    let newBalance = user.token_balance - 5;
    await query('UPDATE users SET token_balance = $1 WHERE user_id = $2', [newBalance, userId]);
    await query(`
      INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
      VALUES ($1, $2, -5, $3, 'spend', $4)
    `, [uuidv4(), userId, newBalance, `AI chat with ${persona.name} (${persona.roleTitle || 'Specialist'})`]);

    let fraudAlert = null;

    if (result.fraudDetected) {
      console.log(`🚨 FRAUD DETECTED by ${persona.name} for user ${user.name} (${userId})`);

      const fraudMsgId = uuidv4();
      const fraudChannelId = await defaultChannelId('system');

      await query(`
        INSERT INTO messages (message_id, channel_id, sender_id, content, message_type, is_quarantined)
        VALUES ($1, $2, $3, $4, 'system', 1)
      `, [fraudMsgId, fraudChannelId, userId, `[AI CHAT FRAUD] ${message.substring(0, 200)}`]);

      const severity = classifyFraudSeverity(message);
      const isExtreme = severity === 'EXTREME';
      const penalty = isExtreme ? newBalance : 20;
      newBalance = Math.max(0, newBalance - penalty);
      await query('UPDATE users SET token_balance = $1 WHERE user_id = $2', [newBalance, userId]);
      await query(`
        INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
        VALUES ($1, $2, $3, $4, 'penalty', $5)
      `, [
        uuidv4(), userId, -penalty, newBalance,
        isExtreme
          ? 'EXTREME FRAUD — all tokens removed by AI persona'
          : 'Risky message detected — 20 token penalty by AI persona'
      ]);

      const accountFrozen = newBalance <= 0;
      if (accountFrozen) {
        await query('UPDATE users SET is_frozen = 1 WHERE user_id = $1', [userId]);
      }

      await query(`
        INSERT INTO fraud_logs (fraud_log_id, message_id, sender_id, risk_level, reason, indicators, model_used, token_penalty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        uuidv4(),
        fraudMsgId,
        userId,
        isExtreme ? 'HIGH' : 'HIGH',
        `${severity} fraud detected by AI persona ${persona.name}`,
        JSON.stringify(['AI persona detection', `Severity: ${severity}`, `Persona: ${personaId}`]),
        process.env.OLLAMA_MODEL || 'simulation',
        penalty
      ]);

      const fraudProofObj = await createProof(fraudMsgId, 'SYSTEM', `[FRAUD ALERT] ${severity}`, fraudChannelId);

      await createNotification({
        userId,
        type: 'fraud',
        title: `🚨 Fraud detected (${severity})`,
        content: accountFrozen
          ? `Extreme fraud flagged by ${persona.name}. All tokens removed and account frozen.`
          : `Risky activity flagged by ${persona.name}. ${penalty} tokens deducted.`
      });

      fraudAlert = {
        detected: true,
        severity,
        penalty,
        accountFrozen,
        message: isExtreme
          ? 'Extreme fraud detected. All tokens removed and account frozen.'
          : `Risky activity detected. ${penalty} tokens deducted. Remaining balance: ${newBalance}.`,
        proof: {
          hash: fraudProofObj.hash,
          prevHash: fraudProofObj.prev_hash,
          height: fraudProofObj.chain_height,
          timestamp: fraudProofObj.timestamp
        }
      };
    }

    res.json({
      sessionId: activeSession,
      persona: {
        id: personaId,
        name: persona.name,
        avatar: persona.avatar
      },
      response: result.cleanResponse,
      tokenBalance: newBalance,
      tokenCost: 5,
      // Model transparency: which backend answered. fallback=true means the
      // Groq cloud call failed and the local Ollama/qwen model stepped in.
      inference: {
        provider: result.provider || null,
        model: result.model || null,
        fallback: result.provider === 'ollama'
      },
      // Sprint X Stage 2 — explainability: what the AI recalled to answer
      memoryTrace: result.memoryTrace || null,
      // Claude-style citations: the web/data sources consulted for this answer
      sources: Array.isArray(result.sources) ? result.sources : [],
      fraud: fraudAlert,
      proof: {
        user: {
          hash: userProof.hash,
          prevHash: userProof.prev_hash,
          height: userProof.chain_height,
          contentHash: userProof.content_hash,
          timestamp: userProof.timestamp
        },
        bot: {
          hash: botProof.hash,
          prevHash: botProof.prev_hash,
          height: botProof.chain_height,
          contentHash: botProof.content_hash,
          timestamp: botProof.timestamp
        }
      }
    });

  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({
      error: 'Failed to process AI chat message',
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }

  // Cognitive Memory Engine: every exchange teaches the knowledge graph.
  // Runs after the response is sent; failures never touch the chat.
  setImmediate(async () => {
    try {
      const { ingestChat } = require('../services/cognitive/MemoryEngine');
      const report = await ingestChat({
        userId,
        sessionId: activeSession,
        agentId: personaId,
        userText: message,
        aiText: lastCleanResponse || '',
        sourceLabel: `Chat with ${persona.name}`
      });
      if (report.learned.length > 0) {
        console.log(`🧠 MemoryEngine: learned ${report.learned.length} node(s), ${report.linked.length} link(s) from session ${activeSession.slice(0, 8)}`);
      }
    } catch (memErr) {
      console.warn('⚠️ MemoryEngine ingest error:', memErr.message);
    }
  });

  setImmediate(async () => {
    if (!userProof || !botProof) return;

    // Pin the proof document to IPFS at the same checkpoints we anchor on-chain.
    // The Solana memo only carries a hash; without the document behind it there
    // is nothing for an auditor to verify that hash against. Pinning every
    // message would exhaust the free Pinata allowance for no extra assurance,
    // so the two run on the same cadence.
    const pinProof = async (proof, msgId, sender) => {
      const doc = buildProofDocument(
        proof,
        { id: msgId, message_type: 'ai_chat', channel_id: channelId },
        sender,
        null // fraud assessment belongs to the channel-message path, not AI chat
      );
      const pin = await pinJSON(doc, `finchat-proof-${proof.chain_height}`);
      if (pin.cid) await updateProofIPFS(proof.id, pin.cid, pin.url);
      return pin;
    };

    const anchor = async (proof) => {
      const result = await anchorHash(proof.hash, proof.chain_height);
      if (result.tx) {
        await updateProofSolana(proof.id, result.tx,
          result.solana_slot || result.slot, !result.simulated);
      }
      return result;
    };

    // IPFS and Solana are attempted independently: a Pinata outage must not
    // cost the on-chain anchor, and vice versa.
    const checkpoints = [
      { proof: userProof, msgId: userMsgId, sender: { id: user.id, name: user.name, role: user.role, wallet_address: user.wallet_address || null } },
      { proof: botProof, msgId: botMsgId, sender: { id: personaId.toUpperCase(), name: persona.name, role: 'agent', wallet_address: null } }
    ];

    for (const { proof, msgId, sender } of checkpoints) {
      if (!isCheckpoint(proof.chain_height)) continue;
      try { await pinProof(proof, msgId, sender); }
      catch (e) { console.error(`IPFS pin failed for proof #${proof.chain_height}:`, e.message); }
      try { await anchor(proof); }
      catch (e) { console.error(`Solana anchor failed for proof #${proof.chain_height}:`, e.message); }
    }
  });
});

// ── GET /api/ai-chat/history/:sessionId ────────────────────────
router.get('/history/:sessionId', requireAuth, async (req, res) => {
  try {
    const resMsgs = await query(`
      SELECT a.conversation_id as id, a.role, a.content, a.persona, a.created_at, p.hash
      FROM ai_conversations a
      LEFT JOIN proof_chain p ON a.message_id = p.message_id
      WHERE a.session_id = $1 AND a.user_id = $2 AND a.role IN ('user', 'assistant')
      ORDER BY a.created_at ASC
    `, [req.params.sessionId, req.user.id]);
    const messages = resMsgs.rows;

    // Re-attach the images a message was sent with. One query for the whole
    // session rather than one per message — this route already runs on every
    // conversation open. Bytes are NOT sent here; the client asks for each one
    // it decides to display.
    if (messages.length) {
      const resAtt = await query(`
        SELECT attachment_id AS id, message_id, original_name AS name, mime, size_bytes AS size, kind
        FROM chat_attachments
        WHERE session_id = $1 AND user_id = $2 AND data IS NOT NULL
        ORDER BY created_at ASC
      `, [req.params.sessionId, req.user.id]);
      const byMessage = new Map();
      for (const a of resAtt.rows) {
        const { message_id: mid, ...rest } = a;
        if (!byMessage.has(mid)) byMessage.set(mid, []);
        byMessage.get(mid).push(rest);
      }
      // ai_conversations rows carry message_id; the SELECT above aliases the
      // conversation id, so pull the join key explicitly.
      const resIds = await query(`
        SELECT conversation_id, message_id FROM ai_conversations
        WHERE session_id = $1 AND user_id = $2
      `, [req.params.sessionId, req.user.id]);
      const msgIdByConv = new Map(resIds.rows.map(r => [r.conversation_id, r.message_id]));
      for (const m of messages) {
        const att = byMessage.get(msgIdByConv.get(m.id));
        if (att && att.length) m.attachments = att;
      }
    }

    const persona = messages.length > 0 ? getPersona(messages[0].persona) : null;

    const resMeta = await query(
      'SELECT study_mode FROM ai_session_meta WHERE session_id = $1 AND user_id = $2',
      [req.params.sessionId, req.user.id]);

    res.json({
      sessionId: req.params.sessionId,
      persona: persona ? { id: messages[0].persona, name: persona.name, avatar: persona.avatar } : null,
      // Sprint Z: restores the composer STUDY toggle when a study chat is reopened
      studyMode: resMeta.rows[0] ? resMeta.rows[0].study_mode === true : false,
      messages
    });
  } catch (err) {
    console.error('Fetch chat history error:', err);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// ── GET /api/ai-chat/sessions ──────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const resSessions = await query(`
      SELECT s.session_id, s.persona, s.started_at, s.last_message_at, s.message_count,
             COALESCE(m.title, t.title) AS title, (m.title IS NOT NULL) AS renamed
      FROM (
        SELECT session_id, persona,
               MIN(created_at) as started_at,
               MAX(created_at) as last_message_at,
               COUNT(*) as message_count
        FROM ai_conversations
        WHERE user_id = $1
        GROUP BY session_id, persona
      ) s
      LEFT JOIN ai_session_meta m
        ON m.session_id = s.session_id AND m.user_id = $1 AND m.deleted = false
      LEFT JOIN LATERAL (
        SELECT content AS title FROM ai_conversations
        WHERE session_id = s.session_id AND user_id = $1 AND role = 'user'
        ORDER BY created_at ASC LIMIT 1
      ) t ON true
      WHERE NOT EXISTS (
        SELECT 1 FROM ai_session_meta d
        WHERE d.session_id = s.session_id AND d.user_id = $1 AND d.deleted = true
      )
      ORDER BY s.last_message_at DESC
      LIMIT 20
    `, [req.user.id]);
    const sessions = resSessions.rows;

    // Briefings have no user message to take a title from, so without this they
    // all read "New conversation". New ones are titled at generation time; this
    // covers the ones already in the database, and keeps a briefing named after
    // the briefing even when the user has since replied inside it.
    const { briefingSessionTitle } = require('../services/briefing');
    const briefingTitle = (sessionId) => {
      const stamp = Number(String(sessionId).split('_')[1]);
      return briefingSessionTitle(Number.isFinite(stamp) ? new Date(stamp) : new Date());
    };

    const enriched = sessions.map(s => {
      const p = getPersona(s.persona);
      const rawTitle = (s.title || '').replace(/\s+/g, ' ').trim();
      const fallback = String(s.session_id).startsWith('briefing_')
        ? briefingTitle(s.session_id)
        : 'New conversation';
      const useFallback = !rawTitle || (!s.renamed && fallback !== 'New conversation');
      return {
        ...s,
        title: useFallback ? fallback
          : (rawTitle.length > 60 ? rawTitle.slice(0, 57) + '…' : rawTitle),
        personaName: p?.name || s.persona,
        personaAvatar: p?.avatar || '🤖'
      };
    });

    res.json({ sessions: enriched });
  } catch (err) {
    console.error('Fetch sessions error:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ── PATCH /api/ai-chat/sessions/:sessionId ── rename a conversation ──
router.patch('/sessions/:sessionId', requireAuth, async (req, res) => {
  const title = String(req.body.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    // Only rename sessions the user actually owns
    const owns = await query(
      'SELECT 1 FROM ai_conversations WHERE session_id = $1 AND user_id = $2 LIMIT 1',
      [req.params.sessionId, req.user.id]);
    if (!owns.rows.length) return res.status(404).json({ error: 'Session not found' });
    await query(`
      INSERT INTO ai_session_meta (session_id, user_id, title, deleted, updated_at)
      VALUES ($1, $2, $3, false, NOW())
      ON CONFLICT (session_id) DO UPDATE SET title = $3, deleted = false, updated_at = NOW()
    `, [req.params.sessionId, req.user.id, title]);
    res.json({ status: 'ok', sessionId: req.params.sessionId, title });
  } catch (err) {
    console.error('Rename session error:', err);
    res.status(500).json({ error: 'Failed to rename session' });
  }
});

// ── DELETE /api/ai-chat/sessions/:sessionId ── delete a conversation ──
// Removes the conversation turns; messages/proof_chain rows stay untouched so
// the tamper-evident chain keeps its integrity.
router.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const del = await query(
      'DELETE FROM ai_conversations WHERE session_id = $1 AND user_id = $2',
      [req.params.sessionId, req.user.id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Session not found' });
    await query(`
      INSERT INTO ai_session_meta (session_id, user_id, deleted, updated_at)
      VALUES ($1, $2, true, NOW())
      ON CONFLICT (session_id) DO UPDATE SET deleted = true, updated_at = NOW()
    `, [req.params.sessionId, req.user.id]);
    res.json({ status: 'ok', deleted: del.rowCount });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// ── POST /api/ai-chat/schedule-briefing ────────────────────────
// Run a morning executive briefing now.
//
// The `instant` flag used to choose between running one immediately and
// registering a BullMQ repeatable job. Recurrence is no longer the app's to
// own: the external cron service calls /api/cron/briefing on whatever schedule
// it is configured with, which is the only schedule that survives this host
// spinning down when idle. So this endpoint runs one briefing, and says so.
router.post('/schedule-briefing', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const { runMorningBriefing } = require('../services/briefing');

    // Fire and forget: a briefing takes minutes, and the dashboard button
    // should not sit on an open connection waiting for it.
    // force: a person just pressed the button, so the once-a-day floor that
    // protects the scheduled path from a misconfigured cron should not silently
    // turn their click into a no-op.
    runMorningBriefing({ userId, requestedAt: new Date().toISOString(), force: true })
      .catch(err => console.error(`❌ Briefing for ${userId} failed: ${err.message}`));

    res.status(202).json({
      status: 'briefing_started',
      userId,
      recurring: false,
      message: '🌅 Morning briefing started — it will appear in your chat and notifications when the team finishes.',
      note: 'Recurring briefings are scheduled by the external cron service against /api/cron/briefing.'
    });
  } catch (err) {
    console.error('Briefing error:', err);
    res.status(500).json({ error: 'Failed to start briefing', details: err.message });
  }
});

// ── POST /api/ai-chat/graphify ──────────────────────────────────
// Extract concept nodes and edges from conversation and add to Neural Map
router.post('/graphify', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { sessionId, topic = '' } = req.body;

  try {
    // 1. Fetch recent messages
    const resMsgs = await query(`
      SELECT role, content FROM ai_conversations
      WHERE session_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT 15
    `, [sessionId || '', userId]);
    const history = resMsgs.rows.reverse();

    // 2. Extract entities using heuristics / conversation analysis
    const fullText = history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n') + `\nTopic: ${topic}`;
    
    // Find or create map for user (prefer map_ebce3675-c50b-448c-8a1f-37d3e2243467 or first user map)
    const mapRes = await query(`SELECT map_id, name FROM neural_maps WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`, [userId]);
    const mapId = mapRes.rows[0] ? mapRes.rows[0].map_id : 'map_ebce3675-c50b-448c-8a1f-37d3e2243467';

    // Generate concept nodes based on conversation keywords and topic
    const keywords = [];
    if (topic) keywords.push(topic);
    const commonPatterns = [
      /stock market/i, /cryptocurrency/i, /solana/i, /ethereum/i, /bitcoin/i, /data visualization/i,
      /fraud detection/i, /tokenomics/i, /zero-knowledge/i, /blockchain/i, /audit log/i, /neural map/i,
      /plato/i, /aurelius/i, /rasha/i, /nova/i, /governance/i, /vault policy/i, /smart contract/i
    ];
    for (const rx of commonPatterns) {
      const match = fullText.match(rx);
      if (match && !keywords.includes(match[0])) {
        keywords.push(match[0].charAt(0).toUpperCase() + match[0].slice(1).toLowerCase());
      }
    }
    if (keywords.length === 0) {
      keywords.push('Financial Synthesis', 'Multi-Agent Network', 'Cognitive Core');
    }

    const nodesAdded = [];
    const edgesAdded = [];

    // Build the whole node/edge set first, then write it in three statements.
    // This used to issue three queries per keyword inside the loop — at ~126ms
    // per database round trip, eight keywords cost roughly three seconds of
    // pure waiting.
    //
    // Keys are de-duplicated before the insert: two keywords can normalise to
    // the same node_key ("Risk Model" / "risk model"), and Postgres rejects an
    // ON CONFLICT DO UPDATE that would touch the same row twice in one
    // statement.
    const note = `Extracted via /graphify from conversation context (${topic || 'general session'}).`;
    const conceptKey = (kw) => `concept:${kw.toLowerCase().replace(/\s+/g, '_')}`;
    const rootKey = conceptKey(keywords[0]);

    const nodeByKey = new Map();
    const edgeByKey = new Map();

    keywords.forEach((kw, i) => {
      const nodeKey = conceptKey(kw);
      if (!nodeByKey.has(nodeKey)) nodeByKey.set(nodeKey, { key: nodeKey, label: kw });

      const fromKey = i === 0 ? 'agent:plato' : rootKey;
      if (fromKey === nodeKey) return;
      const edgeKey = `${fromKey}~${nodeKey}`;
      if (!edgeByKey.has(edgeKey)) {
        edgeByKey.set(edgeKey, {
          key: edgeKey, from: fromKey, to: nodeKey,
          note: `Synthesized relationship for ${kw}`
        });
      }
    });

    const nodes = [...nodeByKey.values()];
    const edges = [...edgeByKey.values()];

    if (nodes.length) {
      await query(`
        INSERT INTO neural_map_nodes (node_key, user_id, map_id, label, node_type, note, meta, apis)
        SELECT n.node_key, $2, $3, n.label, 'idea', $4, $5::jsonb, $6::jsonb
        FROM UNNEST($1::text[], $7::text[]) AS n(node_key, label)
        ON CONFLICT (node_key) DO UPDATE SET
          label = EXCLUDED.label,
          note = EXCLUDED.note
      `, [
        nodes.map(n => n.key), userId, mapId, note,
        JSON.stringify([['Source', '/graphify'], ['Confidence', '98%']]),
        JSON.stringify([]),
        nodes.map(n => n.label)
      ]);
      nodesAdded.push(...nodes.map(n => ({ key: n.key, label: n.label })));
    }

    if (edges.length) {
      await query(`
        INSERT INTO neural_map_edges (edge_key, user_id, map_id, from_key, to_key)
        SELECT e.edge_key, $2, $3, e.from_key, e.to_key
        FROM UNNEST($1::text[], $4::text[], $5::text[]) AS e(edge_key, from_key, to_key)
        ON CONFLICT (edge_key) DO NOTHING
      `, [edges.map(e => e.key), userId, mapId, edges.map(e => e.from), edges.map(e => e.to)]);

      await query(`
        INSERT INTO neural_map_edge_meta (user_id, map_id, edge_key, note, flow, updated_at)
        SELECT $1, $2, m.edge_key, m.note, $5, NOW()
        FROM UNNEST($3::text[], $4::text[]) AS m(edge_key, note)
        ON CONFLICT (user_id, map_id, edge_key) DO UPDATE SET
          note = EXCLUDED.note, flow = EXCLUDED.flow, updated_at = NOW()
      `, [userId, mapId, edges.map(e => e.key), edges.map(e => e.note), 'neural link']);

      edgesAdded.push(...edges.map(e => ({ from: e.from, to: e.to })));
    }

    res.json({
      ok: true,
      mapId,
      nodesAdded,
      edgesAdded,
      summary: `Extracted ${nodesAdded.length} concepts and ${edgesAdded.length} links into your Master Plan Neural Map.`
    });
  } catch (err) {
    console.error('Graphify error:', err);
    res.status(500).json({ error: 'Failed to extract graph concepts', details: err.message });
  }
});

module.exports = router;

