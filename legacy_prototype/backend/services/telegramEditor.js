// services/telegramEditor.js — decides what reaches Telegram, and in what shape.
//
// Telegram used to receive every mission report and briefing verbatim. In the
// week to 13 Sep 2026 that was 63 reports, ~402,000 characters and ~130
// message bubbles: a crypto brief every six hours whether or not anything had
// moved, research digests of up to 17k characters, and 16 reports whose main
// content was that their data feeds were "unavailable". Nothing read them
// before they were sent.
//
// Now each long report passes through here first:
//
//   1. One small inference call scores it 1–5 against the LAST card sent on
//      the same topic, and writes a headline plus at most three points.
//   2. Deterministic guards then refuse to trust that call where it matters:
//      a report that is mostly "unavailable" is held whatever the score, any
//      point quoting a number that is not in the report is dropped, and email
//      addresses / phone numbers are scrubbed (a job report once carried a full
//      cover letter with both).
//   3. The score decides delivery: 5 sends with sound (at most three a day),
//      4 sends silently, 1–3 is held. Held reports stay in the app; nothing is
//      lost. A first cut that also sent 3s and rang on 4s would still have
//      buzzed 9 times for the last 15 real reports.
//
// Notifications that are not reports (test pings, fraud alerts) pass straight
// through, formatted.
//
// The reviewer failing must never cost the user a report, so an inference
// error falls back to a deterministic excerpt sent silently.

const { toPlainText, escapeHtml } = require('./markdown');

// Every mission and briefing notification is reviewed, however short: a
// 288-character "could you let me pull that data?" is a failed run dressed as a
// report, and it is exactly what should not buzz a phone.
const REVIEWED_TYPES = new Set(['mission', 'briefing']);
const SEND_WITH_SOUND = 5;
const SEND_SILENTLY = 4;
// A reviewer that rates everything "new" would still ring all day. However a
// report scores, only this many alerts per rolling 24h make a sound; the rest
// arrive silently.
const MAX_ALERTS_PER_DAY = 3;
const MIN_CHARS_FOR_UNREVIEWED_SEND = 1500;
const MAX_POINTS = 3;
const MAX_POINT_CHARS = 180;
const MAX_HEADLINE_CHARS = 200;
// "PRICE UNAVAILABLE (24H CHANGE UNAVAILABLE)" three times over was a whole
// crypto brief on 13 Sep. Three mentions is where a report stops being a report.
const UNAVAILABLE_HOLD_COUNT = 3;

const REVIEW_PROMPT = `You are the editor deciding which reports are worth a phone notification.
The reader is busy. They want only what is valuable and new; everything else stays in the app.

Score the REPORT 1-5. Most reports are 2 or 3. Only give 4 or 5 for something concrete.
5 = needs attention today: a specific job opening that fits and can be applied to, a price move of 5% or more, a decision or deadline that has happened or lands within 48 hours, or a notice that a mission was disabled
4 = a concrete new development they would want to know today — an event, decision or number that is NOT in the LAST MESSAGE SENT
3 = useful background: commentary, research summaries, outlooks, "watch" items, moves under 5%
2 = routine, or mostly repeats the LAST MESSAGE SENT
1 = little substance: data missing, tools failed, the run asked a question or apologised instead of reporting, generic commentary

Then write the message:
- "headline": one plain sentence, max 25 words, the single most important thing
- "points": 0-3 short points, max 25 words each, only facts that matter; none if the headline says it all
- "action": one short line if there is something to do or watch, else ""
- "reason": max 12 words, why this score

Rules: copy every number EXACTLY as it appears in the report; never add facts, names or numbers that are not in the report; no emojis; no markdown; no source lists; no disclaimers.
Reply with JSON only: {"importance":n,"reason":"","headline":"","points":[],"action":""}`;

// ── pure helpers (exported for tests) ────────────────────────

/** Topic name without the emoji and "Mission report:" framing. */
function topicLabel(title) {
  return String(title || 'FinChat')
    .replace(/^[^\p{L}\p{N}]+/u, '')            // leading emoji / symbols
    .replace(/^Mission report:\s*/i, '')
    .trim() || 'FinChat';
}

