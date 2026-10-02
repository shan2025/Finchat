// services/telegramBot.js — everything the bot RECEIVES.
//
// The bot used to read its messages only while someone was linking from
// Settings (routes/settings.js polled getUpdates for one "/start <code>").
// Anybody who found the bot and pressed Start was never recorded, and Telegram
// discards unread updates after 24h, so they were simply lost.
//
// This module is now the one reader of getUpdates. Each update is handled once:
//   /start            → subscribe to the public daily edition (newsletter/public.js)
//   /start fc<code>   → a Settings link; stored in telegram_link_starts for the
//                       link poll to pick up (any process may have read it)
//   /stop, /unsubscribe → unsubscribe
//   /help             → what the bot does
//
// Still polling, not a webhook: a webhook disables getUpdates for that token,
// which would break every other place (local dev included) that reads it. It
// is driven by the cron tick (every 15 min, wakes the host) and, while the host
// is awake, by startPolling() from server.js — so a reply lands within seconds
// when awake and within one tick when not.

const axios = require('axios');
const { query: dbQuery } = require('../database');

const LINK_CODE = /^fc[a-z0-9]{4,20}$/;
const LINK_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 3; // per update; a message that keeps failing is skipped, not retried forever

let offset = null;           // last update_id + 1; passing it confirms everything before
let inFlight = null;
const attempts = new Map();  // update_id -> failures so far

const WELCOME = [
  '<b>Welcome to FinChat Daily</b> 📰',
  '',
  'Every morning you will get one PDF: the day\'s markets, macro, crypto and AI-industry news, edited into a few swipeable cards.',
  '',
  'If today\'s issue is already out, it will arrive in a few minutes.',
  'Send /stop at any time to unsubscribe.'
].join('\n');
const ALREADY = 'You are already subscribed — the next issue arrives in the morning. Send /stop to unsubscribe.';
const BYE = 'Unsubscribed. You will not get the daily issue any more. Send /start to come back.';
const HELP = [
  '<b>FinChat Daily</b> — a free morning market newsletter as a PDF.',
  '',
  '/start — subscribe',
  '/stop — unsubscribe'
].join('\n');
const LINKING = 'Got it — go back to FinChat to finish linking your account.';

/** "/start@MyBot payload" → { cmd: 'start', arg: 'payload' }; null if not a command. */
function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(String(text || '').trim());
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

