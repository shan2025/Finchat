// test/reasoning-salvage.test.js — a finished answer in broken JSON is not retried.
//
// The corrective retry re-sends the whole conversation plus the broken reply, so
// it costs about twice the turn it repairs. A race lane's answer turn spent 16.7k
// tokens that way (8.3k twice) and ended 47% over budget. When the first reply
// already holds a real answer, ReasoningEngine now delivers it without a retry;
// replies with nothing to recover (a malformed tool call) still get one.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const INFERENCE = require.resolve('../services/inference');
const ENGINE = require.resolve('../services/cognitive/ReasoningEngine');

function loadWith(replies) {
  const calls = [];
  const m = new Module(INFERENCE, null);
  m.filename = INFERENCE; m.path = path.dirname(INFERENCE); m.loaded = true;
  m.exports = {
    runInference: async (opts) => {
      calls.push(opts);
      const content = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { content, provider: 'fake', model: 'fake', tokens: 1000, promptTokens: 900, completionTokens: 100 };
    }
  };
  require.cache[INFERENCE] = m;
  delete require.cache[ENGINE];
  return { engine: require(ENGINE), calls };
}

test.afterEach(() => { delete require.cache[INFERENCE]; delete require.cache[ENGINE]; });

const LONG = 'Nvidia faces concentration risk: export curbs and hyperscaler capex drive most of its revenue.';

test('an unterminated response is delivered without a corrective retry', async () => {
  const { engine, calls } = loadWith([`{"thought":"done","action":"respond","response":"${LONG}`]);
  const r = await engine.reason({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(calls.length, 1, 'the retry would re-send the whole conversation');
  assert.equal(r.action.action, 'respond');
  assert.equal(r.action.response, LONG);
  assert.equal(r.retried, false);
  assert.equal(r.fallback, false);
  assert.equal(r.tokens, 1000, 'only the one call is charged');
});

test('a malformed tool call still gets its corrective retry', async () => {
  const { engine, calls } = loadWith([
    '{"thought":"need prices","action":"tool","tool":"stocks",',
    '{"thought":"need prices","action":"tool","tool":"stocks","input":"NVDA"}'
  ]);
  const r = await engine.reason({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(calls.length, 2);
  assert.equal(r.retried, true);
  assert.equal(r.action.action, 'tool');
});

test('salvageResponse only counts a substantial response as recovered', () => {
  const { salvageResponse } = require(ENGINE);
  assert.equal(salvageResponse(`{"response":"${LONG}"`).salvaged, true);
  assert.equal(salvageResponse('{"thought":"hmm","action":"tool"').salvaged, false);
  assert.equal(salvageResponse('{"response":"ok"}').salvaged, false, 'too short to be an answer');
});
