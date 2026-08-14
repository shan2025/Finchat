// routes/settings.js — user settings (Sprint 8: notification channels)
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const {
  getPrefs, savePrefs, channelConfigStatus, getVapidKeys,
  getTelegramBotInfo, telegramGetUpdates
} = require('../services/notificationChannels');
const wa = require('../services/whatsapp');
const { createNotification } = require('../services/notifications');

// In-memory Telegram link codes: code -> { userId, createdAt }. Short-lived;
// the user starts a link, messages the bot, and we match their /start payload.
const tgLinkCodes = new Map();
function cleanupTgCodes() {
  const now = Date.now();
  for (const [code, v] of tgLinkCodes) {
    if (now - v.createdAt > 10 * 60 * 1000) tgLinkCodes.delete(code);
  }
}

// Everything the Settings page needs to describe the WhatsApp channel: which
// provider is live, whether this user's number is verified, and how much of
// the 24-hour freeform window is left. Kept in one place because the status
// endpoint, the link poll and the test send all report the same thing.
function whatsappStatus(prefs) {
  const cfg = wa.configStatus();
  const win = wa.windowState(prefs || {});
  return {
    ...cfg,
    to: (prefs && prefs.whatsapp_to) || null,
    verified: Boolean(prefs && prefs.whatsapp_verified),
    linkedVia: (prefs && prefs.whatsapp_provider) || null,
    window: win
  };
}

// ── GET /api/settings/notifications ── prefs + server channel status ──
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const prefs = await getPrefs(req.user.id);
    const deliveries = await query(`
      SELECT channel, destination, status, detail, created_at
      FROM notification_deliveries WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 15
    `, [req.user.id]);
    res.json({
      prefs: prefs || {
        channel_inapp: true, channel_email: false, channel_whatsapp: false,
        channel_telegram: false, channel_sms: false, channel_push: false,
        email_to: req.user.email || '', muted_types: []
      },
      serverChannels: channelConfigStatus(), // which channels have credentials in .env
      whatsapp: whatsappStatus(prefs),
      recentDeliveries: deliveries.rows
    });
  } catch (err) {
    console.error('Get notification settings error:', err);
    res.status(500).json({ error: 'Failed to load notification settings' });
  }
});

// ── PUT /api/settings/notifications ── save prefs ──
router.put('/notifications', requireAuth, async (req, res) => {
  try {
    // whatsapp_verified / whatsapp_provider / whatsapp_last_inbound_at are
    // deliberately absent: they record what the inbound webhook observed, and
    // a client that could set them could claim a number it does not own.
    const allowed = ['channel_inapp', 'channel_email', 'email_to', 'channel_whatsapp', 'whatsapp_to',
      'channel_telegram', 'telegram_chat_id', 'channel_sms', 'sms_to', 'channel_push', 'muted_types'];
    const clean = {};
    for (const k of allowed) if (k in req.body) clean[k] = req.body[k];

    // Store phone numbers in E.164. The providers reject anything else, and
    // the inbound webhook matches on an exact string — "+91 98765 43210" saved
    // verbatim would never match the "+919876543210" WhatsApp reports.
    for (const field of ['whatsapp_to', 'sms_to']) {
      if (!clean[field]) continue;
      const num = wa.normalizeE164(clean[field]);
      if (!num.e164) {
        return res.status(400).json({ error: `${field === 'whatsapp_to' ? 'WhatsApp' : 'SMS'} number: ${num.error}` });
      }
      // Changing the number invalidates the previous verification.
      if (field === 'whatsapp_to') {
        const existing = await getPrefs(req.user.id);
        if (existing && existing.whatsapp_to && existing.whatsapp_to !== num.e164) {
          clean.whatsapp_verified = false;
          clean.whatsapp_last_inbound_at = null;
        }
      }
      clean[field] = num.e164;
    }

    const prefs = await savePrefs(req.user.id, clean);
    res.json({ status: 'ok', prefs, whatsapp: whatsappStatus(prefs) });
  } catch (err) {
    console.error('Save notification settings error:', err);
    res.status(500).json({ error: 'Failed to save notification settings' });
  }
});

