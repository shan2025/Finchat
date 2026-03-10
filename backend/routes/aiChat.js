// routes/aiChat.js — AI Persona Chat with hidden fraud detection
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { chatWithPersona, classifyFraudSeverity } = require('../services/aiChat');
const { listPersonas, getPersona } = require('../services/personas');
const { createProof, updateProofIPFS, updateProofSolana, isCheckpoint } = require('../services/proof');
const { anchorHash } = require('../services/solana');
const { pinJSON, buildProofDocument } = require('../services/ipfs');

// ── GET /api/ai-chat/personas ──────────────────────────────────
// List available AI personas
router.get('/personas', requireAuth, (req, res) => {
    res.json({ personas: listPersonas() });
});

// ── POST /api/ai-chat/send ─────────────────────────────────────
// Send a message to an AI persona
router.post('/send', requireAuth, async (req, res) => {
    const db = getDB();
    const userId = req.user.id;
    const { persona: personaId, message, sessionId } = req.body;

    if (!personaId) return res.status(400).json({ error: 'Persona ID required' });
    if (!message) return res.status(400).json({ error: 'Message required' });

    const persona = getPersona(personaId);
    if (!persona) return res.status(400).json({ error: `Unknown persona: ${personaId}` });

    // Check user status
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_frozen)
        return res.status(403).json({ error: 'Account frozen — token balance depleted' });
    if (user.token_balance < 5)
        return res.status(402).json({ error: 'Insufficient tokens', balance: user.token_balance });

    // Use existing session or create new one
    const activeSession = sessionId || uuidv4();

    let userProof, botProof;
    try {
        // ── 1. Load conversation history for this session ──────────
        const history = db.prepare(`
      SELECT role, content FROM ai_conversations
      WHERE session_id = ? AND user_id = ? AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
      LIMIT 20
    `).all(activeSession, userId);

        // ── 2. Send to Qwen with persona ───────────────────────────
        const result = await chatWithPersona(personaId, message, history);

        // ── 3. Save user message + proof chain ─────────────────────
        const generalChannel = db.prepare("SELECT id FROM channels LIMIT 1").get();
        const channelId = generalChannel ? generalChannel.id : 'general';

        const userMsgId = uuidv4();
        db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, content, message_type)
      VALUES (?, ?, ?, ?, 'text')
    `).run(userMsgId, channelId, userId, message);

        userProof = createProof(userMsgId, userId, message, channelId);

        // Also save to ai_conversations for session history
        db.prepare(`
      INSERT INTO ai_conversations (id, session_id, user_id, persona, role, content, message_id)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(uuidv4(), activeSession, userId, personaId, message, userMsgId);

        // ── 4. Save AI response + proof chain ───────────────────────
        // Note: sender_id must be a valid users.id (FK constraint).
        // We use userId here; persona name is embedded in the content.
        const botMsgId = uuidv4();
        const botContent = `[${persona.name}] ${result.cleanResponse}`;
        db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, content, message_type)
      VALUES (?, ?, ?, ?, 'system')
    `).run(botMsgId, channelId, userId, botContent);

        botProof = createProof(botMsgId, userId, botContent, channelId);

        db.prepare(`
      INSERT INTO ai_conversations (id, session_id, user_id, persona, role, content, message_id)
      VALUES (?, ?, ?, ?, 'assistant', ?, ?)
    `).run(uuidv4(), activeSession, userId, personaId, result.cleanResponse, botMsgId);

        // ── 5. Deduct base token cost ──────────────────────────────
        let newBalance = user.token_balance - 5;
        db.prepare('UPDATE users SET token_balance = ? WHERE id = ?').run(newBalance, userId);
        db.prepare(`
      INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
      VALUES (?, ?, -5, ?, 'spend', 'AI persona chat message')
    `).run(uuidv4(), userId, newBalance);

        // ── 6. Handle fraud detection ──────────────────────────────
        let fraudAlert = null;

        if (result.fraudDetected) {
            console.log(`🚨 FRAUD DETECTED by ${persona.name} for user ${user.name} (${userId})`);
            console.log(`   Message: "${message.substring(0, 80)}..."`);

            // Create a placeholder message record for FK constraint
            const fraudMsgId = uuidv4();
            const generalChannel = db.prepare("SELECT id FROM channels LIMIT 1").get();
            const channelId = generalChannel ? generalChannel.id : 'system';

            // Insert a system message to satisfy the FK on fraud_logs
            db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, content, message_type, is_quarantined)
        VALUES (?, ?, ?, ?, 'system', 1)
      `).run(fraudMsgId, channelId, userId, `[AI CHAT FRAUD] ${message.substring(0, 200)}`);

            // Classify severity: EXTREME = all tokens, HIGH = 20 tokens
            const severity = classifyFraudSeverity(message);
            const isExtreme = severity === 'EXTREME';
            const penalty = isExtreme ? newBalance : 20;
            newBalance = Math.max(0, newBalance - penalty);
            db.prepare('UPDATE users SET token_balance = ? WHERE id = ?').run(newBalance, userId);
            db.prepare(`
        INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
        VALUES (?, ?, ?, ?, 'penalty', ?)
      `).run(uuidv4(), userId, -penalty, newBalance,
                isExtreme
                    ? 'EXTREME FRAUD — all tokens removed by AI persona'
                    : 'Risky message detected — 20 token penalty by AI persona');

            // Only freeze if balance actually hits zero
            const accountFrozen = newBalance <= 0;
            if (accountFrozen) {
                db.prepare('UPDATE users SET is_frozen = 1 WHERE id = ?').run(userId);
            }

            // Log to fraud_logs
            db.prepare(`
        INSERT INTO fraud_logs (id, message_id, sender_id, risk_level, reason, indicators, model_used, token_penalty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
                uuidv4(),
                fraudMsgId,
                userId,
                isExtreme ? 'HIGH' : 'HIGH',  // DB constraint: LOW/MEDIUM/HIGH only
                `${severity} fraud detected by AI persona ${persona.name}`,
                JSON.stringify(['AI persona detection', `Severity: ${severity}`, `Persona: ${personaId}`]),
                process.env.OLLAMA_MODEL || 'simulation',
                penalty
            );

            fraudAlert = {
                detected: true,
                severity,
                penalty,
                accountFrozen,
                message: isExtreme
                    ? 'Extreme fraud detected. All tokens removed and account frozen.'
                    : `Risky activity detected. ${penalty} tokens deducted. Remaining balance: ${newBalance}.`
            };

            console.log(`   Severity: ${severity} | Penalty: -${penalty} tokens | Balance: ${newBalance} | Frozen: ${accountFrozen}`);
        }

        // ── 7. Build response ──────────────────────────────────────
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

    // ── 8. Async: IPFS + Solana (after response sent) ────────
    setImmediate(async () => {
        if (!userProof || !botProof) return;
        try {
            // Anchor User Message
            if (isCheckpoint(userProof.chain_height)) {
                const solanaResult = await anchorHash(userProof.hash, userProof.chain_height);
                if (solanaResult.tx) {
                    updateProofSolana(userProof.id, solanaResult.tx, solanaResult.solana_slot || solanaResult.slot);
                }
                console.log(`✅ Async User Checkpoint: #${userProof.chain_height} | Solana: ${solanaResult.tx || 'skipped'}`);
            }

            // Anchor Bot Message
            if (isCheckpoint(botProof.chain_height)) {
                const solanaResult = await anchorHash(botProof.hash, botProof.chain_height);
                if (solanaResult.tx) {
                    updateProofSolana(botProof.id, solanaResult.tx, solanaResult.solana_slot || solanaResult.slot);
                }
                console.log(`✅ Async Bot Checkpoint: #${botProof.chain_height} | Solana: ${solanaResult.tx || 'skipped'}`);
            }

        } catch (asyncErr) {
            console.error('Async AI Anchor Error:', asyncErr.message);
        }
    });
});

