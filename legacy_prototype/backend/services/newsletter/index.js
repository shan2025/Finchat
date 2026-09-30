// services/newsletter — the daily Telegram newsletter.
//
// Real-time Telegram is deliberately quiet: telegramEditor holds every report
// it scores under 4/5, which in the last week was 63 of 77. Those reports were
// only ever visible inside the app. The newsletter is where they go instead:
// once a day, each user with a linked Telegram chat gets ONE issue that edits
// the last 24h of briefings and mission reports together, rendered as a PDF in
// the app's card style (services/newsletter/pdf.js) with a short caption.
//
// Driven by the existing 15-minute cron tick (routes/cron.js). A user's issue
// is due once the IST clock passes NEWSLETTER_HOUR_IST (default 09:00, after
// the morning brief lands at ~08:00); the `newsletters` row for that IST day is
// claimed before any work, so overlapping ticks cannot send it twice.
//
// Opt out: add 'newsletter' to the user's muted types (Settings), or turn
// Telegram off. NEWSLETTER_ENABLED=false stops it for everyone.

const { query } = require('../../database');

const HOUR_IST = Number(process.env.NEWSLETTER_HOUR_IST || 9);
const WINDOW_HOURS = 24;
const INPUT_BUDGET = 60000;       // chars of source material handed to the editor
const MAX_USERS_PER_TICK = 3;     // each issue is an LLM call + a PDF; stay small
const IST_OFFSET_MIN = 330;

