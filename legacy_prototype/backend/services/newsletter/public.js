// services/newsletter/public.js — the general daily edition for public subscribers.
//
// The personal newsletter (./index.js) edits ONE user's own briefings and
// mission reports, so it cannot go to someone without an account. This edition
// is built once per IST day from the market briefings alone — those are general
// by construction (services/briefing.js gives every user the same goal) — with
// an editor brief that strips anything addressed to a particular reader. The
// PDF is uploaded once; every other subscriber is sent the same Telegram
// file_id, so a thousand sends are a thousand small API calls, not uploads.
//
// Driven by the cron tick after services/telegramBot.js has read new /start
// messages, so somebody who subscribes after 09:00 gets today's issue on the
// next tick. Subscribers who also linked Telegram to a FinChat account are
// skipped — they already get their personal issue.
//
// PUBLIC_NEWSLETTER_ENABLED=false stops it. PUBLIC_NEWSLETTER_SOURCE_USER pins
// the source to one account's briefings instead of the latest from anyone.

const { query: dbQuery } = require('../../database');
const { istParts, prettyDate, caption, composeIssue, HOUR_IST } = require('./index');

const WINDOW_HOURS = 24;
const MAX_SOURCES = 4;            // briefings across users are near-duplicates; a few is plenty
const BATCH = 100;
const MAX_PER_RUN = 1000;
const PACE_MS = 50;               // ~20 sends/s, under Telegram's ~30/s bot limit
const RETRY_MINUTES = 60;         // an empty/failed build retries after this
const STUCK_MINUTES = 30;         // a 'building' row older than this was abandoned

const PUBLIC_PROMPT = `You are the editor of FinChat Daily, a free public market newsletter sent each morning to Telegram subscribers. You are given the last 24 hours of market briefings written by an AI research team.
Edit them into ONE issue for a general audience. Cover markets, macro, companies, commodities, crypto and the AI industry. Merge duplicates, keep the strongest and most concrete items, drop filler. Keep numbers, names and dates exactly as given — never invent a figure, source or URL.
This goes to strangers: leave out anything addressed to one particular reader — their portfolio, holdings, watchlist, job search, missions, "you/your" advice, or names of private people. Never recommend buying or selling anything.

Write markdown in EXACTLY this shape (it is rendered as cards in a PDF):

# FinChat Daily — {DATE}

One or two sentences on what defined the day.

## Executive Summary
3-5 bullets, the strongest signals first. Each bullet starts with a **bold short label**.

## [Section name, e.g. Markets, Macro, Crypto, AI & Tech]
### [Story headline, max 8 words]
#### [One-line subtitle]
60-110 words of analysis with the concrete numbers. Cite sources inline as [Source][N] using the reference numbers you define at the bottom.
**Why it matters** — one or two sentences for an investor or builder.
*In short: [3-6 word tagline]*

(Use 2-4 sections and 5-8 stories in total.)

## 🎯 Key Takeaway
One paragraph connecting the day.

[1]: https://... "Title"
[2]: https://... "Title"
(Only URLs that appear in the briefings. If there are none, omit this list.)`;

const FOOTER = '<i>Send /stop to unsubscribe.</i>';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gatherPublicSources(since, query = dbQuery) {
  const pin = process.env.PUBLIC_NEWSLETTER_SOURCE_USER || null;
  const r = await query(`
    SELECT notification_id, type, title, content, created_at
    FROM notifications
    WHERE type = 'briefing' AND created_at > $1
      AND length(coalesce(content, '')) > 200
      AND ($3::text IS NULL OR user_id = $3)
    ORDER BY created_at DESC
    LIMIT $2
  `, [since, MAX_SOURCES * 3, pin]);
  // Several users' copies of the same slot are near-identical; keep distinct ones.
  const seen = new Set();
  const out = [];
  for (const row of r.rows) {
    const key = String(row.content).replace(/\s+/g, ' ').slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= MAX_SOURCES) break;
  }
  return out.reverse();
}

