// Daily Telegram newsletter: editing, PDF rendering, caption and timing.
const test = require('node:test');
const assert = require('node:assert');
// Emoji logs can corrupt node:test's stream on Windows; they are not under test.
console.log = () => {};
console.warn = () => {};

const { renderNewsletterPdf, pdfSafe, inlineRuns } = require('../services/newsletter/pdf');
const { composeIssue, caption, istParts } = require('../services/newsletter');

const ISSUE = `# FinChat Daily — 30 Sept 2026

Risk-off day as oil jumped.

## Executive Summary
- **Oil up** — Brent +1.6% to $93.88 [1].
- **Gold down** — 1.7% lower.

## Markets
### Brent jumps on Hormuz
#### Iran proposal rejected
Brent rose 1.59% to $93.88 ([Bloomberg][1]) after the proposal was rejected. 📈 The move fed ₹ weakness → imports.

**Why it matters** — inflation risk for India.
*In short: oil sets the tone*

### Gold slips
#### Real yields bite
Gold fell 1.67% to $4,248.90 ([3][5]).

**Why it matters** — safe-haven demand is fading.
*In short: yields win today*

## 🎯 Key Takeaway
Energy drove everything.

[1]: https://www.bloomberg.com/x "Bloomberg oil"
[3]: https://reuters.com/y "Reuters gold"
[5]: https://ft.com/z "FT gold"
`;

test('pdfSafe keeps Latin text and spells out symbols the standard fonts lack', () => {
  assert.strictEqual(pdfSafe('Gold 📈 up → ₹83 ≈ ok'), 'Gold up -> Rs 83 ~ ok');
  assert.strictEqual(pdfSafe('café “quoted” — dash'), 'café “quoted” — dash');
});

test('inline citations: "([3][5])" is two citations, reference links keep their URL', () => {
  const refs = [{ id: '1', url: 'https://b.com' }, { id: '3', url: 'https://r.com' }, { id: '5', url: 'https://f.com' }];
  const runs = inlineRuns('Up ([Bloomberg][1]) and ([3][5]) **bold**', refs);
  const text = runs.map(r => r.text).join('');
  assert.match(text, /Bloomberg/);
  assert.match(text, /\[3\]\s*\[5\]/);
  assert.doesNotMatch(text, /35/);
  assert.ok(runs.some(r => r.link === 'https://b.com'));
  assert.ok(runs.some(r => r.bold && r.text === 'bold'));
});

test('renderNewsletterPdf draws one page per card', async () => {
  const out = await renderNewsletterPdf(ISSUE);
  assert.strictEqual(out.buffer.slice(0, 5).toString(), '%PDF-');
  // cover + summary + 2 stories + takeaway + sources
  assert.strictEqual(out.pages, 6);
  assert.deepStrictEqual(out.stories, ['Brent jumps on Hormuz', 'Gold slips']);
  assert.strictEqual(out.title, 'FinChat Daily');
});

test('a very long story spills onto a continuation page instead of being cut', async () => {
  const long = ISSUE.replace('Gold fell 1.67% to $4,248.90 ([3][5]).', 'Gold fell. '.repeat(700));
  const out = await renderNewsletterPdf(long);
  assert.ok(out.pages > 6);
});

test('composeIssue uses the editor output when it is issue-shaped', async () => {
  let asked;
  const r = await composeIssue([{ type: 'mission', title: 'Crypto', content: 'x'.repeat(300), created_at: new Date() }], {
    date: '30 Sept 2026',
    runInference: async (args) => { asked = args; return { content: '```markdown\n' + ISSUE + '\n```' }; }
  });
  assert.strictEqual(r.edited, true);
  assert.match(r.markdown, /^# FinChat Daily/);
  assert.strictEqual(asked.workload, 'mission', 'shared pool, never the user\'s BYOK key');
  assert.strictEqual(asked.userId, undefined);
  assert.match(asked.messages[0].content, /30 Sept 2026/);
});

test('composeIssue falls back to the latest briefing when the editor fails', async () => {
  const sources = [
    { type: 'briefing', title: 'Morning', content: 'OLD BRIEF', created_at: new Date() },
    { type: 'mission', title: 'Mission report: X', content: 'y'.repeat(300), created_at: new Date() },
    { type: 'briefing', title: 'Midday', content: 'NEW BRIEF', created_at: new Date() }
  ];
  const r = await composeIssue(sources, { runInference: async () => { throw new Error('down'); } });
  assert.deepStrictEqual([r.edited, r.markdown], [false, 'NEW BRIEF']);
  const noBrief = await composeIssue([sources[1]], { date: 'D', runInference: async () => ({ content: 'not an issue' }) });
  assert.match(noBrief.markdown, /# FinChat Daily — D[\s\S]*## Mission report: X/);
});

test('caption lists the stories, escapes HTML and stays under Telegram\'s limit', () => {
  const c = caption({ title: 'FinChat <Daily>', date: '30 Sept', stories: Array(20).fill('A & B '.repeat(20)) });
  assert.match(c, /^<b>FinChat &lt;Daily&gt;<\/b>/);
  assert.match(c, /A &amp; B/);
  assert.ok(c.length <= 1024);
});

test('istParts uses the IST calendar day', () => {
  assert.deepStrictEqual(istParts(new Date('2026-09-30T20:00:00Z')), { day: '2026-10-01', hour: 1, minute: 30 });
  assert.strictEqual(istParts(new Date('2026-09-30T03:31:00Z')).hour, 9);
});
