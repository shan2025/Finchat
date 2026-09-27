// test/inbox-job-matcher.test.js — job alerts → resume-scored postings → drafts.
//
// The matcher exists because a mission plan cannot chain gmail list → read →
// apply_draft: it writes every step before any runs, so the later steps got
// placeholders. What must hold, with no network and no database:
//   • a posting's URL only ever comes from a link the email actually contained
//   • only strong, linked, not-yet-logged postings are drafted, capped per run
//   • nothing is marked applied — the ledger sees drafted/shortlisted only
const { test } = require('node:test');
const assert = require('node:assert');

const { matchInbox, normalizePostings, canonicalUrl } = require('../services/inboxJobMatcher');

const RESUME = { content: 'Business Analyst. SQL, Power BI, stakeholder workshops, 1 year experience.' };

function fakeGmail(messages) {
  return async (input) => {
    if (input.action === 'list') {
      return { connected: true, count: messages.length, messages: messages.map((m, i) => ({ messageId: `m${i}` })) };
    }
    const m = messages[Number(String(input.messageId).slice(1))];
    return { connected: true, from: m.from, subject: m.subject, body: m.body, links: m.links };
  };
}

const ALERTS = [
  {
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    subject: 'Business Analyst in Bengaluru',
    body: 'Business Analyst — Kyndryl — Bengaluru. Associate Product Manager — Razorpay — Bengaluru. Senior Program Manager — HCL (12+ yrs).',
    links: [
      'https://www.linkedin.com/comm/jobs/view/4011111111/?trackingId=abc&refId=x',
      'https://www.linkedin.com/comm/jobs/view/4022222222/?trackingId=def',
      'https://www.linkedin.com/comm/jobs/view/4033333333/?trackingId=ghi'
    ]
  }
];

function fakeInfer(postings) {
  return async () => ({ content: JSON.stringify({ postings }) });
}

test('LinkedIn alert tracking is stripped so the same job dedupes across days', () => {
  assert.strictEqual(
    canonicalUrl('https://www.linkedin.com/comm/jobs/view/4011111111/?trackingId=abc&refId=x'),
    'https://www.linkedin.com/jobs/view/4011111111/');
  assert.strictEqual(
    canonicalUrl('https://in.indeed.com/rc/clk?jk=9f8e7d&from=ja&utm_source=x'),
    'https://in.indeed.com/viewjob?jk=9f8e7d');
  assert.strictEqual(canonicalUrl('not a url'), 'not a url');
});

test('a link id the email did not contain becomes null, never a guessed URL', () => {
  const emails = [{ from: 'jobs@naukri.com', links: ['https://www.naukri.com/job-listings-ba-123'] }];
  const rows = normalizePostings([
    { email: 0, title: 'BA', company: 'X', link: '0.1', score: 80 },
    { email: 0, title: 'PM', company: 'Y', link: '0.9', score: 90 },       // out of range
    { email: 0, title: 'PO', company: 'Z', link: 'https://made.up/job', score: 85 } // not an id
  ], emails);
  const byTitle = Object.fromEntries(rows.map(r => [r.title, r]));
  assert.strictEqual(byTitle.BA.url, 'https://www.naukri.com/job-listings-ba-123');
  assert.strictEqual(byTitle.BA.source, 'naukri');
  assert.strictEqual(byTitle.PM.url, null);
  assert.strictEqual(byTitle.PO.url, null);
});

test('strong linked matches are drafted and logged; weak ones are only reported', async () => {
  const drafted = [];
  const logged = [];
  const out = await matchInbox({ userId: 'u1', maxDrafts: 3 }, {
    loadResume: async () => RESUME,
    gmail: fakeGmail(ALERTS),
    infer: fakeInfer([
      { email: 0, title: 'Business Analyst', company: 'Kyndryl', link: '0.1', score: 86, why: 'BA workshops + SQL' },
      { email: 0, title: 'Associate Product Manager', company: 'Razorpay', link: '0.2', score: 74, why: 'stakeholder work', gaps: 'no shipped product' },
      { email: 0, title: 'Senior Program Manager', company: 'HCL', link: '0.3', score: 20, gaps: '12+ years' }
    ]),
    known: async (_u, postings) => postings.map(() => false),
    draft: async (input) => { drafted.push(input.job); return { draft: `Letter for ${input.job.company}` }; },
    log: async (input) => { logged.push(...input.jobs); return { loggedCount: input.jobs.length }; }
  });

  assert.deepStrictEqual(drafted.map(j => j.company), ['Kyndryl', 'Razorpay']);
  assert.strictEqual(drafted[0].url, 'https://www.linkedin.com/jobs/view/4011111111/');
  assert.deepStrictEqual(out.matches.map(m => [m.company, m.status]), [['Kyndryl', 'drafted'], ['Razorpay', 'drafted']]);
  // The letter itself stays in the ledger; the result only says it exists.
  assert.strictEqual(out.matches[0].coverLetter, 'drafted and saved');
  assert.ok(!JSON.stringify(out).includes('Letter for Kyndryl'));
  assert.deepStrictEqual(out.belowThreshold.map(p => p.company), ['HCL']);
  // The ledger never hears "applied" from the matcher.
  assert.ok(logged.every(j => j.status === 'shortlisted'));
  assert.deepStrictEqual(logged.map(j => j.matchScore), [86, 74]);
});

test('postings already in the ledger are not drafted again, and the per-run cap holds', async () => {
  let drafts = 0;
  const out = await matchInbox({ userId: 'u1', maxDrafts: 1 }, {
    loadResume: async () => RESUME,
    gmail: fakeGmail(ALERTS),
    infer: fakeInfer([
      { email: 0, title: 'Business Analyst', company: 'Kyndryl', link: '0.1', score: 90 },
      { email: 0, title: 'Associate Product Manager', company: 'Razorpay', link: '0.2', score: 80 },
      { email: 0, title: 'Senior Program Manager', company: 'HCL', link: '0.3', score: 75 }
    ]),
    known: async (_u, postings) => postings.map(p => p.company === 'Kyndryl'),
    draft: async () => { drafts++; return { draft: 'x' }; },
    log: async () => ({})
  });
  assert.strictEqual(drafts, 1);
  const status = Object.fromEntries(out.matches.map(m => [m.company, m.status]));
  assert.deepStrictEqual(status, { Kyndryl: 'already_in_ledger', Razorpay: 'drafted', HCL: 'shortlisted' });
});

test('no stored resume stops before reading any mail', async () => {
  let listed = false;
  const out = await matchInbox({ userId: 'u1' }, {
    loadResume: async () => null,
    gmail: async () => { listed = true; return {}; }
  });
  assert.strictEqual(listed, false);
  assert.match(out.error, /No resume on file/);
});

test('Gmail not connected is passed through, not treated as an empty inbox', async () => {
  const out = await matchInbox({ userId: 'u1' }, {
    loadResume: async () => RESUME,
    gmail: async () => ({ connected: false, error: 'The user has not connected Gmail' })
  });
  assert.strictEqual(out.connected, false);
  assert.deepStrictEqual(out.matches, []);
});
