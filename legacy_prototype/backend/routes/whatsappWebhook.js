// routes/whatsappWebhook.js — inbound WhatsApp messages.
//
// Unlike Telegram, WhatsApp has no getUpdates equivalent: the only way to know
// a user has messaged us is a webhook. That matters for two things FinChat
// needs and cannot fake:
//
//   1. Linking. The user messages the FinChat number with a short code; that
//      inbound message is what proves the number is theirs and reachable.
//   2. The 24-hour window. Every inbound message restarts the clock during
//      which we may send freeform text. Without this endpoint we are always
//      guessing, and briefings fail with a provider error instead of a
//      sentence the user can act on.
//
// Mounted WITHOUT requireAuth — the callers are Twilio and Meta, not a browser
// — so every request is authenticated by provider signature instead. This
// endpoint writes to user records, so an unsigned POST must never be able to
// point somebody's WhatsApp channel at a number the attacker controls.
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const wa = require('../services/whatsapp');
const { savePrefs } = require('../services/notificationChannels');

// ── GET /api/whatsapp/webhook ── Meta's subscription handshake ──
// Meta calls this once when you save the callback URL and expects the
// challenge echoed back in plain text.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!expected) {
    return res.status(503).send('WHATSAPP_VERIFY_TOKEN not set in .env');
  }
  if (mode === 'subscribe' && token === expected) {
    console.log('✅ WhatsApp webhook verified by Meta');
    return res.status(200).send(String(challenge == null ? '' : challenge));
  }
  return res.sendStatus(403);
});

// The URL Twilio signed. Behind Render's proxy req.protocol is http unless
// trust proxy is on, and a one-character mismatch invalidates the signature,
// so allow an explicit override.
function callbackUrl(req) {
  if (process.env.WHATSAPP_WEBHOOK_URL) return process.env.WHATSAPP_WEBHOOK_URL;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}${req.originalUrl}`;
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
function authenticate(req) {
  // Dev escape hatch for tunnels that rewrite the host header. Documented as
  // local-only; it disables the only authentication this endpoint has.
  if (String(process.env.WHATSAPP_WEBHOOK_INSECURE || '').toLowerCase() === 'true') {
    return { ok: true };
  }

  const twilioSig = req.get('x-twilio-signature');
  if (twilioSig) {
    const url = callbackUrl(req);
    if (wa.verifyTwilioSignature(twilioSig, url, req.body)) return { ok: true };
    return { ok: false, reason: `Twilio signature mismatch (checked against ${url} — set WHATSAPP_WEBHOOK_URL if that is not the URL you configured in Twilio)` };
  }

  const metaSig = req.get('x-hub-signature-256');
  if (metaSig) {
    if (!process.env.WHATSAPP_APP_SECRET) {
      return { ok: false, reason: 'Signed Meta request but WHATSAPP_APP_SECRET is not set in .env' };
    }
    if (wa.verifyMetaSignature(metaSig, req.rawBody)) return { ok: true };
    return { ok: false, reason: 'Meta signature mismatch' };
  }

  return { ok: false, reason: 'Unsigned request — no X-Twilio-Signature or X-Hub-Signature-256 header' };
}

// ── POST /api/whatsapp/webhook ── inbound messages from either provider ──
router.post('/webhook', async (req, res) => {
  const auth = authenticate(req);
  if (!auth.ok) {
    console.warn(`⚠️ Rejected WhatsApp webhook: ${auth.reason}`);
    return res.sendStatus(403);
  }

  // Answer immediately. Meta retries with backoff — and eventually disables the
  // subscription — if we spend the request doing database work, and Twilio
  // wants TwiML or an empty 200.
  if (req.get('x-twilio-signature')) {
    res.type('text/xml').send('<Response></Response>');
  } else {
    res.sendStatus(200);
  }

  try {
    for (const msg of wa.parseInbound(req.body)) {
      await handleInbound(msg);
    }
  } catch (err) {
    console.warn(`⚠️ WhatsApp inbound handling failed: ${err.message}`);
  }
});

/**
 * One inbound message: either it links a number to an account, or it reopens
 * the 24-hour window for an already-linked one.
 */
async function handleInbound({ from, text, provider }) {
  const code = wa.extractLinkCode(text);
  if (code) {
    const entry = wa.peekLinkCode(code);
    if (entry) {
      await savePrefs(entry.userId, {
        channel_whatsapp: true,
        whatsapp_to: from,
        whatsapp_verified: true,
        whatsapp_provider: provider,
        whatsapp_last_inbound_at: new Date().toISOString()
      });
      wa.consumeLinkCode(code);
      console.log(`🔗 WhatsApp linked: ${from} → user ${entry.userId} (${provider})`);
      // Confirm in the thread the user is already looking at. Safe to send —
      // their inbound message just opened the window.
      wa.sendText(from, 'Linked. FinChat will send your alerts and briefings here.')
        .catch(() => { /* the link itself succeeded; the receipt is a nicety */ });
      return;
    }
    console.warn(`⚠️ WhatsApp link code ${code} from ${from} is unknown or expired`);
  }

  // Not a link attempt — treat it as the user reopening their window.
  const rows = await query(
    'SELECT user_id FROM notification_preferences WHERE whatsapp_to = $1',
    [from]
  );
  if (!rows.rows.length) {
    console.log(`ℹ️ WhatsApp message from unlinked number ${from} — ignored`);
    return;
  }
  for (const row of rows.rows) {
    await savePrefs(row.user_id, {
      whatsapp_verified: true,
      whatsapp_provider: provider,
      whatsapp_last_inbound_at: new Date().toISOString()
    });
    console.log(`🕒 WhatsApp window reopened for user ${row.user_id} (${from})`);
  }
}

// ── GET /api/whatsapp/health ── is this endpoint reachable and configured? ──
// Deliberately unauthenticated and free of user data: it exists so you can
// curl the deployed URL and see whether the provider will be able to talk to
// it, which is the first thing that goes wrong.
router.get('/health', (req, res) => {
  const status = wa.configStatus();
  res.json({
    provider: status.provider,
    configured: status.configured,
    verifyTokenSet: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    appSecretSet: Boolean(process.env.WHATSAPP_APP_SECRET),
    insecureMode: String(process.env.WHATSAPP_WEBHOOK_INSECURE || '').toLowerCase() === 'true',
    callbackUrl: callbackUrl(req).replace('/health', '/webhook')
  });
});

// An Express router is a function, so the test-facing helper rides along on it
// without changing how server.js mounts this like every other route file.
module.exports = router;
module.exports.handleInbound = handleInbound;