function countUnavailable(text) {
  return (String(text).match(/\bunavailable\b/gi) || []).length;
}

// Numbers as they appear in prose: 77,275.50 · 0.15 · 108 · 2026.
const NUM_RX = /\d[\d,]*(?:\.\d+)?/g;

function numbersIn(text) {
  return (String(text).match(NUM_RX) || [])
    .map(s => s.replace(/,/g, ''))
    .filter(s => /^\d+(\.\d+)?$/.test(s));
}

/**
 * True when every number in `line` appears in the source report, allowing a
 * value rounded to fewer decimals (77,275 from 77,275.50). A summariser that
 * invents or garbles a figure loses the line rather than mis-stating a price.
 */
function isGrounded(line, sourceNumbers) {
  for (const n of numbersIn(line)) {
    const decimals = (n.split('.')[1] || '').length;
    const value = Number(n);
    const found = sourceNumbers.some(s => {
      const sv = Number(s);
      return s === n || sv.toFixed(decimals) === value.toFixed(decimals) ||
        (decimals === 0 && Math.round(sv) === value);
    });
    if (!found) return false;
  }
  return true;
}

const EMAIL_RX = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// +91 75939 48066, 7593948066, (555) 123-4567 — 10+ digits once separators go.
const PHONE_RX = /\+?\(?\d[\d\s().-]{8,}\d/g;

// A single number written with a decimal point or thousands separators —
// 0.000009876, 1,800,000,000 — is a price or a count, however many digits it
// has. Scrubbing those erased a sub-cent token price from a portfolio alert.
const PLAIN_NUMBER_RX = /^(?=.*[.,])\d[\d,]*(?:\.\d+)?$/;

function scrubPersonal(text) {
  return String(text)
    .replace(EMAIL_RX, '[email removed]')
    .replace(PHONE_RX, m => {
      const t = m.trim();
      if (PLAIN_NUMBER_RX.test(t)) return m;
      return t.replace(/\D/g, '').length >= 10 ? '[phone removed]' : m;
    });
}

function clip(s, max) {
  // Citation markers point at a source list the card does not carry.
  const t = String(s || '').replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** First one or two sentences of the report's takeaway, else its opening. */
function fallbackHeadline(plain) {
  const take = /KEY TAKEAWAY\s*\n+([\s\S]+?)(?:\n\s*\n|$)/i.exec(plain);
  const para = take ? take[1] : (plain.split(/\n\s*\n/).find(p => p.trim().length > 60) || plain);
  // Split only where punctuation is followed by a space, so "+0.15%" and
  // "$77,386.50" stay whole ("Bitcoin's flat +0." was the first attempt).
  const sentences = para.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  return clip(sentences.slice(0, 2).join(' '), MAX_HEADLINE_CHARS + 80);
}

// Field-by-field salvage for JSON that is almost right. DeepSeek returned
// {"importance":1, …,"action":"","} for a failed run — a correct "hold"
// verdict that strict parsing threw away, so the fallback sent the failure.
function salvageReview(s) {
  const str = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(s);
    if (!m) return '';
    try { return JSON.parse(`"${m[1]}"`); } catch (_) { return m[1]; }
  };
  const imp = /"importance"\s*:\s*"?(\d)/.exec(s);
  const pts = /"points"\s*:\s*\[([\s\S]*?)\]/.exec(s);
  const points = pts ? (pts[1].match(/"(?:[^"\\]|\\.)*"/g) || []).map(q => {
    try { return JSON.parse(q); } catch (_) { return q.slice(1, -1); }
  }) : [];
  return {
    importance: imp ? Number(imp[1]) : NaN,
    reason: str('reason'), headline: str('headline'), points, action: str('action')
  };
}

