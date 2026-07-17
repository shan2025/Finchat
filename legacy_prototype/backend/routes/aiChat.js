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

// ── GET /api/ai-chat/personas ──────────────────────────────────
router.get('/personas', requireAuth, (req, res) => {
  res.json({ personas: listPersonas() });
});

// ── POST /api/ai-chat/send ─────────────────────────────────────
router.post('/send', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { persona: personaId, message, sessionId } = req.body;

  if (!personaId) return res.status(400).json({ error: 'Persona ID required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

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

  let userProof, botProof;
  try {
    const resHistory = await query(`
      SELECT role, content FROM ai_conversations
      WHERE session_id = $1 AND user_id = $2 AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
      LIMIT 20
    `, [activeSession, userId]);
    const history = resHistory.rows;

    const result = await chatWithPersona(personaId, message, history, {
      userId,
      sessionId: activeSession
    });

    const resChan = await query("SELECT channel_id as id FROM channels LIMIT 1");
    const channelId = resChan.rows[0] ? resChan.rows[0].id : 'general';

    const userMsgId = uuidv4();
    await query(`
      INSERT INTO messages (message_id, channel_id, sender_id, content, message_type)
      VALUES ($1, $2, $3, $4, 'text')
    `, [userMsgId, channelId, userId, message]);

    userProof = await createProof(userMsgId, userId, message, channelId);

    await query(`
      INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content, message_id)
      VALUES ($1, $2, $3, $4, 'user', $5, $6)
    `, [uuidv4(), activeSession, userId, personaId, message, userMsgId]);

    const botMsgId = uuidv4();
    const botContent = `[${persona.name}] ${result.cleanResponse}`;
    await query(`
      INSERT INTO messages (message_id, channel_id, sender_id, content, message_type)
      VALUES ($1, $2, $3, $4, 'system')
    `, [botMsgId, channelId, userId, botContent]);

    botProof = await createProof(botMsgId, userId, botContent, channelId);

    await query(`
      INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content, message_id)
      VALUES ($1, $2, $3, $4, 'assistant', $5, $6)
    `, [uuidv4(), activeSession, userId, personaId, result.cleanResponse, botMsgId]);

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

    res.json({
      sessionId: req.params.sessionId,
      persona: persona ? { id: messages[0].persona, name: persona.name, avatar: persona.avatar } : null,
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
      SELECT session_id, persona,
             MIN(created_at) as started_at,
             MAX(created_at) as last_message_at,
             COUNT(*) as message_count
      FROM ai_conversations
      WHERE user_id = $1
      GROUP BY session_id, persona
      ORDER BY last_message_at DESC
      LIMIT 20
    `, [req.user.id]);
    const sessions = resSessions.rows;

    const enriched = sessions.map(s => {
      const p = getPersona(s.persona);
      return {
        ...s,
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

module.exports = router;

