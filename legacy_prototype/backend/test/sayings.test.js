// Sayings — the pure halves: which sentence is worth keeping, and what a
// stored line looks like when it reaches the user. The database halves
// (pickSaying / learnFromRun) are exercised against a real DB in
// scripts/test_sayings_db.js; these run with no connection at all.

const assert = require('assert');
const { extractLine, keywords, formatSaying } = require('../services/Sayings');

let passed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log('extractLine');

it('keeps a concrete, self-contained sentence', () => {
  const line = extractLine(
    'Sure, here is what I found. The Federal Reserve held rates at 4.25% for the third consecutive meeting, citing sticky services inflation. Let me know if you want more.'
  );
  assert.ok(line && line.includes('4.25%'), `got: ${line}`);
});

it('rejects conversational filler', () => {
  assert.strictEqual(
    extractLine("I'll take a look at that for you and come back with more detail shortly."),
    null
  );
});

it('rejects questions', () => {
  assert.strictEqual(
    extractLine('Would you like me to compare that against the previous quarter and report back to you?'),
    null
  );
});

it('ignores code blocks', () => {
  const line = extractLine('```js\nconst x = 1; // Something that looks like a sentence with 42 in it here\n```');
  assert.strictEqual(line, null);
});

it('prefers the sentence with the hardest numbers', () => {
  const line = extractLine(
    'Nvidia announced a partnership with Siemens this week. Revenue rose 94% to $30.0 billion, with data centre sales making up $26.3 billion of that total.'
  );
  assert.ok(line.includes('94%'), `got: ${line}`);
});

it('drops sentences that are too short or too long to quote', () => {
  assert.strictEqual(extractLine('Rates fell in March 2026.'), null);
  assert.strictEqual(extractLine('The ' + 'very '.repeat(60) + 'long sentence about 2026 policy.'), null);
});

console.log('keywords');

it('strips stopwords and short words', () => {
  const k = keywords('What are the Federal Reserve rates doing this week');
  assert.ok(k.includes('federal'), k.join(','));
  assert.ok(k.includes('reserve'), k.join(','));
  assert.ok(!k.includes('what'), k.join(','));
  assert.ok(!k.includes('this'), k.join(','));
});

it('returns nothing for a contentless question', () => {
  assert.deepStrictEqual(keywords('what is this about'), []);
});

console.log('formatSaying');

it('attributes a seed', () => {
  assert.strictEqual(
    formatSaying({ text: 'Price is what you pay.', attribution: 'Warren Buffett', origin: 'seed' }),
    '“Price is what you pay.” — Warren Buffett'
  );
});

it('cites the source of a learned line', () => {
  assert.strictEqual(
    formatSaying({ text: 'Rates held at 4.25%.', origin: 'learned', source_title: 'Fed statement' }),
    '“Rates held at 4.25%.” — Fed statement'
  );
});

it('survives a null row', () => {
  assert.strictEqual(formatSaying(null), '');
});

console.log(`\n${passed} passed`);