function parseReview(raw) {
  if (!raw) return null;
  const s = String(raw);
  let j = null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { j = JSON.parse(s.slice(start, end + 1)); } catch (_) { j = null; }
  }
  if (!j) j = salvageReview(s);
  const importance = Math.round(Number(j.importance));
  if (!(importance >= 1 && importance <= 5)) return null;
  return {
    importance,
    reason: clip(j.reason, 120),
    headline: String(j.headline || ''),
    points: Array.isArray(j.points) ? j.points.map(String) : [],
    action: String(j.action || '')
  };
}

/**
 * Turn a review into the card. Returns the Telegram HTML plus a plain-text
 * rendering of the same words, which is what the delivery log stores.
 */
function buildCard({ title, review, sourcePlain, link }) {
  const sourceNumbers = numbersIn(sourcePlain);
  const keep = (line, max) => {
    const t = clip(scrubPersonal(line), max);
    return t && isGrounded(t, sourceNumbers) ? t : '';
  };

  const points = review.points.map(p => keep(p, MAX_POINT_CHARS)).filter(Boolean).slice(0, MAX_POINTS);
  let headline = keep(review.headline, MAX_HEADLINE_CHARS);
  if (!headline) headline = points.shift() || keep(fallbackHeadline(sourcePlain), MAX_HEADLINE_CHARS + 80);
  const action = keep(review.action, MAX_POINT_CHARS);

  const label = topicLabel(title);
  const html = [`<b>${escapeHtml(label)}</b>`, escapeHtml(headline)];
  const plain = [label, headline];
  if (points.length) {
    html.push('', ...points.map(p => `• ${escapeHtml(p)}`));
    plain.push('', ...points.map(p => `• ${p}`));
  }
  if (action) {
    html.push('', `<i>Next:</i> ${escapeHtml(action)}`);
    plain.push('', `Next: ${action}`);
  }
  if (link) {
    html.push('', `<a href="${escapeHtml(link)}">Read full report</a>`);
    plain.push('', `Full report: ${link}`);
  }
  return { html: html.join('\n'), text: plain.join('\n') };
}

