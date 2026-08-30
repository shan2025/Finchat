// test/atlas-portfolio-steward.test.js — the Portfolio Steward's contract.
//
// Two things about Atlas are easy to break from a distance and expensive to
// notice, because both fail quietly with a plausible-looking answer:
//
//   1. Delegation precedence. "review my investments" contains "invest", an
//      Aurelius trigger. Atlas is checked FIRST on purpose — a question about
//      the user's own positions belongs to the agent holding their snapshot
//      history, not to the market analyst. Reorder those blocks and portfolio
//      questions silently start being answered without the portfolio.
//   2. The no-trade boundary. Atlas watches someone's actual savings, so the
//      prompt must keep saying, in words, that he never executes and never
//      tells the user to buy or sell a specific amount of their own money.
const test = require('node:test');
const assert = require('node:assert/strict');
const { determineDelegationTarget } = require('../services/supervisor');
const { personas } = require('../services/personas');

test('questions about the user\'s own positions route to Atlas', () => {
  for (const q of [
    'review my investments',
    'how is my portfolio doing',
    'what are my holdings worth',
    'are my assets growing',
    'show me my allocation',
    'what is my drawdown this month'
  ]) {
    assert.equal(determineDelegationTarget(q), 'atlas', `"${q}" should reach the steward`);
  }
});

test('bare market questions still route to Aurelius', () => {
  for (const q of [
    'bitcoin price today',
    'is TSLA stock a good investment',
    'which startups raised seed rounds this week',
    'what is happening in crypto'
  ]) {
    assert.equal(determineDelegationTarget(q), 'aurelius', `"${q}" is a market question, not a portfolio one`);
  }
});

test('Atlas exists with a portfolio role', () => {
  const a = personas.atlas;
  assert.ok(a, 'atlas persona must exist — the DB row alone gives him no prompt');
  assert.equal(a.name, 'Atlas');
  assert.match(a.roleTitle, /portfolio/i);
});

test('Atlas\'s prompt keeps the no-trade boundary explicit', () => {
  const p = personas.atlas.systemPrompt;
  assert.match(p, /never execute|never place|no broker credentials/i,
    'must state that he cannot execute or place a trade');
  assert.match(p, /not financial advice/i, 'must carry the advice disclaimer');
  assert.match(p, /buy or sell a specific amount/i,
    'must forbid instructing the user to trade a specific amount of their own money');
});

test('Atlas\'s prompt forbids inventing past performance', () => {
  const p = personas.atlas.systemPrompt;
  assert.match(p, /history/i, 'must point at the recorded history as the source of growth');
  assert.match(p, /do not reconstruct|do NOT reconstruct|never answer from memory/i,
    'growth must be measured from snapshots, never estimated from remembered prices');
});
