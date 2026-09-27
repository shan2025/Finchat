// services/inboxJobMatcher.js — job alerts in the inbox → postings scored
// against the stored resume → application drafts for the strong ones.
//
// This is one tool call on purpose. The daily hunt used to chain it by hand:
// gmail list → gmail read → score → apply_draft. But a mission writes its whole
// plan before any step runs, so the read step could only name "the most
// relevant message" and the draft step "the top match" — placeholders. Every
// recorded run through 2026-09-27 listed the inbox, opened nothing, and the
// cover letter failed on a placeholder posting. Doing the chain in code means
// each step gets the real output of the one before it.
//
// Nothing here applies anywhere. Postings are scored and drafted; submitting
// stays the user's action, and the ledger records them as drafted/shortlisted.

// Links and resume are capped so one run's prompt stays near 8–10k tokens.
const BODY_CHARS = 2500;
const RESUME_CHARS = 4000;
const LINKS_PER_MESSAGE = 12;

const MATCH_PROMPT = `You match job postings from job-alert emails to one candidate.

Each EMAIL below has an index and a numbered list of LINKS. Find every distinct job posting in the emails. For each one return:
- "email": the email index it came from
- "title", "company", "location" exactly as the email states them ("" if not stated)
- "link": the id of the link that opens THAT posting (e.g. "2.4"), or null if none clearly does. Only use ids from the lists. Never build or guess a URL.
- "summary": what the email says about the role, at most 200 characters
- "score": 0-100 fit against the RESUME and the INTERESTS. Seniority matters: a role asking for far more experience than the resume shows scores under 50. A role outside the interests scores under 50.
- "why": one sentence naming the resume evidence that fits
- "gaps": one short phrase on what the resume lacks for it ("" if nothing)

Skip course promotions, newsletters and "people also viewed" filler — only real openings.
Reply with JSON only: {"postings":[...]}`;

function clampScore(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

// Alert links carry per-email tracking, so the same LinkedIn job arrives under a
// different URL every day and the ledger's URL dedupe never fires. Reduce the
// boards we know to their stable posting address.
function canonicalUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return raw; }
  const host = u.hostname.toLowerCase();
  const li = host.endsWith('linkedin.com') && u.pathname.match(/\/jobs\/view\/(\d+)/);
  if (li) return `https://www.linkedin.com/jobs/view/${li[1]}/`;
  if (host.includes('indeed.') && u.searchParams.get('jk')) {
    return `https://${host}/viewjob?jk=${u.searchParams.get('jk')}`;
  }
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|trk|tracking|refid|ref$|src$|mid$|midtoken|eid$|otptoken)/i.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

function sourceOf(from = '') {
  const s = String(from).toLowerCase();
  for (const b of ['linkedin', 'naukri', 'indeed', 'internshala', 'foundit', 'instahyre', 'glassdoor', 'wellfound', 'hirist', 'cutshort']) {
    if (s.includes(b)) return b;
  }
  return 'email';
}