/** Absolute URL for the full report, or null when there is no public origin. */
function reportLink(n) {
  const base = String(process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  // A localhost link is useless on a phone, so none is better than a dead one.
  if (!/^https:\/\//i.test(base)) return null;
  const path = n.link || `finchat_agents.html?report=${encodeURIComponent(n.notification_id)}`;
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

function decide(importance, alertsToday = 0) {
  if (importance >= SEND_WITH_SOUND) return { send: true, silent: alertsToday >= MAX_ALERTS_PER_DAY };
  if (importance >= SEND_SILENTLY) return { send: true, silent: true };
  return { send: false, silent: true };
}

// ── IO ───────────────────────────────────────────────────────

/** Alerts (sent with sound) to this user's Telegram in the last 24 hours. */
async function alertsInLastDay(userId) {
  const { query } = require('../database');
  const res = await query(`
    SELECT COUNT(*)::int AS n FROM notification_deliveries
     WHERE user_id = $1 AND channel = 'telegram' AND status = 'sent'
       AND importance >= $2 AND detail LIKE 'Alert%'
       AND created_at > now() - interval '24 hours'
  `, [userId, SEND_WITH_SOUND]);
  return res.rows[0].n;
}

/** The last card actually sent to this user on the same topic, if any. */
async function lastSentOnTopic(n) {
  const { query } = require('../database');
  const sameTopic = n.type === 'briefing' ? 'n.type = $2' : 'n.title = $2';
  const res = await query(`
    SELECT d.payload, d.created_at
      FROM notification_deliveries d
      JOIN notifications n ON n.notification_id = d.notification_id
     WHERE d.user_id = $1 AND d.channel = 'telegram' AND d.status = 'sent'
       AND d.payload IS NOT NULL AND ${sameTopic}
       AND d.created_at > now() - interval '36 hours'
     ORDER BY d.created_at DESC
     LIMIT 1
  `, [n.user_id, n.type === 'briefing' ? 'briefing' : n.title]);
  return res.rows[0] || null;
}

// Deliberately NOT run on the user's own keys: this is delivery plumbing, not
// the user's agent work. Passing userId routed it through their BYOK Groq key,
// and a dry run over fifteen reports spent that key's daily allowance for the
// agents themselves. The shared mission route (DeepSeek first) has no daily
// cliff, and the fixed system prompt is prefix-cached.
async function defaultInfer({ messages }) {
  const { runInference } = require('./inference');
  const r = await runInference({
    messages, temperature: 0.1, jsonMode: true,
    workload: 'mission', feature: 'telegram_review'
  });
  return r && r.content;
}

/**
 * Decide what Telegram gets for one notification.
 * @param {object} n - notification row (notification_id, user_id, type, title, content, link)
 * @param {object} [deps] - { infer, previous, alertsToday } overrides for tests
 * @returns {Promise<{send:boolean, silent:boolean, html:string, text:string, importance:number|null, reason:string}>}
 */
async function reviewForTelegram(n, deps = {}) {
  const content = String(n.content || '');
  const plain = toPlainText(content);
  const link = reportLink(n);

  // Anything that is not a report (a test ping, a fraud alert) is already the
  // message.
  if (!REVIEWED_TYPES.has(n.type)) {
    const body = scrubPersonal(plain);
    const label = topicLabel(n.title);
    return {
      send: true, silent: false, importance: null, reason: 'short notification, sent as is',
      html: [`<b>${escapeHtml(label)}</b>`, escapeHtml(body)].filter(Boolean).join('\n'),
      text: [label, body].filter(Boolean).join('\n')
    };
  }

  const unavailable = countUnavailable(plain);

  let review = null;
  let reviewerError = null;
  try {
    const previous = deps.previous !== undefined ? deps.previous : await lastSentOnTopic(n);
    const infer = deps.infer || defaultInfer;
    const raw = await infer({
      userId: n.user_id,
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        {
          role: 'user',
          content:
            `TOPIC: ${topicLabel(n.title)}\n\n` +
            `LAST MESSAGE SENT on this topic: ${previous && previous.payload
              ? `(${new Date(previous.created_at).toISOString()})\n${previous.payload}` : '(none in the last 36 hours)'}\n\n` +
            `REPORT:\n${plain.slice(0, 12000)}`
        }
      ]
    });
    review = parseReview(raw);
    if (!review) reviewerError = 'reviewer returned no usable verdict';
  } catch (err) {
    reviewerError = `reviewer unavailable (${err.message})`;
  }

  if (!review) {
    // Unreviewed, a substantial report goes out as a quiet excerpt rather than
    // being lost. A short one is far more likely a failed run than news.
    review = plain.length >= MIN_CHARS_FOR_UNREVIEWED_SEND
      ? { importance: SEND_SILENTLY, reason: `${reviewerError}, sent a short excerpt`, headline: '', points: [], action: '' }
      : { importance: 1, reason: `${reviewerError}, and the report is too short to send unreviewed`, headline: '', points: [], action: '' };
  }

  let { importance, reason } = review;
  if (unavailable >= UNAVAILABLE_HOLD_COUNT) {
    importance = Math.min(importance, 1);
    reason = `data was unavailable ${unavailable} times in this report`;
  }

  let alertsToday = 0;
  if (importance >= SEND_WITH_SOUND) {
    try {
      alertsToday = deps.alertsToday !== undefined ? deps.alertsToday : await alertsInLastDay(n.user_id);
    } catch (_) { /* unknown count: let the alert through rather than lose it */ }
  }
  const decision = decide(importance, alertsToday);
  if (importance >= SEND_WITH_SOUND && decision.silent) {
    reason = `${reason} (sent silently: ${MAX_ALERTS_PER_DAY} alerts already today)`;
  }

  const card = buildCard({ title: n.title, review, sourcePlain: plain, link });
  return { ...decision, importance, reason, ...card };
}

module.exports = {
  reviewForTelegram,
  // exported for tests
  topicLabel, countUnavailable, numbersIn, isGrounded, scrubPersonal,
  parseReview, buildCard, decide, reportLink, fallbackHeadline,
  SEND_WITH_SOUND, SEND_SILENTLY, MAX_ALERTS_PER_DAY
};
