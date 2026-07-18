// routes/settings.js — user settings (Sprint 8: notification channels)
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const {
  getPrefs, savePrefs, channelConfigStatus, getVapidKeys
} = require('../services/notificationChannels');
const { createNotification } = require('../services/notifications');

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
    const allowed = ['channel_inapp', 'channel_email', 'email_to', 'channel_whatsapp', 'whatsapp_to',
      'channel_telegram', 'telegram_chat_id', 'channel_sms', 'sms_to', 'channel_push', 'muted_types'];
    const clean = {};
    for (const k of allowed) if (k in req.body) clean[k] = req.body[k];
    const prefs = await savePrefs(req.user.id, clean);
    res.json({ status: 'ok', prefs });
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
