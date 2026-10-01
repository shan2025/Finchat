// test/plan-references.test.js — a plan step that points at an earlier step's
// result must get that result, not the pointer.
//
// The inputs below are REAL: they are what the planner wrote for `fetch` on
// recorded runs between 2026-08-17 and 2026-09-13, every one of which failed
// with "Invalid URL" because the placeholder was sent to the tool as an address.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { resolveStepInput, urlIn, urlsInResult, referencedStep } =
  require('../services/cognitive/planReferences');

const RECORDED_PLACEHOLDERS = [
  '<URL of top headline from step 1>',
  '<top_paper_url>',
  'URL of top AI news article from step 1',
  '{"url":"{{step1.results[0].url}}"}',
  'URL of top AI news article (to be selected from step 1 results)',
  '<URL_of_top_AI_news_article>',
  'first URL from step 1 results',
  '{{paper[0].url}}',
  '$1[0].url',
  '[Top AI headline URL from step 1]',
  '<URL of top job posting from steps 1-3>',
  '{"url": "<URL from news results>"}',
  'URL of the most interesting paper or article'
];

// Shaped like the news tool's output: ranked items, plus an incidental feed URL.
const newsResult = {
  feed: 'https://news.example.com/',
  items: [
    { title: 'Top story', url: 'https://news.example.com/top-story', source: 'Example' },
    { title: 'Second story', url: 'https://news.example.com/second' }
  ]
};
const priorFromStep1 = [{ planStep: 1, tool: 'news', input: 'AI', result: newsResult }];

describe('placeholders are recognised as not-a-URL', () => {
  for (const p of RECORDED_PLACEHOLDERS) {
    test(`"${p}"`, () => assert.strictEqual(urlIn(p), null));
  }
  test('a real URL is still a URL, in any shape', () => {
    assert.strictEqual(urlIn('https://arxiv.org/abs/2409.01234'), 'https://arxiv.org/abs/2409.01234');
    assert.strictEqual(urlIn('{"url":"https://a.com/x"}'), 'https://a.com/x');
    assert.strictEqual(urlIn({ url: 'https://a.com/y' }), 'https://a.com/y');
  });
});

describe('every recorded placeholder resolves to the top result', () => {
  for (const p of RECORDED_PLACEHOLDERS) {
    test(`"${p}"`, () => {
      const r = resolveStepInput({ step: 2, tool: 'fetch', input: p }, priorFromStep1);
      assert.ok(r.resolved, `should resolve: ${r.note}`);
      assert.deepStrictEqual(r.input, { url: 'https://news.example.com/top-story' },
        'the first ranked item, not the feed homepage');
    });
  }
});

describe('resolution is honest about its limits', () => {
  test('a real URL is left exactly as planned', () => {
    const r = resolveStepInput({ step: 2, tool: 'fetch', input: 'https://a.com/z' }, priorFromStep1);
    assert.ok(!r.resolved && !r.unresolved);
    assert.strictEqual(r.input, 'https://a.com/z');
  });

  test('non-URL tools are never touched', () => {
    const input = '<the symbol from step 1>';
    const r = resolveStepInput({ step: 2, tool: 'crypto', input }, priorFromStep1);
    assert.ok(!r.resolved && !r.unresolved);
    assert.strictEqual(r.input, input);
  });

  test('nothing to resolve from means SKIP, never a guess', () => {
    const r = resolveStepInput({ step: 1, tool: 'fetch', input: '<URL of top article>' }, []);
    assert.ok(r.unresolved);
    assert.match(r.note, /description of a URL/);
  });

  test('an error result supplies no URL', () => {
    const prior = [{ planStep: 1, tool: 'news', input: 'x', result: { error: 'feed down' } }];
    assert.ok(resolveStepInput({ step: 2, tool: 'fetch', input: '<top url>' }, prior).unresolved);
  });

  test('a second fetch takes the next URL, not the one already read', () => {
    const prior = [
      ...priorFromStep1,
      { planStep: 2, tool: 'fetch', input: { url: 'https://news.example.com/top-story' }, result: { text: 'x' } }
    ];
    const r = resolveStepInput({ step: 3, tool: 'fetch', input: '<URL of another article from step 1>' }, prior);
    assert.deepStrictEqual(r.input, { url: 'https://news.example.com/second' });
  });

  test('a named step wins over a more recent one', () => {
    const prior = [
      ...priorFromStep1,
      { planStep: 2, tool: 'paper', input: 'y', result: [{ pdfUrl: 'https://arxiv.org/pdf/1' }] }
    ];
    const r = resolveStepInput({ step: 3, tool: 'fetch', input: '<URL of top headline from step 1>' }, prior);
    assert.deepStrictEqual(r.input, { url: 'https://news.example.com/top-story' });
  });

  test('step references are read in each recorded form', () => {
    assert.strictEqual(referencedStep('{{step1.results[0].url}}'), 1);
    assert.strictEqual(referencedStep('<URL from steps 1-3>'), 1);
    assert.strictEqual(referencedStep('$2[0].url'), 2);
    assert.strictEqual(referencedStep('<top_paper_url>'), null);
  });

  test('item addresses rank ahead of incidental ones', () => {
    assert.strictEqual(urlsInResult(newsResult)[0], 'https://news.example.com/top-story');
  });
});