function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// Turn the model's postings into rows we trust: links resolved only from the
// ids we handed out, scores clamped, duplicates (same posting in two alerts)
// merged keeping the higher score.
function normalizePostings(raw, emails) {
  const byKey = new Map();
  for (const p of Array.isArray(raw) ? raw : []) {
    const title = String(p.title || '').trim();
    if (!title) continue;
    const email = emails[Number(p.email)] || null;
    let url = null;
    const m = String(p.link || '').match(/^(\d+)\.(\d+)$/);
    if (m) {
      const e = emails[Number(m[1])];
      const link = e && e.links[Number(m[2]) - 1];
      if (link) url = canonicalUrl(link);
    }
    const row = {
      title,
      company: String(p.company || '').trim() || null,
      location: String(p.location || '').trim() || null,
      url,
      source: email ? sourceOf(email.from) : 'email',
      summary: String(p.summary || '').slice(0, 240),
      score: clampScore(p.score),
      why: String(p.why || '').slice(0, 300),
      gaps: String(p.gaps || '').slice(0, 160)
    };
    const key = url || `${title}|${row.company || ''}`.toLowerCase();
    const prev = byKey.get(key);
    if (!prev || row.score > prev.score) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

async function defaultInfer({ messages, userId }) {
  const { runInference } = require('./inference');
  const r = await runInference({
    messages, temperature: 0.1, jsonMode: true,
    workload: 'mission', feature: 'inbox_job_match', agentId: 'rasha', userId
  });
  return { content: r && r.content, tokens: (r && r.tokens) || 0 };
}

// Postings the ledger already holds, so tomorrow's run does not redraft today's.
async function defaultKnown(userId, postings) {
  const { query } = require('../database');
  const res = await query(`
    SELECT url, lower(role) AS role, lower(COALESCE(company, '')) AS company
      FROM job_applications
     WHERE user_id = $1 AND created_at > now() - interval '60 days'`, [userId]);
  const urls = new Set(res.rows.map(r => r.url).filter(Boolean));
  const names = new Set(res.rows.map(r => `${r.role}|${r.company}`));
  return postings.map(p =>
    (p.url && urls.has(p.url)) || names.has(`${p.title.toLowerCase()}|${(p.company || '').toLowerCase()}`));
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {number} [opts.days=2]        look-back window for alerts
 * @param {number} [opts.maxRead=8]     how many alert emails to open
 * @param {string} [opts.interests]     roles/locations/seniority the user wants
 * @param {number} [opts.minScore=70]   below this a posting is reported, not drafted
 * @param {number} [opts.maxDrafts=3]   cover letters per run (each is an inference call)
 * @param {object} [deps]               { gmail, infer, loadResume, known, draft, log } for tests
 */
async function matchInbox(opts = {}, deps = {}) {
  const userId = opts.userId;
  const context = { userId, missionId: opts.missionId || null };
  const days = Math.min(Math.max(Number(opts.days) || 2, 1), 30);
  const maxRead = Math.min(Math.max(Number(opts.maxRead) || 8, 1), 12);
  const minScore = Math.min(Math.max(Number(opts.minScore) || 70, 40), 95);
  const maxDrafts = Math.min(Math.max(Number(opts.maxDrafts ?? 3), 0), 5);
  const interests = String(opts.interests || '').slice(0, 600);

  const gmail = deps.gmail || require('../tools/GmailTool').execute;
  const loadResume = deps.loadResume || (id => require('../tools/ResumeTool').loadStored(id));
  const infer = deps.infer || defaultInfer;
  const known = deps.known || defaultKnown;
  const draft = deps.draft || ((input, ctx) => require('../tools/ApplyDraftTool').execute(input, ctx));
  const log = deps.log || ((input, ctx) => require('../tools/ApplicationsTool').execute(input, ctx));

  const resume = await loadResume(userId);
  if (!resume || !String(resume.content || '').trim()) {
    return {
      action: 'match', connected: true, matches: [],
      error: 'No resume on file, so there is nothing to match the alerts against. Ask the user to share their resume and save it with the resume tool.'
    };
  }

  const listed = await gmail({ action: 'list', days, limit: 25 }, context);
  if (listed.connected === false || listed.error) return { action: 'match', ...listed, matches: [] };
  if (!listed.count) {
    return { action: 'match', connected: true, scanned: 0, matches: [], note: `No job alerts in the last ${days} day(s).` };
  }

  // Opened in parallel; an alert that fails to open is skipped, not fatal.
  const toRead = listed.messages.slice(0, maxRead);
  const opened = await Promise.all(toRead.map(m =>
    gmail({ action: 'read', messageId: m.messageId }, context).catch(() => null)));
  const emails = opened
    .filter(r => r && !r.error && r.body)
    .map(r => ({
      from: r.from, subject: r.subject,
      body: String(r.body).slice(0, BODY_CHARS),
      links: (r.links || []).slice(0, LINKS_PER_MESSAGE)
    }));
  if (!emails.length) {
    return { action: 'match', connected: true, scanned: listed.count, read: 0, matches: [], note: 'Alerts were listed but none could be opened.' };
  }

  const emailBlock = emails.map((e, i) =>
    `EMAIL ${i} — from ${e.from} — "${e.subject}"\n${e.body}\nLINKS:\n` +
    e.links.map((l, j) => `  ${i}.${j + 1} ${l}`).join('\n')).join('\n\n');
  const out = await infer({
    userId,
    messages: [
      { role: 'system', content: MATCH_PROMPT },
      {
        role: 'user',
        content: `RESUME:\n${String(resume.content).slice(0, RESUME_CHARS)}\n\n` +
          `INTERESTS: ${interests || resume.target_role || 'infer from the resume'}\n\n${emailBlock}`
      }
    ]
  });
  const parsed = parseJson(out && out.content);
  if (!parsed) {
    throw new Error('The matcher returned no readable postings (model output was not JSON).');
  }

  const postings = normalizePostings(parsed.postings, emails);
  const seen = await known(userId, postings);
  postings.forEach((p, i) => { p.alreadyInLedger = !!seen[i]; });

  const strong = postings.filter(p => p.score >= minScore);
  const toDraft = strong.filter(p => p.url && !p.alreadyInLedger).slice(0, maxDrafts);

  // Drafts run in parallel: each is its own inference call, and in sequence
  // three of them were most of a run's wall-clock budget.
  const drafts = await Promise.all(toDraft.map(p => draft({
    job: {
      title: p.title, company: p.company, url: p.url, location: p.location, source: p.source,
      description: `${p.summary}\nWhy it fits: ${p.why}${p.gaps ? `\nGaps: ${p.gaps}` : ''}`
    }
  }, context).then(r => ({ ok: true, draft: r.draft }), e => ({ ok: false, error: e.message }))));
  toDraft.forEach((p, i) => {
    p.status = drafts[i].ok ? 'drafted' : 'shortlisted';
    if (drafts[i].ok) p.draft = drafts[i].draft;
    else p.draftError = drafts[i].error;
  });

  // Every strong posting with a link goes in the ledger, with its score. A row
  // the draft already created keeps status 'drafted' (the ledger's upsert does
  // not touch status) and gains the score and notes.
  const toLog = strong.filter(p => p.url && !p.alreadyInLedger);
  for (const p of toLog) if (!p.status) p.status = 'shortlisted';
  if (toLog.length) {
    await log({
      action: 'log',
      jobs: toLog.map(p => ({
        role: p.title, company: p.company, location: p.location, url: p.url, source: p.source,
        status: 'shortlisted', matchScore: p.score, notes: [p.why, p.gaps && `Gaps: ${p.gaps}`].filter(Boolean).join(' ')
      }))
    }, context).catch(() => null);
  }
  for (const p of strong) if (!p.status) p.status = p.alreadyInLedger ? 'already_in_ledger' : 'no_link';

  return {
    action: 'match',
    connected: true,
    scanned: listed.count,
    read: emails.length,
    postingsFound: postings.length,
    minScore,
    matches: strong.map(p => ({
      title: p.title, company: p.company, location: p.location, url: p.url, source: p.source,
      score: p.score, why: p.why, gaps: p.gaps, status: p.status,
      ...(p.draft ? { draft: p.draft } : {}), ...(p.draftError ? { draftError: p.draftError } : {})
    })),
    belowThreshold: postings.filter(p => p.score < minScore)
      .slice(0, 8).map(p => ({ title: p.title, company: p.company, score: p.score, gaps: p.gaps })),
    note: 'Drafted and shortlisted postings are logged in the applications ledger. Nothing was submitted — the user applies from each url.'
  };
}

module.exports = { matchInbox, normalizePostings, canonicalUrl, parseJson, MATCH_PROMPT };
