// tools/GmailTool.js — read the user's JOB mail, and nothing else.
//
// The design constraint here is not "be careful", it is "make the other thing
// impossible". The user's inbox is thousands of ordinary personal messages; an
// agent given a mailbox and told to behave will eventually be asked, or will
// decide, to look at one of them.
//
// So the Gmail query is BUILT HERE, never supplied by the model:
//   • every search is AND-ed with a closed, code-defined sender filter
//   • the model's keywords are stripped of every character that could form a
//     Gmail operator, so `from:mum` or `label:banking` cannot be smuggled in
//   • reading one message re-checks that message's sender against the same
//     filter, so a message id from anywhere else is refused
//
// The OAuth scope backing this is gmail.readonly. There is no path in this file
// that sends, deletes, labels, or modifies anything.
const axios = require('axios');
const { getAccessToken, touch, status } = require('../services/googleOAuth');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Who is allowed to appear in `from:`. Gmail matches these as substrings of the
// address, so a domain covers its subdomains and an address keyword covers the
// ATS mail that MNCs actually send from — Deloitte's alerts arrive from
// southasiacareers.deloitte.com, which no fixed domain list would catch.
const SENDER_TERMS = [
  // Job boards
  'linkedin.com', 'indeed.com', 'naukri.com', 'internshala.com', 'foundit.in',
  'instahyre.com', 'glassdoor.com', 'wellfound.com', 'angel.co', 'hirist.com',
  'cutshort.io', 'shine.com', 'timesjobs.com', 'monsterindia.com', 'adzuna',
  'remotive.com', 'weworkremotely.com', 'workatastartup.com',
  // Applicant tracking systems — how a large employer's mail reaches you
  'greenhouse.io', 'lever.co', 'myworkday.com', 'workday.com', 'ashbyhq.com',
  'smartrecruiters.com', 'jobvite.com', 'icims.com', 'taleo.net',
  'successfactors.com', 'recruitee.com', 'teamtailor.com',
  // Address keywords, for employer mail sent from their own domain
  'careers', 'career', 'jobs', 'jobalert', 'recruit', 'recruiting', 'recruiter',
  'talent', 'hiring', 'campus', 'placements'
];

// Gmail operators are `word:value`; strip the punctuation that forms them and
// no keyword can become one. Quotes and parens go too, so a keyword cannot
// close the group it sits inside and OR its way out of the sender filter.
function sanitizeKeywords(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')      // letters, digits, space, hyphen only
    .split(/\s+/)
    .filter(w => w && !/^(or|and|not)$/i.test(w)) // no boolean glue either
    .slice(0, 8)
    .join(' ')
    .trim();
}

function buildQuery({ days, keywords }) {
  const parts = [
    `from:(${SENDER_TERMS.join(' OR ')})`,
    `newer_than:${days}d`,
    '-in:spam',
    '-in:trash'
  ];
  const kw = sanitizeKeywords(keywords);
  if (kw) parts.push(`(${kw.split(' ').join(' OR ')})`);
  return parts.join(' ');
}

// Does this address belong to someone the filter allows? Used to re-verify on
// read, because a message id is just a string the model could have got anywhere.
function senderAllowed(fromHeader = '') {
  const addr = String(fromHeader).toLowerCase();
  return SENDER_TERMS.some(t => addr.includes(t.toLowerCase()));
}

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
  }
  const m = s.match(/^(list|read|status)\b\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase(), messageId: m[2].trim() || undefined };
  return { action: 'list' };
}

