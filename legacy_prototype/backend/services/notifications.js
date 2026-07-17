// services/notifications.js — single writer for user notifications
// Inserts a row into the notifications table (correct `is_read` column) and emits
// `notification:new` on the EventBus so server.js can push it to the bell live.
const { query } = require('../database');
const { eventBus } = require('./cognitive/EventBus');

/**
 * Create a notification for a user.
 * Best-effort: never throws to its caller (logs and returns null on failure).
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.type    - 'briefing' | 'fraud' | 'debate' | 'system' | ...
 * @param {string} opts.title
 * @param {string} opts.content
 * @returns {Promise<object|null>} the created row (minus nothing) or null
 */
async function createNotification({ userId, type = 'system', title, content }) {
  if (!userId || !title) return null;
  const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  try {
    await query(
      `INSERT INTO notifications (notification_id, user_id, type, title, content, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, NOW())`,
      [notificationId, userId, type, title, content || '']
    );

    const row = {
      notification_id: notificationId,
      user_id: userId,
      type,
      title,
      content: content || '',
      is_read: 0,
      created_at: new Date().toISOString()
    };

    eventBus.emit('notification:new', row);
    return row;
  } catch (err) {
    console.warn(`⚠️ createNotification failed (${type}): ${err.message}`);
    return null;
  }
}

module.exports = { createNotification };