// ── POST /api/settings/notifications/test ── end-to-end test ping ──
router.post('/notifications/test', requireAuth, async (req, res) => {
  try {
    const row = await createNotification({
      userId: req.user.id,
      type: 'system',
      title: '🔔 Test notification',
      content: 'This is a test from your FinChat notification settings. If a channel is enabled and configured, it received this message.',
      link: 'finchat_settings.html'
    });
    if (!row) return res.status(500).json({ error: 'Failed to create test notification' });
    // Give the async fan-out a moment, then report what happened per channel.
    setTimeout(async () => {
      try {
        const deliveries = await query(`
          SELECT channel, destination, status, detail FROM notification_deliveries
          WHERE notification_id = $1
        `, [row.notification_id]);
        res.json({ status: 'ok', notification: row, deliveries: deliveries.rows });
      } catch (e) {
        res.json({ status: 'ok', notification: row, deliveries: [] });
      }
    }, 2500);
  } catch (err) {
    console.error('Test notification error:', err);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// ── POST /api/settings/telegram/start-link ── begin auto-link ──
// Returns a t.me deep link the user taps; pressing Start sends /start <code>
// to the bot, which the poll endpoint below matches to capture their chat_id.
router.post('/telegram/start-link', requireAuth, async (req, res) => {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set in .env' });
    }
    const info = await getTelegramBotInfo();
    if (!info || !info.username) {
      return res.status(503).json({ error: 'Could not reach the Telegram bot — check the token in .env' });
    }
    cleanupTgCodes();
    const code = 'fc' + Math.random().toString(36).slice(2, 10);
    tgLinkCodes.set(code, { userId: req.user.id, createdAt: Date.now() });
    res.json({
      code,
      botUsername: info.username,
      deepLink: `https://t.me/${info.username}?start=${code}`
    });
  } catch (err) {
    console.error('Telegram start-link error:', err);
    res.status(500).json({ error: 'Failed to start Telegram linking' });
  }
});

// ── GET /api/settings/telegram/poll?code=… ── poll for the /start message ──
router.get('/telegram/poll', requireAuth, async (req, res) => {
  try {
    const code = req.query.code;
    const entry = code && tgLinkCodes.get(code);
    if (!entry || entry.userId !== req.user.id) {
      return res.json({ linked: false, expired: true });
    }
    const updates = await telegramGetUpdates();
    let chatId = null, matchedUpdateId = null;
    for (const u of updates) {
      const msg = u.message;
      if (msg && typeof msg.text === 'string' && msg.text.trim() === `/start ${code}`) {
        chatId = String(msg.chat.id);
        matchedUpdateId = u.update_id;
        break;
      }
    }
    if (!chatId) return res.json({ linked: false });
    await savePrefs(req.user.id, { channel_telegram: true, telegram_chat_id: chatId });
    tgLinkCodes.delete(code);
    // Confirm/clear consumed updates so they don't linger for the next link.
    if (matchedUpdateId != null) {
      try { await telegramGetUpdates(matchedUpdateId + 1); } catch (e) { /* best effort */ }
    }
    res.json({ linked: true, chatId });
  } catch (err) {
    console.error('Telegram poll error:', err);
    res.status(500).json({ error: 'Failed to poll Telegram' });
  }
});

// ── GET /api/settings/whatsapp/status ── provider + window state ──
router.get('/whatsapp/status', requireAuth, async (req, res) => {
  try {
    res.json(whatsappStatus(await getPrefs(req.user.id)));
  } catch (err) {
    console.error('WhatsApp status error:', err);
    res.status(500).json({ error: 'Failed to read WhatsApp status' });
  }
});

// ── POST /api/settings/whatsapp/start-link ── begin linking ──
// Mints a short code and returns wa.me deep links that prefill the messages
// the user has to send. Their inbound message is what proves the number is
// theirs, so nothing is written to their prefs until the webhook sees it.
router.post('/whatsapp/start-link', requireAuth, async (req, res) => {
  try {
    const cfg = wa.configStatus();
    if (!cfg.configured) return res.status(503).json({ error: cfg.detail });
    if (!cfg.senderNumber) {
      return res.status(503).json({
        error: cfg.provider === 'twilio'
          ? 'TWILIO_WHATSAPP_FROM is not a usable number — it must be the sandbox number in E.164, e.g. +14155238886'
          : 'WHATSAPP_SENDER_NUMBER not set in .env — put your Cloud API test/business number there so we can build the link'
      });
    }

    const code = wa.mintLinkCode(req.user.id);
    const sender = cfg.senderNumber.replace('+', '');
    const linkMessage = `FinChat link ${code}`;
    res.json({
      code,
      provider: cfg.provider,
      senderNumber: cfg.senderNumber,
      // Twilio's sandbox ignores anything that is not the join phrase until
      // the number is enrolled, so that is a separate first step.
      joinPhrase: cfg.joinPhrase,
      joinLink: cfg.joinPhrase
        ? `https://wa.me/${sender}?text=${encodeURIComponent(cfg.joinPhrase)}`
        : null,
      linkMessage,
      deepLink: `https://wa.me/${sender}?text=${encodeURIComponent(linkMessage)}`
    });
  } catch (err) {
    console.error('WhatsApp start-link error:', err);
    res.status(500).json({ error: 'Failed to start WhatsApp linking' });
  }
});

// ── GET /api/settings/whatsapp/poll?code=… ── has the webhook seen it? ──
// The browser polls this while the user is in WhatsApp. Unlike Telegram there
// is nothing to fetch from the provider — we are waiting on our own webhook —
// so this only reports whether the code was consumed.
router.get('/whatsapp/poll', requireAuth, async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const prefs = await getPrefs(req.user.id);
    if (prefs && prefs.whatsapp_verified && !wa.peekLinkCode(code)) {
      return res.json({ linked: true, to: prefs.whatsapp_to, whatsapp: whatsappStatus(prefs) });
    }
    if (!wa.peekLinkCode(code)) return res.json({ linked: false, expired: true });
    res.json({ linked: false });
  } catch (err) {
    console.error('WhatsApp poll error:', err);
    res.status(500).json({ error: 'Failed to poll WhatsApp linking' });
  }
});