function istParts(now = new Date()) {
  const t = new Date(now.getTime() + IST_OFFSET_MIN * 60000);
  return { day: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}
function prettyDate(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MIN * 60000)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const NEWSLETTER_PROMPT = `You are the editor of a personal daily newsletter. You are given the last 24 hours of reports that an AI research team wrote for ONE reader: market/news briefings and "mission" reports (e.g. crypto watch, portfolio watch, research digests, job hunting).
Edit them into ONE issue. Merge duplicates across reports, keep the strongest and most concrete items, drop filler, failures and anything with no real content. Keep numbers, names, dates exactly as given — never invent a figure, source or URL.

Write markdown in EXACTLY this shape (the app renders it as swipeable cards and a PDF):

# FinChat Daily — {DATE}

One or two sentences on what defined the day.

## Executive Summary
3-5 bullets, the strongest signals first. Each bullet starts with a **bold short label**.

## [Section name, e.g. Markets, AI & Research, Crypto, Your Portfolio, Your Job Search]
### [Story headline, max 8 words]
#### [One-line subtitle]
60-110 words of analysis with the concrete numbers. Cite sources inline as [Source][N] using the reference numbers you define at the bottom.
**Why it matters** — one or two sentences for this reader.
*In short: [3-6 word tagline]*

(Use 2-4 sections and 5-8 stories in total. Portfolio and job-search items are the reader's own — give them their own section when present, keep names of companies/roles, never recommend buying or selling anything.)

## 🎯 Key Takeaway
One paragraph connecting the day.

[1]: https://... "Title"
[2]: https://... "Title"
(Only URLs that appear in the reports. If there are none, omit this list.)`;

async function gatherSources(userId, since) {
  const r = await query(`
    SELECT notification_id, type, title, content, created_at
    FROM notifications
    WHERE user_id = $1 AND created_at > $2
      AND (type = 'briefing' OR (type = 'mission' AND title LIKE '%Mission report:%'))
      AND length(coalesce(content, '')) > 200
    ORDER BY created_at ASC
  `, [userId, since]);
  return r.rows;
}

function sourcesBlock(sources) {
  const per = Math.max(2500, Math.floor(INPUT_BUDGET / Math.max(1, sources.length)));
  return sources.map((s, i) => {
    const body = String(s.content || '');
    return `=== REPORT ${i + 1}: ${s.title} (${new Date(s.created_at).toISOString().slice(0, 16)}Z) ===\n` +
      (body.length > per ? body.slice(0, per) + '\n[…truncated]' : body);
  }).join('\n\n').slice(0, INPUT_BUDGET + 4000);
}

// When the editor is unavailable the issue still goes out: the latest briefing
// is already card-shaped; otherwise each report becomes one section.
function fallbackIssue(sources, date) {
  const brief = [...sources].reverse().find(s => s.type === 'briefing');
  if (brief) return brief.content;
  return `# FinChat Daily — ${date}\n\nToday's reports from your agents.\n\n` +
    sources.map(s => `## ${s.title.replace(/^[^\p{L}\p{N}]+/u, '')}\n\n${String(s.content).slice(0, 3000)}`).join('\n\n') +
    `\n\n## 🎯 Key Takeaway\n\nThe full reports are in the FinChat app.`;
}

async function composeIssue(sources, { date = prettyDate(), runInference } = {}) {
  require('../../../frontend/report_cards.js');
  const RC = globalThis.ReportCards;
  const infer = runInference || require('../inference').runInference;
  try {
    const res = await infer({
      messages: [
        { role: 'system', content: NEWSLETTER_PROMPT.replace('{DATE}', date) },
        { role: 'user', content: sourcesBlock(sources) }
      ],
      temperature: 0.3,
      // Same pool as the Telegram editor: the SHARED keys. Routing this through a
      // user's BYOK key once spent that key's daily allowance on background work.
      feature: 'newsletter',
      workload: 'mission'
    });
    let md = String(res.content || '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
    // RC.has also demands 900+ chars; a short issue on a quiet day is still an issue.
    const shaped = /^#\s+\S/m.test(md) && (md.match(/^#{2,3}\s+\S/gm) || []).length >= 3;
    if (RC.has(md) || shaped) return { markdown: md, edited: true };
    console.warn('⚠️ [Newsletter] editor output was not issue-shaped; using fallback');
  } catch (err) {
    console.warn(`⚠️ [Newsletter] editor failed: ${err.message}`);
  }
  return { markdown: fallbackIssue(sources, date), edited: false };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function caption({ title, date, stories }) {
  const base = String(process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const lines = [`<b>${escapeHtml(title || 'FinChat Daily')}</b> · ${escapeHtml(date || prettyDate())}`];
  if (stories.length) {
    lines.push('', `<i>In this issue</i>`);
    stories.slice(0, 6).forEach((s, i) => lines.push(`${i + 1}. ${escapeHtml(s)}`));
  }
  if (/^https:\/\//i.test(base)) lines.push('', `<a href="${escapeHtml(base)}/finchat_chat.html">Open FinChat</a>`);
  return lines.join('\n').slice(0, 1000); // Telegram caps captions at 1024
}

/**
 * Build and send one user's issue. `force` rebuilds today's even if it was
 * already sent (the Settings "send now" button). Returns a summary object.
 */
async function sendNewsletter(userId, { force = false, now = new Date(), deps = {} } = {}) {
  const channels = deps.channels || require('../notificationChannels');
  const prefs = await channels.getPrefs(userId);
  if (!prefs || !prefs.channel_telegram || !prefs.telegram_chat_id) {
    return { status: 'skipped', detail: 'Telegram is not linked or is turned off' };
  }
  const { day } = istParts(now);

  // Claim the day. A forced send takes the row over; a scheduled one only
  // proceeds when it inserted the row itself.
  const claim = force
    ? await query(`
        INSERT INTO newsletters (user_id, day, status) VALUES ($1, $2, 'building')
        ON CONFLICT (user_id, day) DO UPDATE SET status = 'building', detail = NULL, created_at = now()
        RETURNING day`, [userId, day])
    : await query(`
        INSERT INTO newsletters (user_id, day, status) VALUES ($1, $2, 'building')
        ON CONFLICT (user_id, day) DO NOTHING RETURNING day`, [userId, day]);
  if (!claim.rows.length) return { status: 'skipped', detail: 'Already handled today' };

  const finish = (status, detail, extra = {}) => query(`
    UPDATE newsletters SET status = $3, detail = $4, title = $5, markdown = $6, source_count = $7,
      pages = $8, bytes = $9, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END
    WHERE user_id = $1 AND day = $2
  `, [userId, day, status, detail, extra.title || null, extra.markdown || null,
      extra.sources || 0, extra.pages || null, extra.bytes || null]);

  try {
    const since = new Date(now.getTime() - WINDOW_HOURS * 3600e3);
    const sources = await gatherSources(userId, since);
    if (!sources.length) {
      await finish('empty', 'No briefings or mission reports in the last 24h');
      return { status: 'empty', detail: 'Nothing to send today' };
    }
    const date = prettyDate(now);
    const { markdown, edited } = await composeIssue(sources, { date, runInference: deps.runInference });
    const { renderNewsletterPdf } = require('./pdf');
    const pdf = await renderNewsletterPdf(markdown, { subject: `Daily newsletter for ${date}` });
    const filename = `FinChat-Daily-${day}.pdf`;
    await channels.sendTelegramDocument(prefs.telegram_chat_id, pdf.buffer, filename,
      caption({ title: pdf.title || 'FinChat Daily', date: pdf.date || date, stories: pdf.stories }));
    const detail = `Daily newsletter PDF · ${pdf.pages} cards · ${sources.length} report(s)${edited ? '' : ' · unedited fallback'}`;
    await finish('sent', detail, { title: pdf.title, markdown, sources: sources.length, pages: pdf.pages, bytes: pdf.buffer.length });
    // Show it in Settings → Delivery log next to the per-report decisions.
    if (channels.logDelivery) {
      await channels.logDelivery({ notificationId: null, userId, channel: 'telegram', destination: prefs.telegram_chat_id,
        status: 'sent', detail, payload: markdown.slice(0, 4000), importance: null });
    }
    console.log(`📰 [Newsletter] ${userId.slice(0, 8)} → Telegram: ${detail}`);
    return { status: 'sent', detail, pages: pdf.pages, bytes: pdf.buffer.length, sources: sources.length, edited };
  } catch (err) {
    await finish('failed', err.message).catch(() => {});
    console.error(`❌ [Newsletter] ${userId.slice(0, 8)} failed: ${err.message}`);
    return { status: 'failed', detail: err.message };
  }
}

/** Called from the cron tick: send every issue that is due and not yet claimed. */
async function runDueNewsletters({ now = new Date() } = {}) {
  if (String(process.env.NEWSLETTER_ENABLED || 'true').toLowerCase() === 'false') return { skipped: 'disabled' };
  if (!process.env.TELEGRAM_BOT_TOKEN) return { skipped: 'telegram unconfigured' };
  const { day, hour } = istParts(now);
  if (hour < HOUR_IST) return { skipped: `before ${HOUR_IST}:00 IST` };
  const due = await query(`
    SELECT p.user_id FROM notification_preferences p
    WHERE p.channel_telegram = true AND p.telegram_chat_id IS NOT NULL AND p.telegram_chat_id <> ''
      AND NOT (coalesce(p.muted_types, '[]'::jsonb) ? 'newsletter')
      AND NOT EXISTS (SELECT 1 FROM newsletters n WHERE n.user_id = p.user_id AND n.day = $1)
    LIMIT $2
  `, [day, MAX_USERS_PER_TICK]);
  const results = [];
  for (const { user_id } of due.rows) results.push({ userId: user_id, ...(await sendNewsletter(user_id, { now })) });
  return { day, results };
}

module.exports = { sendNewsletter, runDueNewsletters, composeIssue, gatherSources, istParts, caption, HOUR_IST };