// The rendered PDF for the current day, so a run does not re-render per batch.
// After a restart it is rebuilt from the stored markdown (no LLM call).
let cache = null;
async function pdfFor(issue) {
  if (cache && cache.day === issue.day) return cache.pdf;
  const { renderNewsletterPdf } = require('./pdf');
  const pdf = await renderNewsletterPdf(issue.markdown, { subject: `FinChat Daily for ${issue.date}` });
  cache = { day: issue.day, pdf };
  return pdf;
}

/** Claim and build today's issue if it is not built (or its last try is stale). */
async function ensureIssue(day, now, deps) {
  const query = deps.query || dbQuery;
  const claim = await query(`
    INSERT INTO public_newsletters (day, status) VALUES ($1, 'building')
    ON CONFLICT (day) DO UPDATE SET status = 'building', detail = NULL, created_at = now()
    WHERE (public_newsletters.status IN ('failed', 'empty')
           AND public_newsletters.created_at < now() - ($2 || ' minutes')::interval)
       OR (public_newsletters.status = 'building'
           AND public_newsletters.created_at < now() - ($3 || ' minutes')::interval)
    RETURNING day
  `, [day, String(RETRY_MINUTES), String(STUCK_MINUTES)]);

  if (!claim.rows.length) {
    const r = await query(`SELECT day::text AS day, status, title, markdown, file_id FROM public_newsletters WHERE day = $1`, [day]);
    return r.rows[0] ? { ...r.rows[0], day, date: prettyDate(now) } : null;
  }

  const finish = (status, detail, extra = {}) => query(`
    UPDATE public_newsletters SET status = $2, detail = $3, title = $4, markdown = $5, source_count = $6, pages = $7
    WHERE day = $1
  `, [day, status, detail, extra.title || null, extra.markdown || null, extra.sources || 0, extra.pages || null]);

  try {
    const sources = await gatherPublicSources(new Date(now.getTime() - WINDOW_HOURS * 3600e3), query);
    if (!sources.length) {
      await finish('empty', 'No market briefings in the last 24h');
      return { day, status: 'empty' };
    }
    const date = prettyDate(now);
    const { markdown, edited } = await composeIssue(sources, { date, prompt: PUBLIC_PROMPT, runInference: deps.runInference });
    const issue = { day, date, markdown, status: 'ready', file_id: null };
    cache = null;
    const pdf = await pdfFor(issue);
    issue.title = pdf.title;
    const detail = `${pdf.pages} cards · ${sources.length} briefing(s)${edited ? '' : ' · unedited fallback'}`;
    await finish('ready', detail, { title: pdf.title, markdown, sources: sources.length, pages: pdf.pages });
    console.log(`📰 [PublicNewsletter] ${day} built: ${detail}`);
    return issue;
  } catch (err) {
    await finish('failed', err.message).catch(() => {});
    console.error(`❌ [PublicNewsletter] ${day} build failed: ${err.message}`);
    return { day, status: 'failed', detail: err.message };
  }
}

// Subscribers due today, claimed atomically so overlapping runs never double-send.
async function claimBatch(day, limit, query) {
  const r = await query(`
    UPDATE telegram_subscribers SET last_sent_day = $1
    WHERE chat_id IN (
      SELECT s.chat_id FROM telegram_subscribers s
      WHERE s.active = true AND (s.last_sent_day IS NULL OR s.last_sent_day < $1)
        AND NOT EXISTS (
          SELECT 1 FROM notification_preferences p
          WHERE p.channel_telegram = true AND p.telegram_chat_id = s.chat_id)
      ORDER BY s.subscribed_at
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    RETURNING chat_id
  `, [day, limit]);
  return r.rows.map(x => x.chat_id);
}

async function countDue(day, query) {
  const r = await query(`
    SELECT count(*)::int AS n FROM telegram_subscribers s
    WHERE s.active = true AND (s.last_sent_day IS NULL OR s.last_sent_day < $1)
      AND NOT EXISTS (
        SELECT 1 FROM notification_preferences p
        WHERE p.channel_telegram = true AND p.telegram_chat_id = s.chat_id)
  `, [day]);
  return r.rows[0].n;
}