function header(msg, name) {
  const hs = (msg.payload && msg.payload.headers) || [];
  const h = hs.find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

const decode = (b64) => Buffer.from(String(b64).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

// Walk the MIME tree for readable text. Prefer text/plain; fall back to HTML
// with the tags removed, because job alerts are very often HTML-only.
function extractBody(payload) {
  if (!payload) return '';
  const stack = [payload];
  let html = '';
  while (stack.length) {
    const p = stack.pop();
    const data = p.body && p.body.data;
    if (data && p.mimeType === 'text/plain') return decode(data);
    if (data && p.mimeType === 'text/html' && !html) html = decode(data);
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return html
    ? html.replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim()
    : '';
}

// Application links worth acting on, pulled out of the body so the agent does
// not have to parse a marketing email to find the one URL that matters.
function extractLinks(text, limit = 12) {
  const urls = String(text).match(/https?:\/\/[^\s<>"')]+/g) || [];
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const clean = u.replace(/[.,;]+$/, '');
    if (seen.has(clean)) continue;
    // Tracking pixels and unsubscribe links are noise, not opportunities.
    if (/unsubscribe|optout|opt-out|\.(png|gif|jpg|css)(\?|$)/i.test(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

async function api(path, accessToken, params = {}) {
  const res = await axios.get(`${API}${path}`, {
    params, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
  });
  return res.data;
}

async function execute(input, context = {}) {
  const opts = parseInput(input);
  const action = String(opts.action || 'list').toLowerCase();
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Reading mail requires a signed-in user.');
  }

  if (action === 'status') {
    return { action, ...(await status(userId)) };
  }

  const accessToken = await getAccessToken(userId);
  if (!accessToken) {
    const st = await status(userId);
    return {
      action,
      connected: false,
      error: st.configured
        ? 'The user has not connected Gmail (or the grant was revoked). Ask them to connect it on the Settings page — you cannot do it for them.'
        : 'Gmail is not configured on this deployment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are unset). Tell the user plainly rather than pretending to search.'
    };
  }

  if (action === 'list') {
    const days = Math.min(Math.max(Number(opts.days) || 14, 1), 90);
    const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 25);
    const q = buildQuery({ days, keywords: opts.keywords || opts.query });

    const listed = await api('/messages', accessToken, { q, maxResults: limit });
    const ids = (listed.messages || []).map(m => m.id);
    await touch(userId);

    if (!ids.length) {
      return {
        action, connected: true, count: 0, messages: [], filter: q,
        note: `No job mail in the last ${days} days matching the filter. This searched ONLY job boards, ATS senders and careers addresses — it is not a search of the whole mailbox, and it cannot be widened.`
      };
    }

    const metas = await Promise.all(ids.map(id =>
      api(`/messages/${id}`, accessToken, {
        format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date']
      }).catch(() => null)));

    const messages = metas.filter(Boolean).map(m => ({
      messageId: m.id,
      from: header(m, 'From'),
      subject: header(m, 'Subject'),
      date: header(m, 'Date'),
      snippet: m.snippet
    }));

    return {
      action, connected: true, count: messages.length, messages, filter: q,
      note: 'Metadata only. Use {"action":"read","messageId":"…"} to open one and get its postings and links. Log anything worth pursuing with the applications tool.'
    };
  }

  if (action === 'read') {
    const id = String(opts.messageId || opts.id || '').trim();
    if (!id) throw new Error('Reading a message needs {"action":"read","messageId":"…"} — get ids from action "list".');

    let msg;
    try {
      msg = await api(`/messages/${id}`, accessToken, { format: 'full' });
    } catch (err) {
      const code = err.response && err.response.status;
      if (code === 404) return { action, error: `No message with id "${id}" — list again, ids are not stable guesses.` };
      throw err;
    }

    // The filter applies to reads too. Without this check the tool is a
    // read-anything primitive that merely happens to be listed narrowly: a
    // message id from any other source would open any mail in the account.
    const from = header(msg, 'From');
    if (!senderAllowed(from)) {
      return {
        action,
        error: `That message is not from a job sender (${from || 'unknown sender'}), so it is outside what this tool may read. Only mail matching the job-alert filter can be opened.`
      };
    }

    await touch(userId);
    const body = extractBody(msg.payload);
    return {
      action,
      connected: true,
      messageId: msg.id,
      from,
      subject: header(msg, 'Subject'),
      date: header(msg, 'Date'),
      // Capped: a marketing-heavy job alert can be tens of thousands of
      // characters, and every one of them would be re-sent on each later turn.
      body: body.slice(0, 6000),
      truncated: body.length > 6000,
      links: extractLinks(body),
      note: 'Read-only. Extract the roles and application URLs, check them against the user\'s profile, and log the worthwhile ones with the applications tool. Never reply to this mail or apply on the user\'s behalf.'
    };
  }

  throw new Error(`Unknown gmail action "${action}". Use list, read or status.`);
}

module.exports = { execute, buildQuery, sanitizeKeywords, senderAllowed, SENDER_TERMS };
