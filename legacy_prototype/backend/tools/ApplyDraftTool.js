// tools/ApplyDraftTool.js — turn a job posting into a tailored application
// package (cover letter + talking points + checklist). DRAFT ONLY: this tool
// never submits anything anywhere; actual submission stays a human action
// (unattended form-submission on third-party sites is out of scope by design).
const { runInference } = require('../services/inference');

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  return { job: s };
}

// The model frequently passes the posting FLAT — {role/title, company, url,
// description/requirements} — instead of the documented {job:{...}} wrapper,
// which used to throw "needs a job posting" and fail the whole mission. Accept
// both by folding the flat fields into a job object.
function coerceJob(opts) {
  if (opts.job != null && opts.job !== '') return opts;
  const flat = ['title', 'role', 'company', 'url', 'description', 'requirements', 'location', 'source'];
  if (flat.some(k => opts[k] != null)) {
    return {
      ...opts,
      job: {
        title: opts.title || opts.role,
        company: opts.company,
        url: opts.url,
        location: opts.location,
        source: opts.source,
        description: opts.description || opts.requirements || ''
      }
    };
  }
  return opts;
}

// A "posting" that is really an unfilled planner placeholder (e.g. "<Job URL>",
// "{{SELECTED_JOB_URL_FROM_STEPS_1_2_3}}", "<top_match_url>") only produces a
// letter full of angle-bracket gaps. Detect it on the identifying fields —
// which never legitimately contain these tokens — so we can send back an
// instruction the agent can act on instead of drafting garbage or looping.
function looksLikePlaceholder(s) {
  return /\{\{|<[^>]{1,60}>|SELECTED_JOB|TOP_MATCH|_FROM_STEP/i.test(String(s || ''));
}

async function execute(input, context = {}) {
  const opts = coerceJob(parseInput(input));
  const job = typeof opts.job === 'object' ? JSON.stringify(opts.job, null, 1) : String(opts.job || '');
  // Fall back to the stored resume. A scheduled 4am run has no one to paste one
  // in, and a cover letter full of [FILL IN: …] placeholders is not a report.
  let resume = String(opts.resumeText || opts.resume || '').slice(0, 4000);
  if (!resume && context.userId && context.userId !== 'system') {
    try {
      const stored = await require('./ResumeTool').loadStored(context.userId);
      if (stored) resume = String(stored.content).slice(0, 4000);
    } catch (e) { /* no stored resume — fall through to the placeholder letter */ }
  }
  if (!job) {
    throw new Error('ApplyDraftTool needs a job posting, e.g. {"job":{"title":"Product Analyst","company":"Acme","url":"...","description":"..."},"resumeText":"..."} — or pass the posting fields flat: {"title","company","url","description"}.');
  }
  // Guard against a placeholder posting (the planner sometimes emits template
  // tokens instead of a real result). Check the identifying fields, not the
  // free-text description, so a legit posting with stray "<" isn't rejected.
  const idText = (typeof opts.job === 'object' && opts.job)
    ? [opts.job.url, opts.job.title, opts.job.company].filter(Boolean).join(' ')
    : job;
  if (looksLikePlaceholder(idText)) {
    throw new Error('That job posting is an unfilled placeholder (e.g. "<Job URL>" / "{{SELECTED_JOB_URL}}"). Pass a REAL posting from your "jobs" tool results — its actual title, company, url and description — not a template token. Do not fetch a made-up URL; draft from a posting the jobs search already returned.');
  }

  const prompt = `You are an expert career coach drafting a job application package.

JOB POSTING:
${job.slice(0, 4000)}

${resume ? `CANDIDATE RESUME / BACKGROUND:\n${resume}` : 'No resume provided — write the letter with clearly marked [FILL IN: …] placeholders for the candidate\'s specifics.'}

Produce EXACTLY this structure in markdown:
## Cover Letter
(≤250 words, specific to this role and company, no clichés)
## Why This Match Works
(3 bullets connecting candidate strengths to the posting's requirements)
## Application Checklist
(concrete next steps INCLUDING the application URL if one was given; final step must be "Review and submit yourself — this draft was AI-generated")`;

  const result = await runInference({
    // Route by workload rather than pinning Groq: a drafting run that lands on
    // the day Groq's allowance is spent should fall through to the next
    // provider, not fail the whole mission.
    feature: 'apply_draft',
    temperature: 0.6,
    messages: [{ role: 'user', content: prompt }]
  });

  // Record the opportunity in the ledger so "how many have I applied to?" has
  // an answer and tomorrow's hunt can skip what it already drafted. Logged as
  // 'drafted', never 'applied' — the human is still the one who submits.
  let ledger = null;
  if (context.userId && context.userId !== 'system' && typeof opts.job === 'object' && opts.job) {
    try {
      const out = await require('./ApplicationsTool').execute({
        action: 'log',
        role: opts.job.title || opts.job.role,
        company: opts.job.company,
        location: opts.job.location,
        url: opts.job.url,
        source: opts.job.source,
        status: 'drafted',
        draft: result.content,
        missionId: opts.missionId || context.missionId || null
      }, context);
      ledger = { logged: out.loggedCount, alreadyKnown: out.duplicateCount };
    } catch (e) {
      ledger = { error: `not logged: ${e.message}` };
    }
  }

  return {
    draft: result.content,
    ledger,
    disclaimer: 'DRAFT ONLY — nothing has been submitted. Review, edit, and submit the application yourself.',
    model: result.model,
    tokens: result.tokens || 0
  };
}

module.exports = { execute };
