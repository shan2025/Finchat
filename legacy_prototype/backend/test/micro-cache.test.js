// test/micro-cache.test.js
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const microCache = require('../services/microCache');

describe('microCache', () => {
  beforeEach(() => microCache.invalidate());

  test('calls the loader once and serves the cached value afterwards', async () => {
    let calls = 0;
    const load = async () => { calls++; return 'value'; };

    assert.equal(await microCache.cached('k', 60_000, load), 'value');
    assert.equal(await microCache.cached('k', 60_000, load), 'value');
    assert.equal(calls, 1, 'loader should not run again inside the TTL');
  });

  test('re-loads once the TTL has passed', async () => {
    let calls = 0;
    const load = async () => { calls++; return calls; };

    assert.equal(await microCache.cached('k', 1, load), 1);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(await microCache.cached('k', 1, load), 2);
  });

  test('concurrent misses share one in-flight load', async () => {
    // The point of the cache is removing round trips; a cold cache under
    // load must not fire one query per waiting caller.
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise(r => setTimeout(r, 20));
      return 'shared';
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => microCache.cached('k', 60_000, load))
    );

    assert.deepEqual(results, Array(10).fill('shared'));
    assert.equal(calls, 1, 'ten concurrent callers should trigger one load');
  });

  test('a failed load is not cached and does not poison later reads', async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'recovered';
    };

    await assert.rejects(() => microCache.cached('k', 60_000, load), /boom/);
    assert.equal(await microCache.cached('k', 60_000, load), 'recovered');
    assert.equal(calls, 2);
  });

  test('a rejected in-flight load rejects every concurrent caller', async () => {
    const load = async () => {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('boom');
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => microCache.cached('k', 60_000, load))
    );
    assert.ok(settled.every(s => s.status === 'rejected'));

    // and the key is left clean for a retry
    assert.equal(await microCache.cached('k', 60_000, async () => 'ok'), 'ok');
  });

  test('invalidate(key) drops only that key', async () => {
    await microCache.cached('a', 60_000, async () => 'A');
    await microCache.cached('b', 60_000, async () => 'B');

    microCache.invalidate('a');

    assert.equal(await microCache.cached('a', 60_000, async () => 'A2'), 'A2');
    assert.equal(await microCache.cached('b', 60_000, async () => 'B2'), 'B');
  });

  test('keeps its entry count bounded', async () => {
    for (let i = 0; i < 600; i++) {
      await microCache.cached('key' + i, 60_000, async () => i);
    }
    assert.ok(microCache.stats().size <= 500, `size was ${microCache.stats().size}`);
  });
});