async function getUpdates(off) {
  const params = { allowed_updates: JSON.stringify(['message']) };
  if (off != null) params.offset = off;
  const r = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`,
    { params, timeout: 15000 });
  return (r.data && r.data.ok) ? r.data.result : [];
}

async function reply(chatId, html) {
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    { timeout: 15000 });
}

/** Insert or reactivate. Returns 'new' | 'back' | 'already'. */
async function subscribe(chat, from, query = dbQuery) {
  const r = await query(`
    WITH prev AS (SELECT active FROM telegram_subscribers WHERE chat_id = $1)
    INSERT INTO telegram_subscribers (chat_id, chat_type, username, first_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (chat_id) DO UPDATE SET active = true, unsubscribed_at = NULL, last_error = NULL,
      chat_type = EXCLUDED.chat_type, username = EXCLUDED.username, first_name = EXCLUDED.first_name
    RETURNING (SELECT active FROM prev) AS was_active
  `, [String(chat.id), chat.type || null, chat.username || (from && from.username) || null,
      chat.title || chat.first_name || (from && from.first_name) || null]);
  const was = r.rows[0] && r.rows[0].was_active;
  return was == null ? 'new' : was ? 'already' : 'back';
}

async function unsubscribe(chatId, reason = null, query = dbQuery) {
  await query(`
    UPDATE telegram_subscribers SET active = false, unsubscribed_at = now(), last_error = coalesce($2, last_error)
    WHERE chat_id = $1 AND active = true
  `, [String(chatId), reason]);
}

/** Handle one update. Returns what it did (for logs and tests). */
async function handleUpdate(u, { query = dbQuery, send = reply } = {}) {
  const msg = u && u.message;
  if (!msg || !msg.chat || typeof msg.text !== 'string') return 'ignored';
  const c = parseCommand(msg.text);
  if (!c) return 'ignored';
  const chatId = String(msg.chat.id);
  // A failed reply (bot blocked, chat gone) must not fail the update itself.
  const say = (html) => send(chatId, html).catch(() => {});

  if (c.cmd === 'start' && LINK_CODE.test(c.arg)) {
    await query(`
      INSERT INTO telegram_link_starts (code, chat_id) VALUES ($1, $2)
      ON CONFLICT (code) DO UPDATE SET chat_id = EXCLUDED.chat_id, created_at = now()
    `, [c.arg, chatId]);
    await say(LINKING);
    return 'link';
  }
  if (c.cmd === 'start') {
    const state = await subscribe(msg.chat, msg.from, query);
    await say(state === 'already' ? ALREADY : WELCOME);
    console.log(`📬 [TelegramBot] ${state === 'new' ? 'New subscriber' : state === 'back' ? 'Resubscribed' : 'Already subscribed'}: ${chatId}`);
    return state === 'already' ? 'already' : 'subscribed';
  }
  if (c.cmd === 'stop' || c.cmd === 'unsubscribe') {
    await unsubscribe(chatId, null, query);
    await say(BYE);
    return 'unsubscribed';
  }
  if (c.cmd === 'help') { await say(HELP); return 'help'; }
  return 'ignored';
}

/**
 * Read and handle every pending update. Safe to call from anywhere (cron tick,
 * interval, the Settings link poll): concurrent callers share one in-flight read.
 */
function pollOnce(deps = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN && !deps.getUpdates) return Promise.resolve({ skipped: 'unconfigured' });
  if (inFlight) return inFlight;
  const fetch = deps.getUpdates || getUpdates;
  inFlight = (async () => {
    const updates = await fetch(offset);
    const done = {};
    for (const u of updates) {
      try {
        const what = await handleUpdate(u, deps);
        done[what] = (done[what] || 0) + 1;
        attempts.delete(u.update_id);
      } catch (err) {
        // Stop here without confirming, so the next poll retries this update —
        // unless it has failed too often, then skip it so it cannot block the rest.
        const n = (attempts.get(u.update_id) || 0) + 1;
        console.warn(`⚠️ [TelegramBot] update ${u.update_id} failed (${n}/${MAX_ATTEMPTS}): ${err.message}`);
        if (n < MAX_ATTEMPTS) { attempts.set(u.update_id, n); break; }
        attempts.delete(u.update_id);
      }
      offset = u.update_id + 1;
    }
    return { received: updates.length, ...done };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** The chat that sent "/start <code>" recently, consumed once; null if none yet. */
async function takeLinkStart(code, query = dbQuery) {
  await query(`DELETE FROM telegram_link_starts WHERE created_at < now() - interval '1 day'`).catch(() => {});
  const r = await query(`
    DELETE FROM telegram_link_starts
    WHERE code = $1 AND created_at > now() - ($2 || ' minutes')::interval
    RETURNING chat_id
  `, [String(code), String(LINK_TTL_MINUTES)]);
  return r.rows.length ? r.rows[0].chat_id : null;
}

let timer = null;
/** Poll every `seconds` while this process is awake. No-op without a token. */
function startPolling(seconds = 30) {
  if (timer || !process.env.TELEGRAM_BOT_TOKEN) return;
  const tick = () => pollOnce().catch(err => console.warn(`⚠️ [TelegramBot] poll failed: ${err.message}`));
  tick();
  timer = setInterval(tick, seconds * 1000);
  if (timer.unref) timer.unref();
  console.log(`📬 Telegram bot: reading messages every ${seconds}s while awake`);
}

async function subscriberStats(query = dbQuery) {
  const r = await query(`
    SELECT count(*) FILTER (WHERE active)::int AS active,
           count(*) FILTER (WHERE NOT active)::int AS unsubscribed,
           count(*) FILTER (WHERE subscribed_at > now() - interval '7 days')::int AS joined_7d
    FROM telegram_subscribers`);
  return r.rows[0];
}

function _resetForTests() { offset = null; inFlight = null; attempts.clear(); }

module.exports = {
  pollOnce, handleUpdate, parseCommand, takeLinkStart, startPolling,
  subscribe, unsubscribe, subscriberStats, _resetForTests
};
