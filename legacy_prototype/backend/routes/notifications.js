// routes/notifications.js — user notification feed for the bell
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');

// ── GET /api/notifications ── recent notifications for the current user ──
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const result = await query(
      `SELECT notification_id, type, title, content, is_read, link, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ── GET /api/notifications/unread-count ──
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = 0`,
      [req.user.id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// ── GET /api/notifications/:id ── one notification, for the Telegram card's
// "Read full report" link. The card is deliberately short, so the full body
// has to be reachable from the phone even when it is older than the bell's
// last 20 items.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT notification_id, type, title, content, is_read, link, created_at
       FROM notifications
       WHERE notification_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification: result.rows[0] });
  } catch (err) {
    console.error('Fetch notification error:', err);
    res.status(500).json({ error: 'Failed to fetch notification' });
  }
});

// ── POST /api/notifications/:id/read ── mark one as read ──
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET is_read = 1 WHERE notification_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

// ── POST /api/notifications/read-all ── mark all as read ──
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications SET is_read = 1 WHERE user_id = $1 AND is_read = 0`,
      [req.user.id]
    );
    res.json({ status: 'ok', updated: result.rowCount });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

module.exports = router;