// ── GET /api/ai-chat/history/:sessionId ────────────────────────
// Get conversation history for a session
router.get('/history/:sessionId', requireAuth, (req, res) => {
    const db = getDB();
    const messages = db.prepare(`
    SELECT a.id, a.role, a.content, a.persona, a.created_at, p.hash
    FROM ai_conversations a
    LEFT JOIN proof_chain p ON a.message_id = p.message_id
    WHERE a.session_id = ? AND a.user_id = ? AND a.role IN ('user', 'assistant')
    ORDER BY a.created_at ASC
  `).all(req.params.sessionId, req.user.id);

    const persona = messages.length > 0 ? getPersona(messages[0].persona) : null;

    res.json({
        sessionId: req.params.sessionId,
        persona: persona ? { id: messages[0].persona, name: persona.name, avatar: persona.avatar } : null,
        messages
    });
});

// ── GET /api/ai-chat/sessions ──────────────────────────────────
// List all chat sessions for the current user
router.get('/sessions', requireAuth, (req, res) => {
    const db = getDB();
    const sessions = db.prepare(`
    SELECT session_id, persona,
           MIN(created_at) as started_at,
           MAX(created_at) as last_message_at,
           COUNT(*) as message_count
    FROM ai_conversations
    WHERE user_id = ?
    GROUP BY session_id
    ORDER BY last_message_at DESC
    LIMIT 20
  `).all(req.user.id);

    const enriched = sessions.map(s => {
        const p = getPersona(s.persona);
        return {
            ...s,
            personaName: p?.name || s.persona,
            personaAvatar: p?.avatar || '🤖'
        };
    });

    res.json({ sessions: enriched });
});

module.exports = router;
