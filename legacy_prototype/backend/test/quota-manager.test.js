// test/quota-manager.test.js — credential pools and the memory of spent allowances.
//
// The behaviour that motivated this: inference.js computed "this 429 means the
// DAILY allowance is gone, not a per-minute throttle", used it in a log line,
// and forgot it. Groq's limit is per model per day, so every later call re-tried
// the exhausted model and paid another doomed round-trip until UTC midnight.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const quota = require('../services/QuotaManager');

const HOUR = 3600 * 1000;

beforeEach(() => {
  quota._reset();
  for (const k of Object.keys(process.env)) {
    if (/^(TESTP|GROQ)_API_KEY/.test(k)) delete process.env[k];
  }
});

describe('credential pools', () => {
  test('resolves user, then agent, then system', () => {
    process.env.TESTP_API_KEY = 'system-key-1111';
    process.env.TESTP_API_KEY_AURELIUS = 'agent-key-2222';
    const creds = quota.resolveCredentials('testp', { agentId: 'aurelius', userKey: 'user-key-3333' });
    assert.deepEqual(creds.map(c => c.source), ['user', 'agent', 'system']);
    assert.deepEqual(creds.map(c => c.key), ['user-key-3333', 'agent-key-2222', 'system-key-1111']);
  });

  test('an agent with no key of its own still gets the system pool', () => {
    process.env.TESTP_API_KEY = 'system-key-1111';
    const creds = quota.resolveCredentials('testp', { agentId: 'nova' });
    assert.deepEqual(creds.map(c => c.source), ['system']);
  });

  test('no usable key means an empty pool, which the router reads as skip', () => {
    assert.deepEqual(quota.resolveCredentials('testp', {}), []);
    process.env.TESTP_API_KEY = 'YOUR_KEY_HERE';
    assert.deepEqual(quota.resolveCredentials('testp', {}), [],
      'a placeholder is not a key');
    process.env.TESTP_API_KEY = '';
    assert.deepEqual(quota.resolveCredentials('testp', {}), []);
  });

  test('the same key in two slots is one credential, not two chances', () => {
    // Otherwise an agent slot holding a copy of the system key would make a
    // spent allowance look like it had a spare, and the router would burn a
    // second doomed round-trip proving it did not.
    process.env.TESTP_API_KEY = 'shared-key-9999';
    process.env.TESTP_API_KEY_NOVA = 'shared-key-9999';
    const creds = quota.resolveCredentials('testp', { agentId: 'nova' });
    assert.equal(creds.length, 1);
  });

  test('the credential id never contains the secret', () => {
    process.env.TESTP_API_KEY = 'sk-supersecretvalue-abcd';
    const [cred] = quota.resolveCredentials('testp', {});
    assert.ok(!cred.id.includes('supersecret'),
      'ids land in map keys and log lines, so they must be safe to print');
    assert.match(cred.id, /^system:abcd$/);
  });
});

describe('spent-allowance markers', () => {
  const NOON = Date.UTC(2026, 7, 18, 12, 0, 0);

  test('a marked model is skipped until its allowance returns', () => {
    quota.markSpent('groq', 'gpt-oss-120b', 'system:abcd', { retryAfterSec: 3600, now: NOON });
    assert.equal(quota.isSpent('groq', 'gpt-oss-120b', 'system:abcd', NOON), true);
    assert.equal(quota.isSpent('groq', 'gpt-oss-120b', 'system:abcd', NOON + 2 * HOUR), false,
      'the marker must lift on its own, not need a restart');
  });

  test('markers are per model, per credential — not per provider', () => {
    // Groq bills per model per day, and a second credential is a second
    // allowance. Marking the whole provider would throw away both.
    quota.markSpent('groq', 'gpt-oss-120b', 'system:abcd', { retryAfterSec: 3600, now: NOON });
    assert.equal(quota.isSpent('groq', 'gpt-oss-20b', 'system:abcd', NOON), false);
    assert.equal(quota.isSpent('groq', 'gpt-oss-120b', 'agent:wxyz', NOON), false);
  });

  test('an unmarked model is never treated as spent', () => {
    assert.equal(quota.isSpent('groq', 'anything', 'system:abcd', NOON), false);
  });

  test('a retry-after longer than the day is capped at the UTC reset', () => {
    // A provider reporting 86,400s at 23:50 would otherwise park a working
    // model for an extra day. The free tier resets at UTC midnight.
    const LATE = Date.UTC(2026, 7, 18, 23, 50, 0);
    const until = quota.markSpent('groq', 'm', 'system:abcd', { retryAfterSec: 86400, now: LATE });
    assert.equal(until, Date.UTC(2026, 7, 19), 'capped to the next UTC midnight');
    assert.equal(quota.isSpent('groq', 'm', 'system:abcd', Date.UTC(2026, 7, 19, 0, 1)), false);
  });

  test('listSpent reports what is exhausted and drops what has expired', () => {
    quota.markSpent('groq', 'm1', 'system:abcd', { retryAfterSec: 3600, now: NOON });
    quota.markSpent('gemini', 'm2', 'system:efgh', { retryAfterSec: 3600, now: NOON });
    assert.equal(quota.listSpent(NOON).length, 2);
    assert.equal(quota.listSpent(NOON + 5 * HOUR).length, 0);
  });

  test('listSpent entries carry no secret', () => {
    quota.markSpent('groq', 'm1', 'system:abcd', { retryAfterSec: 3600, now: NOON });
    const [entry] = quota.listSpent(NOON);
    assert.deepEqual(
      { provider: entry.provider, model: entry.model, credentialId: entry.credentialId },
      { provider: 'groq', model: 'm1', credentialId: 'system:abcd' });
  });
});