// ── POST /api/settings/whatsapp/test ── send one message, report honestly ──
// The all-channel test guesses at results after a 2.5s sleep. WhatsApp fails
// in specific, fixable ways (window closed, number not enrolled, token
// expired), so this waits for the real provider response and returns it.
router.post('/whatsapp/test', requireAuth, async (req, res) => {
  try {
    const prefs = await getPrefs(req.user.id);
    if (!prefs || !prefs.whatsapp_to) {
      return res.status(400).json({ error: 'Save a WhatsApp number first' });
    }
    const cfg = wa.configStatus();
    if (!cfg.configured) return res.status(503).json({ error: cfg.detail });

    const result = await wa.sendNotification(prefs, {
      title: '🔔 FinChat test',
      body: 'WhatsApp is wired up. Alerts, mission reports and briefings will arrive here.',
      summary: 'WhatsApp is wired up correctly.'
    });
    await query(`
      INSERT INTO notification_deliveries (delivery_id, notification_id, user_id, channel, destination, status, detail)
      VALUES ($1, NULL, $2, 'whatsapp', $3, $4, $5)
    `, [`dlv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        req.user.id, prefs.whatsapp_to, result.status, result.detail || null]);

    res.json({ ...result, whatsapp: whatsappStatus(prefs) });
  } catch (err) {
    console.error('WhatsApp test error:', err);
    res.status(500).json({ error: 'Failed to send WhatsApp test' });
  }
});

// ── GET /api/settings/push/public-key ── VAPID public key for the browser ──
router.get('/push/public-key', requireAuth, (req, res) => {
  const keys = getVapidKeys();
  if (!keys) return res.status(503).json({ error: 'Web Push unavailable (web-push not installed)' });
  res.json({ publicKey: keys.publicKey });
});

// ── POST /api/settings/push/subscribe ── save this browser's subscription ──
router.post('/push/subscribe', requireAuth, async (req, res) => {
  try {
    const sub = req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription object required' });
    const prefs = await savePrefs(req.user.id, { channel_push: true, push_subscription: sub });
    res.json({ status: 'ok', prefs });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

module.exports = router;
