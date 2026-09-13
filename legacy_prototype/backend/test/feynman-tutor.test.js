// test/feynman-tutor.test.js — the Explainer & Tutor's contract.
//
// A tutor fails quietly in the worst way: a fluent lesson built on an invented
// paper or a misremembered parameter count reads exactly like a good one, and
// the learner has no way to tell. So the prompt must keep saying, in words,
// that specific numbers and papers come from tools and never from memory, and
// that finance lessons are explanations rather than instructions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { determineDelegationTarget } = require('../services/supervisor');
const { personas, listPersonas } = require('../services/personas');

test('Feynman exists as a tutor on the roster', () => {
  const f = personas.feynman;
  assert.ok(f, 'feynman persona must exist — server.js seeds his users row from this roster');
  assert.equal(f.name, 'Feynman');
  assert.match(f.roleTitle, /tutor|explain/i);
  assert.ok(listPersonas().some(p => p.id === 'feynman'), 'must be listed for the chat bar');
});

test('the prompt forbids teaching specifics from memory', () => {
  const p = personas.feynman.systemPrompt;
  assert.match(p, /NEVER invent an arXiv ID/, 'must forbid fabricated papers');
  assert.match(p, /"paper" tool/, 'must route papers through the paper tool');
  assert.match(p, /could not verify/i, 'must say what to do when a source is not found');
  assert.match(p, /PRIMARY source/, 'a commentator is a lead, not the source of the numbers');
  assert.match(p, /"Sources" list/, 'citations must resolve to URLs the learner can open');
});

test('the prompt keeps finance lessons educational', () => {
  const p = personas.feynman.systemPrompt;
  assert.match(p, /not financial advice/i);
  assert.match(p, /never tell the user what to buy, sell or hold/i);
});

test('the prompt does not claim to be the real person', () => {
  assert.match(personas.feynman.systemPrompt, /never claim to be/i);
});

test('explicit teaching requests reach the tutor, even inside another domain', () => {
  for (const q of [
    'teach me how looped transformers work',
    'explain drawdown in simple terms',
    'help me understand the RICE framework',
    'debunk the hype about recurrent depth models',
    'eli5 attention in AI models'
  ]) {
    assert.equal(determineDelegationTarget(q), 'feynman', `"${q}" is a request to be taught`);
  }
});

test('faults and plain domain questions keep their owners', () => {
  assert.equal(determineDelegationTarget('why did my mission fail'), 'hopper');
  assert.equal(determineDelegationTarget('how is my portfolio doing'), 'atlas');
  assert.equal(determineDelegationTarget('bitcoin price today'), 'aurelius');
});
