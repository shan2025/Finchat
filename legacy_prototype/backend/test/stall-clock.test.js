// test/stall-clock.test.js — provider backoff must not be charged to the goal.
//
// A mission hit Groq's daily allowance, spent ~120s of a 180s runtime budget
// asleep in 429 retries, and was cut off at 203s having done under a minute of
// real work. The ledger exists so that waiting is measured separately; the
// isolation test is the one that matters, because WorkerPool runs executions
// concurrently and a shared counter would let one run's backoff pay for
// another's overrun.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithStallClock, recordStall, stalledMs } = require('../services/cognitive/StallClock');
const { evaluateBudget } = require('../services/cognitive/ExecutionManager');

test.describe('the stall ledger', () => {
  test('accumulates only inside a ledger', async () => {
    recordStall(500); // outside — no ledger to land in
    assert.equal(stalledMs(), 0);

    await runWithStallClock(async () => {
      assert.equal(stalledMs(), 0);
      recordStall(1500);
      recordStall(2000);
      assert.equal(stalledMs(), 3500);
    });

    assert.equal(stalledMs(), 0, 'the ledger does not outlive the run');
  });

  test('concurrent runs keep separate ledgers', async () => {
    const seen = {};
    await Promise.all([
      runWithStallClock(async () => {
        recordStall(1000);
        await new Promise(r => setTimeout(r, 10)); // interleave with the other run
        recordStall(1000);
        seen.a = stalledMs();
      }),
      runWithStallClock(async () => {
        recordStall(50);
        await new Promise(r => setTimeout(r, 5));
        seen.b = stalledMs();
      }),
    ]);

    assert.equal(seen.a, 2000);
    assert.equal(seen.b, 50, "one run's backoff is not billed to the other");
  });

  test('a nested call reuses the outer ledger rather than resetting it', async () => {
    await runWithStallClock(async () => {
      recordStall(700);
      await runWithStallClock(async () => recordStall(300));
      assert.equal(stalledMs(), 1000);
    });
  });

  test('discounted time keeps a stalled run inside its runtime ceiling', () => {
    // 200s of wall clock against a 180s ceiling, of which 120s was backoff.
    const row = {
      iterations_used: 2, max_iterations: 8,
      tool_calls_used: 3, max_tool_calls: 12,
      tokens_used: 9000, max_tokens: 65000,
      max_runtime_seconds: 180,
      created_at: new Date(Date.now() - 200_000).toISOString(),
    };

    assert.equal(evaluateBudget(row).details.runtimeSeconds.breached, true,
      'raw wall clock still breaches — that is the behaviour being corrected');

    const discounted = evaluateBudget(row, Date.now() - 120_000);
    assert.equal(discounted.details.runtimeSeconds.breached, false);
    assert.equal(discounted.breached, false, 'the run may continue and write its report');
  });
});
