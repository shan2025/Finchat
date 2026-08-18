// test/inference-quota-integration.test.js — the router must actually USE the
// QuotaManager, not merely have it available.
//
// quota-manager.test.js proves the markers work in isolation. That is not the
// property that failed: inference.js already computed "this 429 means the daily
// allowance is gone", and the bug was that it did nothing with the verdict. So
// the thing worth testing is the wiring — a second call must skip a model the
// first call proved exhausted, without a request going out.
//
// axios is stubbed through the require cache before inference.js is loaded, so
// no network call is made and every attempt is observable.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const axiosPath = require.resolve('axios');
const inferencePath = require.resolve('../services/inference');
const quotaPath = require.resolve('../services/QuotaManager');
const databasePath = require.resolve('../database');

/** Replace a module's cached exports so requiring it yields `exports`. */
function stub(filename, exports) {
  const m = new Module(filename, null);
  m.filename = filename;
  m.path = path.dirname(filename);
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
}

// A successful call writes a row to inference_metrics, which lazily requires
// `database` and opens a real Postgres pool. The tests then pass and the
// process never exits, because the pool is an open handle the runner waits on.
// Stub it once, before anything can require the real one.
stub(databasePath, { query: async () => ({ rows: [] }) });

/** Every POST the router attempts, in order, with the model and headers sent. */
let attempts = [];
let sent = [];

/**
 * Load a fresh inference.js over a scripted axios.
 * `respond(url, body, n)` returns a response or throws to simulate a failure.
 */
function loadInference(respond) {
  attempts = [];
  sent = [];
  delete require.cache[inferencePath];
  stub(axiosPath, {
    post: async (url, body, config) => {
      attempts.push({ url, model: body?.model });
      sent.push({ url, headers: config?.headers || {} });
      return respond(url, body, attempts.length);
    }
  });
  return require(inferencePath);
}

/** A 429 whose retry-after is measured in hours: the allowance is spent. */
function dailyQuota429() {
  const err = new Error('Rate limit reached');
  err.response = { status: 429, headers: { 'retry-after': '7200' }, data: { error: {} } };
  return err;
}

const okBody = {
  choices: [{ message: { content: 'fine' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
};

describe('the router honours spent allowances', () => {
  // NOT `delete`: loadInference re-requires inference.js, which re-runs
  // dotenv.config(), which repopulates any key missing from process.env — so a
  // deleted var comes straight back from the real .env and the test silently
  // exercises the developer's own providers. A placeholder is present (dotenv
  // leaves it alone) and unusable (the pool resolves empty), which is what
  // "this provider is not configured" has to mean here.
  const UNCONFIGURED = 'YOUR_KEY_NOT_CONFIGURED';

  beforeEach(() => {
    require(quotaPath)._reset();
    process.env.GROQ_API_KEY = 'groq-test-key-aaaa';
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key-bbbb';
    process.env.GEMINI_API_KEY = UNCONFIGURED;
    process.env.MISTRAL_API_KEY = UNCONFIGURED;
  });

  test('a spent model is not retried on the next call', async () => {
    // Groq's every model answers "daily allowance spent"; DeepSeek answers.
    const inference = loadInference((url) => {
      if (url.includes('groq.com')) throw dailyQuota429();
      return { data: okBody };
    });

    const first = await inference.runInference({
      messages: [{ role: 'user', content: 'hi' }], workload: 'community_name'
    });
    assert.equal(first.provider, 'deepseek', 'sanity: it fell through to a working provider');
    const groqAttemptsFirst = attempts.filter(a => a.url.includes('groq.com')).length;
    assert.ok(groqAttemptsFirst > 0, 'sanity: Groq was tried at least once');

    // Second call, same process. Groq's allowance is known to be gone.
    const before = attempts.length;
    const second = await inference.runInference({
      messages: [{ role: 'user', content: 'hi again' }], workload: 'community_name'
    });
    const groqAttemptsSecond = attempts
      .slice(before).filter(a => a.url.includes('groq.com')).length;

    assert.equal(second.provider, 'deepseek');
    assert.equal(groqAttemptsSecond, 0,
      'the second call must not re-probe a model whose allowance is already spent');
  });

  test('an ordinary per-minute 429 does NOT mark the allowance spent', async () => {
    // retry-after in seconds is throttling, which passes. Marking it would
    // park a healthy model for the rest of the day over one busy minute.
    const shortErr = new Error('slow down');
    shortErr.response = { status: 429, headers: { 'retry-after': '5' }, data: { error: {} } };

    const inference = loadInference((url) => {
      if (url.includes('groq.com')) throw shortErr;
      return { data: okBody };
    });
    await inference.runInference({
      messages: [{ role: 'user', content: 'hi' }], workload: 'chat'
    });

    const spent = require(quotaPath).listSpent();
    assert.equal(spent.length, 0, 'a short retry-after is throttling, not exhaustion');
  });

  test('a provider with no credential is skipped without a request', async () => {
    process.env.GROQ_API_KEY = UNCONFIGURED;
    const inference = loadInference(() => ({ data: okBody }));
    const res = await inference.runInference({
      messages: [{ role: 'user', content: 'hi' }], workload: 'chat'
    });
    assert.equal(res.provider, 'deepseek');
    assert.equal(attempts.filter(a => a.url.includes('groq.com')).length, 0,
      'an empty credential pool means skip, not attempt-and-fail');
  });

  test('an agent-specific key is preferred over the system key', async () => {
    // The pool is what makes per-agent credentials and BYOK the same mechanism
    // rather than three special cases, so it matters that the ORDER is real and
    // not just resolved and discarded. Assert on the header actually sent.
    process.env.DEEPSEEK_API_KEY_AURELIUS = 'deepseek-agent-key-cccc';
    try {
      const inference = loadInference((url) => {
        if (url.includes('groq.com')) throw dailyQuota429();
        return { data: okBody };
      });
      await inference.runInference({
        messages: [{ role: 'user', content: 'hi' }], workload: 'chat', agentId: 'aurelius'
      });
      const call = sent.find(s => s.url.includes('deepseek'));
      assert.equal(call.headers.Authorization, 'Bearer deepseek-agent-key-cccc',
        'the agent pool must outrank the system pool');
    } finally {
      delete process.env.DEEPSEEK_API_KEY_AURELIUS;
    }
  });
});
