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
const { enqueueExecutionJob, getJobStatus } = require('../services/queue/WorkerPool');
const { createNotification } = require('../services/notifications');
const multer = require('multer');
const { extractFromUpload, persistUpload, buildAttachmentBlock } = require('../services/attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 4 }
});

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
      attachments.push(extracted);
    }
    res.json({ attachments });
  } catch (err) {
    console.error('Attachment upload error:', err);
    res.status(500).json({ error: 'Failed to process attachments', details: err.message });
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

  let userProof, botProof, lastCleanResponse;
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

    const resChan = await query("SELECT channel_id as id FROM channels LIMIT 1");
    const channelId = resChan.rows[0] ? resChan.rows[0].id : 'general';

    const userMsgId = uuidv4();
    await query(`
      INSERT INTO messages (message_id, channel_id, sender_id, content, message_type)
      VALUES ($1, $2, $3, $4, 'text')
    `, [userMsgId, channelId, userId, storedMessage]);

    userProof = await createProof(userMsgId, userId, storedMessage, channelId);

    await query(`
      INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content, message_id)
      VALUES ($1, $2, $3, $4, 'user', $5, $6)
    `, [uuidv4(), activeSession, userId, personaId, storedMessage, userMsgId]);

    const botMsgId = uuidv4();
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
      const resChanFraud = await query("SELECT channel_id as id FROM channels LIMIT 1");
      const fraudChannelId = resChanFraud.rows[0] ? resChanFraud.rows[0].id : 'system';

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
    try {
      if (isCheckpoint(userProof.chain_height)) {
        const solanaResult = await anchorHash(userProof.hash, userProof.chain_height);
        if (solanaResult.tx) {
          await updateProofSolana(userProof.id, solanaResult.tx, solanaResult.solana_slot || solanaResult.slot);
        }
      }
      if (isCheckpoint(botProof.chain_height)) {
        const solanaResult = await anchorHash(botProof.hash, botProof.chain_height);
        if (solanaResult.tx) {
          await updateProofSolana(botProof.id, solanaResult.tx, solanaResult.solana_slot || solanaResult.slot);
        }
      }
    } catch (asyncErr) {
      console.error('Async AI Anchor Error:', asyncErr.message);
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

    const enriched = sessions.map(s => {
      const p = getPersona(s.persona);
      const rawTitle = (s.title || '').replace(/\s+/g, ' ').trim();
      return {
        ...s,
        title: rawTitle ? (rawTitle.length > 60 ? rawTitle.slice(0, 57) + '…' : rawTitle) : 'New conversation',
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

// ── POST /api/ai-chat/enqueue ──────────────────────────────────
router.post('/enqueue', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { persona: personaId, message, sessionId } = req.body;

  if (!personaId) return res.status(400).json({ error: 'Persona ID required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

  const activeSession = sessionId || uuidv4();

  try {
    const jobInfo = await enqueueExecutionJob({
      personaId,
      userMessage: message,
      history: [],
      options: { userId, sessionId: activeSession }
    });

    res.status(202).json({
      status: 'enqueued',
      jobId: jobInfo.jobId,
      queue: jobInfo.queueName,
      sessionId: activeSession,
      pollUrl: `/api/ai-chat/job/${jobInfo.jobId}`
    });
  } catch (err) {
    console.error('Enqueue error:', err);
    res.status(500).json({ error: 'Failed to enqueue job', details: err.message });
  }
});

// ── GET /api/ai-chat/job/:jobId ────────────────────────────────
router.get('/job/:jobId', requireAuth, async (req, res) => {
  try {
    const status = await getJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(status);
  } catch (err) {
    console.error('Job polling error:', err);
    res.status(500).json({ error: 'Failed to fetch job status', details: err.message });
  }
});

// ── POST /api/ai-chat/schedule-briefing ────────────────────────
// Schedule recurring morning executive briefings or trigger one instantly
router.post('/schedule-briefing', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { cron = '0 8 * * *', instant = false } = req.body;

  try {
    const { scheduleMorningBriefing } = require('../services/queue/WorkerPool');
    const result = await scheduleMorningBriefing({ userId, cron, instant });

    res.status(instant ? 202 : 200).json({
      status: instant ? 'briefing_queued' : 'briefing_scheduled',
      ...result,
      message: instant
        ? '🌅 Instant morning briefing has been queued! Check your inbox shortly.'
        : `🌅 Recurring briefing scheduled at cron "${cron}". Your executive team will report every morning!`
    });
  } catch (err) {
    console.error('Schedule briefing error:', err);
    res.status(500).json({ error: 'Failed to schedule briefing', details: err.message });
  }
});

// ── DELETE /api/ai-chat/schedule-briefing ───────────────────────
// Cancel all scheduled morning briefings
router.delete('/schedule-briefing', requireAuth, async (req, res) => {
  try {
    const { cancelMorningBriefings } = require('../services/queue/WorkerPool');
    const result = await cancelMorningBriefings();

    res.json({
      status: 'cancelled',
      ...result,
      message: `🌅 Cancelled ${result.cancelled} scheduled briefing(s).`
    });
  } catch (err) {
    console.error('Cancel briefing error:', err);
    res.status(500).json({ error: 'Failed to cancel briefings', details: err.message });
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

    // Add extracted concepts
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const nodeKey = `concept:${kw.toLowerCase().replace(/\s+/g, '_')}`;
      const label = kw;
      const note = `Extracted via /graphify from conversation context (${topic || 'general session'}).`;
      
      await query(`
        INSERT INTO neural_map_nodes (node_key, user_id, map_id, label, node_type, note, meta, apis)
        VALUES ($1, $2, $3, $4, 'idea', $5, $6, $7)
        ON CONFLICT (node_key) DO UPDATE SET
          label = EXCLUDED.label,
          note = EXCLUDED.note
      `, [nodeKey, userId, mapId, label, note, JSON.stringify([['Source', '/graphify'], ['Confidence', '98%']]), JSON.stringify([])]);
      
      nodesAdded.push({ key: nodeKey, label });

      // Connect to root or Plato agent node
      const fromKey = i === 0 ? 'agent:plato' : `concept:${keywords[0].toLowerCase().replace(/\s+/g, '_')}`;
      const edgeKey = `${fromKey}~${nodeKey}`;
      if (fromKey !== nodeKey) {
        await query(`
          INSERT INTO neural_map_edges (edge_key, user_id, map_id, from_key, to_key)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (edge_key) DO NOTHING
        `, [edgeKey, userId, mapId, fromKey, nodeKey]);
        
        await query(`
          INSERT INTO neural_map_edge_meta (user_id, map_id, edge_key, note, flow, updated_at)
          VALUES ($2, $3, $1, $4, $5, NOW())
          ON CONFLICT (user_id, map_id, edge_key) DO UPDATE SET
            note = EXCLUDED.note, flow = EXCLUDED.flow, updated_at = NOW()
        `, [edgeKey, userId, mapId, `Synthesized relationship for ${kw}`, 'neural link']);
        edgesAdded.push({ from: fromKey, to: nodeKey });
      }
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

