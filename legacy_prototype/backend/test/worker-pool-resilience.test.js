// test/worker-pool-resilience.test.js — Redis being down must not kill the app.
//
// Regression cover for the crash-loop of 15 Aug 2026: Upstash's monthly request
// cap was spent, BullMQ's Queue re-emitted the AUTH failure as an 'error' event
// with no listener, Node turned that into an uncaught exception, and the whole
// server died and restarted on a loop. The queue is a background convenience;
// losing it must degrade to "missions don't fire", never to "the site is down".
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'services', 'queue', 'WorkerPool.js');

// Nothing is listening here. These tests must never reach the real Upstash
// instance: it would spend the very request quota whose exhaustion they cover,
// and a unit test that needs the network isn't a unit test.
const DEAD_REDIS = 'redis://127.0.0.1:6399';

// Set for the whole file, not per test: the connection is built lazily inside
// getQueue(), so a value restored right after require() would already be gone
// by the time anything actually dials out — which is how an earlier version of
// this test ended up connecting to the live instance.
process.env.QUEUE_REDIS_URL = DEAD_REDIS;

/**
 * Load a fresh copy of the module so per-process disable state doesn't leak.
 * `env` is applied only across the require itself, which is where load-time
 * settings like DISABLE_QUEUE are read.
 */
function loadFresh(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete require.cache[require.resolve(MODULE)];
  const mod = require(MODULE);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return mod;
}

/**
 * Drop any live socket the test opened. Without this the ioredis retry timer
 * keeps the event loop alive and `node --test` never exits — the disable path
 * is also the teardown path, so reuse it.
 */
function teardown(wp) {
  wp.getQueue()?.emit('error', new Error('ERR max requests limit exceeded. Limit: 1, Usage: 2.'));
}

describe('WorkerPool resilience', () => {
  test('DISABLE_QUEUE=true yields no queue instead of a connection attempt', () => {
    const wp = loadFresh({ DISABLE_QUEUE: 'true' });
    assert.strictEqual(wp.isQueueAvailable(), false);
    assert.strictEqual(wp.getQueue(), null, 'getQueue() must return null, not a live Queue');
    assert.strictEqual(wp.startWorkerPool(), null, 'worker pool must refuse to start');
  });

  test('callers that need a queue get the reason, not a null dereference', async () => {
    const wp = loadFresh({ DISABLE_QUEUE: 'true' });
    await assert.rejects(
      () => wp.enqueueExecutionJob({ personaId: 'plato', userMessage: 'hi' }),
      /Background queue unavailable/,
      'enqueue must fail with a message naming the cause'
    );
    await assert.rejects(
      () => wp.scheduleMorningBriefing({ userId: 'u1' }),
      /Background queue unavailable/
    );
  });

  test('mission sync is a no-op, not a throw, when the queue is gone', async () => {
    loadFresh({ DISABLE_QUEUE: 'true' });
    const { syncMissionSchedules } = require('../services/agents/MissionScheduler');
    const res = await syncMissionSchedules();
    assert.strictEqual(res.scheduled, 0);
    assert.strictEqual(res.skipped, 'queue unavailable');
  });

  test('a quota error disables the queue rather than propagating', () => {
    const wp = loadFresh();
    // The exact shape Upstash returns on every command once the cap is spent.
    const quotaErr = new Error(
      'ERR max requests limit exceeded. Limit: 500000, Usage: 500005.'
    );
    const q = wp.getQueue();
    assert.ok(q, 'queue should be constructed before the quota error arrives');
    assert.strictEqual(wp.isQueueAvailable(), true);

    // Emitting 'error' is what previously crashed the process. It must be
    // absorbed, and it must switch the queue off so nothing keeps retrying
    // against an allowance that is already spent.
    assert.doesNotThrow(() => q.emit('error', quotaErr));
    assert.strictEqual(wp.isQueueAvailable(), false);
    assert.strictEqual(wp.getQueue(), null);
  });

  test('an ordinary connection blip is absorbed but leaves the queue enabled', () => {
    const wp = loadFresh();
    const q = wp.getQueue();
    assert.doesNotThrow(() => q.emit('error', new Error('ECONNRESET')));
    assert.strictEqual(wp.isQueueAvailable(), true, 'a transient fault must not retire the queue');
    teardown(wp);
  });
});
