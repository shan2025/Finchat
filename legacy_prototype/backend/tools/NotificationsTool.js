// tools/NotificationsTool.js — read the signed-in user's notification feed.
// Lets any persona answer "where are my notifications / do I have anything new?"
// Read-only: it never marks notifications read or deletes them (that stays a
// deliberate user action in the bell UI). Receives the executing user's id via
// the tool context (second execute arg), same pattern as WatchlistTool.
const { query } = require('../database');

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  // Plain-string convenience: "list" | "unread"
  const m = s.match(/^(list|unread)\b/i);
  if (m) return { action: m[1].toLowerCase() };
  return { action: 'list' };
}

async function execute(input, context = {}) {
  const { action = 'list', limit } = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Notifications require a signed-in user context');
  }

  const unreadRes = await query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = 0',
    [userId]
  );
  const unreadCount = unreadRes.rows[0].count;

  if (action === 'unread') {
    return {
      action,
      unreadCount,
      note: unreadCount === 0 ? 'No unread notifications.' : `${unreadCount} unread notification(s).`
    };
  }

  const cap = Math.min(parseInt(limit) || 20, 50);
  const res = await query(
    `SELECT type, title, content, is_read, link, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, cap]
  );

  return {
    action,
    unreadCount,
    count: res.rows.length,
    notifications: res.rows.map(r => ({
      type: r.type,
      title: r.title,
      content: r.content,
      read: r.is_read === 1,
      link: r.link,
      createdAt: r.created_at
    })),
    note: res.rows.length === 0
      ? 'The user has no notifications yet. Tell them the feed is empty rather than inventing any.'
      : undefined
  };
}

module.exports = { execute };