async function sendToSubscribers(issue, deps) {
  const query = deps.query || dbQuery;
  const send = deps.sendDocument || require('../notificationChannels').sendTelegramDocument;
  const pace = deps.paceMs != null ? deps.paceMs : PACE_MS;
  const pdf = await pdfFor(issue);
  const cap = caption({ title: pdf.title || 'FinChat Daily', date: pdf.date || issue.date, stories: pdf.stories, footer: FOOTER });
  const filename = `FinChat-Daily-${issue.day}.pdf`;
  let fileId = issue.file_id || null;
  const tally = { sent: 0, failed: 0, removed: 0, deferred: 0 };

  outer:
  while (tally.sent + tally.failed + tally.removed < MAX_PER_RUN) {
    const batch = await claimBatch(issue.day, BATCH, query);
    if (!batch.length) break;
    for (let i = 0; i < batch.length; i++) {
      const chatId = batch[i];
      try {
        const r = await send(chatId, fileId || pdf.buffer, filename, cap);
        if (!fileId && r && r.fileId) {
          fileId = r.fileId;
          await query(`UPDATE public_newsletters SET file_id = $2 WHERE day = $1`, [issue.day, fileId]);
        }
        tally.sent++;
      } catch (err) {
        const status = err.response && err.response.status;
        const desc = (err.response && err.response.data && err.response.data.description) || err.message;
        if (status === 403 || (status === 400 && /chat not found|user is deactivated/i.test(desc))) {
          // Blocked the bot, left the group, or deleted the account: stop sending.
          const { unsubscribe } = require('../telegramBot');
          await unsubscribe(chatId, desc, query);
          tally.removed++;
        } else if (status === 429 || !status || status >= 500) {
          // Rate limited or Telegram/network trouble: hand this chat and the rest
          // of the batch back to the next tick instead of losing today's issue.
          const rest = batch.slice(i);
          await query(`UPDATE telegram_subscribers SET last_sent_day = NULL WHERE chat_id = ANY($1)`, [rest]);
          tally.deferred += rest.length;
          console.warn(`⚠️ [PublicNewsletter] paused (${status || 'network'}: ${desc}); ${rest.length} deferred to next tick`);
          break outer;
        } else {
          await query(`UPDATE telegram_subscribers SET last_error = $2 WHERE chat_id = $1`, [chatId, desc]);
          tally.failed++;
        }
      }
      if (pace) await sleep(pace);
    }
  }

  if (tally.sent || tally.failed) {
    await query(`UPDATE public_newsletters SET sent_count = sent_count + $2, failed_count = failed_count + $3 WHERE day = $1`,
      [issue.day, tally.sent, tally.failed]);
  }
  return tally;
}

let running = false;
/** Called from the cron tick: build today's public issue if due, then send it to whoever has not had it. */
async function runPublicNewsletter({ now = new Date(), deps = {} } = {}) {
  if (String(process.env.PUBLIC_NEWSLETTER_ENABLED || 'true').toLowerCase() === 'false') return { skipped: 'disabled' };
  if (!process.env.TELEGRAM_BOT_TOKEN && !deps.sendDocument) return { skipped: 'telegram unconfigured' };
  const { day, hour } = istParts(now);
  if (hour < HOUR_IST) return { skipped: `before ${HOUR_IST}:00 IST` };
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const query = deps.query || dbQuery;
    // No subscribers waiting → no LLM call, no PDF.
    if (!(await countDue(day, query))) return { day, due: 0 };
    const issue = await ensureIssue(day, now, deps);
    if (!issue || issue.status !== 'ready' || !issue.markdown) {
      return { day, issue: issue ? issue.status : 'none', detail: issue && issue.detail };
    }
    const tally = await sendToSubscribers(issue, deps);
    if (tally.sent || tally.failed || tally.removed || tally.deferred) {
      console.log(`📰 [PublicNewsletter] ${day}: ${tally.sent} sent, ${tally.failed} failed, ${tally.removed} removed, ${tally.deferred} deferred`);
    }
    return { day, ...tally };
  } finally {
    running = false;
  }
}

function _resetForTests() { cache = null; running = false; }

module.exports = { runPublicNewsletter, gatherPublicSources, ensureIssue, sendToSubscribers, PUBLIC_PROMPT, _resetForTests };
