// test/context-tool-budget.test.js — the tool-results block must fit a budget.
//
// Unbounded tool results built a 32,667-char request that Groq rejected with
// 413; inference.js then blind-capped every message and the run burned its
// whole token budget on retries without writing a report. These tests pin the
// properties that prevent that: bounded size, no source silently dropped, and
// one huge result not crowding out the others.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildContext, packToolResults } = require('../services/cognitive/ContextBuilder');

const bulk = (n, ch = 'x') => ch.repeat(n);

describe('packToolResults', () => {
  test('small results pass through untouched', () => {
    const out = packToolResults([
      { tool: 'news', result: 'headline one' },
      { tool: 'stock', result: { symbol: 'AAPL', price: 231.4 } }
    ], 12000);
    assert.match(out, /\[Tool: news\] Result: headline one/);
    assert.match(out, /"symbol":"AAPL"/);
    assert.ok(!out.includes('trimmed'), 'nothing should be trimmed under budget');
  });

  test('stays within the budget when results are oversized', () => {
    const out = packToolResults([
      { tool: 'search', result: bulk(30000) },
      { tool: 'news', result: bulk(20000, 'y') }
    ], 12000);
    // Allow for the per-entry "[Tool: …] Result: " labels and trim markers.
    assert.ok(out.length < 12000 + 500, `block was ${out.length} chars`);
  });

  test('one enormous result cannot crowd out the others', () => {
    const out = packToolResults([
      { tool: 'search', result: bulk(60000) },
      { tool: 'news', result: 'short but important' },
      { tool: 'paper', result: 'also short' }
    ], 6000);
    // Naive head-truncation of the concatenated block would lose these two.
    assert.match(out, /short but important/);
    assert.match(out, /also short/);
    assert.match(out, /\[Tool: search\]/);
  });

  test('every tool stays represented even at a tiny budget', () => {
    const tools = ['news', 'search', 'paper', 'reddit', 'stock'];
    const out = packToolResults(tools.map(t => ({ tool: t, result: bulk(9000) })), 1000);
    for (const t of tools) {
      assert.match(out, new RegExp(`\\[Tool: ${t}\\]`), `${t} disappeared`);
    }
  });

  test('trimming is announced, so the model knows data was cut', () => {
    const out = packToolResults([{ tool: 'search', result: bulk(50000) }], 2000);
    assert.match(out, /more chars trimmed to fit the context budget/);
  });

  test('small results give their slack to large ones', () => {
    // 'tiny' needs 10 of a 3000 budget; 'huge' should get far more than an
    // even 1500 split would have allowed.
    const out = packToolResults([
      { tool: 'tiny', result: bulk(10) },
      { tool: 'huge', result: bulk(40000) }
    ], 3000);
    const hugeLine = out.split('\n').find(l => l.startsWith('[Tool: huge]'));
    assert.ok(hugeLine.length > 2400, `huge only got ${hugeLine.length} chars`);
  });

  test('handles empty input and non-string results', () => {
    assert.equal(packToolResults([]), '');
    const out = packToolResults([{ tool: 't', result: { error: 'boom' } }], 12000);
    assert.match(out, /"error":"boom"/);
  });
});

describe('buildContext', () => {
  test('bounds the whole request, not just one message', () => {
    const messages = buildContext({
      goal: 'Produce a markets brief',
      toolResults: [
        { tool: 'news', result: bulk(30000) },
        { tool: 'search', result: bulk(30000) },
        { tool: 'paper', result: bulk(30000) }
      ]
    });
    const totalChars = messages.reduce((n, m) => n + String(m.content).length, 0);
    // The failing production run was 32,667 chars and got a 413.
    assert.ok(totalChars < 30000, `request was ${totalChars} chars`);
  });

  test('the goal survives regardless of how large the tool output was', () => {
    const messages = buildContext({
      goal: 'Produce a markets brief',
      toolResults: [{ tool: 'search', result: bulk(80000) }]
    });
    assert.equal(messages[messages.length - 1].content, 'Produce a markets brief');
  });
});
