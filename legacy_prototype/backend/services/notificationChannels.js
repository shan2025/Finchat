// services/notificationChannels.js — external notification fan-out (Sprint 8)
//
// Every in-app notification can also be delivered to the channels the user
// enabled on the Settings page: email (SMTP), WhatsApp + SMS (Twilio REST),
// Telegram (Bot API) and browser/mobile push (Web Push, VAPID).
//
// Design rules:
// - NEVER throws to the caller: each attempt is recorded in
//   notification_deliveries with status sent|failed|skipped|unconfigured.
// - A channel with no server credentials reports 'unconfigured' so the
//   Settings page can tell the user exactly what's missing.
// - VAPID keys are generated once and persisted next to the Solana keypair so
//   push works out-of-the-box with zero external accounts.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { query } = require('../database');

const VAPID_PATH = path.join(__dirname, '..', '.vapid-keys.json');

// ── Prefs ────────────────────────────────────────────────────
async function getPrefs(userId) {
  const res = await query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

async function savePrefs(userId, prefs) {
  const cols = ['channel_inapp', 'channel_email', 'email_to', 'channel_whatsapp', 'whatsapp_to',
    'channel_telegram', 'telegram_chat_id', 'channel_sms', 'sms_to', 'channel_push',
    'push_subscription', 'muted_types'];
  const existing = await getPrefs(userId);
  const merged = { ...(existing || {}), ...prefs };
  const vals = cols.map(c => {
    let v = merged[c];
    if (v === undefined) v = null;
    if ((c === 'push_subscription' || c === 'muted_types') && v !== null && typeof v !== 'string') {
      v = JSON.stringify(v);
    }
    return v;
  });
  await query(`
    INSERT INTO notification_preferences (user_id, ${cols.join(', ')}, updated_at)
    VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW()
  `, [userId, ...vals]);
  return getPrefs(userId);
}

// ── Channel configuration status (for the Settings page) ─────
function channelConfigStatus() {
  return {
    email: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    whatsapp: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM),
    sms: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    push: true // VAPID keys are self-generated, always available
  };
}

// ── VAPID (Web Push) ─────────────────────────────────────────
let _vapid = null;
function getVapidKeys() {
  if (_vapid) return _vapid;
  try {
    const webpush = require('web-push');
    if (fs.existsSync(VAPID_PATH)) {
      _vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
    } else {
      _vapid = webpush.generateVAPIDKeys();
      fs.writeFileSync(VAPID_PATH, JSON.stringify(_vapid));
      console.log('🔔 Generated new VAPID keypair for Web Push');
    }
    webpush.setVapidDetails('mailto:admin@finchat.local', _vapid.publicKey, _vapid.privateKey);
    return _vapid;
  } catch (e) {
    console.warn('⚠️ web-push unavailable:', e.message);
    return null;
  }
}

// ── Adapters ─────────────────────────────────────────────────
async function sendEmail(to, subject, text) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return { status: 'unconfigured', detail: 'SMTP_HOST / SMTP_USER not set in .env' };
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `FinChat <${process.env.SMTP_USER}>`,
    to, subject, text
  });
  return { status: 'sent' };
}

async function twilioSend(to, from, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    params.toString(),
    { auth: { username: sid, password: tok }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  return { status: 'sent' };
}

async function sendWhatsApp(to, body) {
  if (!channelConfigStatus().whatsapp) return { status: 'unconfigured', detail: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM not set in .env' };
  return twilioSend(`whatsapp:${to}`, `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`, body);
}

async function sendSMS(to, body) {
  if (!channelConfigStatus().sms) return { status: 'unconfigured', detail: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_SMS_FROM not set in .env' };
  return twilioSend(to, process.env.TWILIO_SMS_FROM, body);
}

async function sendTelegram(chatId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { status: 'unconfigured', detail: 'TELEGRAM_BOT_TOKEN not set in .env' };
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text },
    { timeout: 15000 }
  );
  return { status: 'sent' };
}

async function sendPush(subscription, payload) {
  const keys = getVapidKeys();
  if (!keys) return { status: 'unconfigured', detail: 'web-push package not installed' };
  if (!subscription) return { status: 'skipped', detail: 'No push subscription saved — enable push on the Settings page' };
  const webpush = require('web-push');
  const sub = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
  await webpush.sendNotification(sub, JSON.stringify(payload));
  return { status: 'sent' };
}

// ── Delivery log ─────────────────────────────────────────────
async function logDelivery({ notificationId, userId, channel, destination, status, detail }) {
  try {
    await query(`
      INSERT INTO notification_deliveries (delivery_id, notification_id, user_id, channel, destination, status, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [`dlv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        notificationId, userId, channel, destination || null, status, detail || null]);
  } catch (e) { /* never let logging break dispatch */ }
}

// ── Fan-out ──────────────────────────────────────────────────
/**
 * Deliver one notification row to every enabled external channel.
 * @param {object} n - row from createNotification (notification_id, user_id, type, title, content, link)
 */
async function dispatchToChannels(n) {
  const prefs = await getPrefs(n.user_id);
  if (!prefs) return; // user never opened Settings — in-app only

  const muted = Array.isArray(prefs.muted_types) ? prefs.muted_types
    : (typeof prefs.muted_types === 'string' ? JSON.parse(prefs.muted_types || '[]') : []);
  if (muted.includes(n.type)) return;

  const text = `${n.title}\n${n.content || ''}`.trim();
  const attempts = [];

  if (prefs.channel_email && prefs.email_to) {
    attempts.push(['email', prefs.email_to, () => sendEmail(prefs.email_to, `FinChat: ${n.title}`, text)]);
  }
  if (prefs.channel_whatsapp && prefs.whatsapp_to) {
    attempts.push(['whatsapp', prefs.whatsapp_to, () => sendWhatsApp(prefs.whatsapp_to, text)]);
  }
  if (prefs.channel_sms && prefs.sms_to) {
    attempts.push(['sms', prefs.sms_to, () => sendSMS(prefs.sms_to, text.slice(0, 300))]);
  }
  if (prefs.channel_telegram && prefs.telegram_chat_id) {
    attempts.push(['telegram', prefs.telegram_chat_id, () => sendTelegram(prefs.telegram_chat_id, text)]);
  }
  if (prefs.channel_push) {
    attempts.push(['push', 'browser', () => sendPush(prefs.push_subscription, {
      title: n.title, body: n.content || '', link: n.link || 'finchat_dashboard.html'
    })]);
  }

  for (const [channel, destination, fn] of attempts) {
    try {
      const r = await fn();
      await logDelivery({ notificationId: n.notification_id, userId: n.user_id, channel, destination, status: r.status, detail: r.detail });
      if (r.status === 'sent') console.log(`📨 Notification ${n.notification_id} → ${channel} (${destination})`);
    } catch (err) {
      await logDelivery({ notificationId: n.notification_id, userId: n.user_id, channel, destination, status: 'failed', detail: err.message });
      console.warn(`⚠️ ${channel} delivery failed: ${err.message}`);
    }
  }
}

module.exports = {
  getPrefs,
  savePrefs,
  dispatchToChannels,
  channelConfigStatus,
  getVapidKeys,
  sendEmail,
  sendWhatsApp,
  sendSMS,
  sendTelegram,
  sendPush
};
