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

async function execute(input, context = {}) {
  const opts = parseInput(input);
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
    throw new Error('ApplyDraftTool needs a job posting, e.g. {"job":{"title":"Product Analyst","company":"Acme","url":"...","description":"..."},"resumeText":"..."}');
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
