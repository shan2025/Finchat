// test/inference-routing.test.js — workloads must not share one provider pool.
//
// Groq's free tier is 200,000 tokens per model per DAY and a single research
// run costs 25k-54k. On 2026-08-17 three briefings plus a digest consumed
// 199,393 of 200,000 on gpt-oss-120b, and interactive chat then answered
// "AI Inference unavailable across providers" because everything drew on the
// same allowance.
//
// Routing is an ORDER, not an exclusive: every workload must still be able to
// reach every configured provider, so a spent Groq day degrades a briefing to
// Gemini instead of failing it.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  providerOrderFor, WORKLOAD_ROUTES, IMPATIENT_WORKLOADS
} = require('../services/inference');

const ALL_PROVIDERS = ['groq', 'gemini', 'deepseek'];

describe('per-workload provider routing', () => {
  test('interactive chat prefers a different provider than scheduled research', () => {
    const chat = providerOrderFor('chat')[0];
    const briefing = providerOrderFor('briefing')[0];
    const mission = providerOrderFor('mission')[0];

    assert.notStrictEqual(chat, briefing,
      'chat and briefing must not lead with the same provider, or they share one pool');
    assert.strictEqual(briefing, mission,
      'both scheduled workloads should lead with the same provider');
  });

  test('every workload can still reach every provider', () => {
    for (const w of ['chat', 'briefing', 'mission', 'mindmap', 'report']) {
      const order = providerOrderFor(w);
      for (const p of ALL_PROVIDERS) {
        assert.ok(order.includes(p),
          `"${w}" must still be able to fall through to ${p} — routing is an order, not an exclusive`);
      }
    }
  });

  test('an unknown workload gets the default order, not an empty one', () => {
    const order = providerOrderFor('something-nobody-registered');
    assert.ok(order.length >= ALL_PROVIDERS.length,
      'unknown workloads must fall back to the full default chain');
  });

  test('a provider missing from a route is appended, never silently dropped', () => {
    // A typo in an env var must not disable a provider that has a working key.
    for (const [name, route] of Object.entries(WORKLOAD_ROUTES)) {
      const resolved = providerOrderFor(name);
      assert.strictEqual(new Set(resolved).size, resolved.length,
        `"${name}" resolved order must not contain duplicates`);
      for (const p of route) {
        if (ALL_PROVIDERS.includes(p)) {
          assert.ok(resolved.includes(p), `"${p}" from route "${name}" must survive resolution`);
        }
      }
    }
  });

  test('chat is impatient; scheduled work is not', () => {
    // Waiting out a rate limit is right for a background run and wrong when
    // somebody is watching a chat window: there is another provider one line
    // down that can answer immediately.
    assert.ok(IMPATIENT_WORKLOADS.has('chat'),
      'chat must not sit out a rate limit');
    assert.ok(!IMPATIENT_WORKLOADS.has('briefing'),
      'a briefing has nobody waiting, so it should wait out a throttle');
    assert.ok(!IMPATIENT_WORKLOADS.has('mission'),
      'a mission has nobody waiting, so it should wait out a throttle');
  });
});
