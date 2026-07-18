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
  const resume = String(opts.resumeText || opts.resume || '').slice(0, 4000);
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
    provider: 'groq',
    temperature: 0.6,
    messages: [{ role: 'user', content: prompt }]
  });

  return {
    draft: result.content,
    disclaimer: 'DRAFT ONLY — nothing has been submitted. Review, edit, and submit the application yourself.',
    model: result.model,
    tokens: result.tokens || 0
  };
}

module.exports = { execute };
