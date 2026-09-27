// test/briefing-interval.test.js — the runaway-trigger floor must admit the
// next scheduled slot.
//
// pg_cron fires at 02:30, 08:30 and 14:30 UTC — six hours apart. The morning
// brief's notification lands at ~02:31, so the 08:30 trigger arrived 5h59m
// after it and a 6h floor measured from the notification skipped it. For a
// week the midday brief was never delivered while morning and evening were.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { _recentlyRun, MIN_INTERVAL_HOURS, DELIVERY_GRACE_MINUTES } = require('../services/briefing');

const HOUR = 3600e3;
const MIN = 60e3;

/**
 * Stands in for Postgres: applies the window the query asks for, from the
 * parameters it actually passes, to one stored notification / execution time.
 */
function fakeDb({ lastDeliveredAgo = null, lastAttemptAgo = null }) {
  return async (sql, params) => {
    const now = Date.now();
    if (/FROM notifications/.test(sql)) {
      const [, hours, graceMin = '0'] = params;
      const cutoff = now - Number(hours) * HOUR + Number(graceMin) * MIN;
      const at = lastDeliveredAgo == null ? null : now - lastDeliveredAgo;
      return { rows: at != null && at > cutoff ? [{ created_at: new Date(at) }] : [] };
    }
    if (/FROM executions/.test(sql)) {
      const [, minutes] = params;
      const at = lastAttemptAgo == null ? null : now - lastAttemptAgo;
      return { rows: at != null && at > now - Number(minutes) * MIN ? [{ created_at: new Date(at) }] : [] };
    }
    throw new Error('unexpected query');
  };
}

describe('briefing minimum interval', () => {
  test('the next slot, six hours after a brief delivered a minute late, runs', async () => {
    assert.strictEqual(MIN_INTERVAL_HOURS, 6);
    const skip = await _recentlyRun(fakeDb({ lastDeliveredAgo: 6 * HOUR - 1 * MIN }), 'u1');
    assert.strictEqual(skip, null, `the midday brief must not be skipped: ${skip}`);
  });

  test('a slow run that finished several minutes late still admits the next slot', async () => {
    const skip = await _recentlyRun(fakeDb({ lastDeliveredAgo: 6 * HOUR - 8 * MIN }), 'u1');
    assert.strictEqual(skip, null);
  });

  test('a runaway trigger is still capped', async () => {
    for (const ago of [15 * MIN, 2 * HOUR, 5 * HOUR]) {
      const skip = await _recentlyRun(fakeDb({ lastDeliveredAgo: ago }), 'u1');
      assert.ok(skip, `a brief ${ago / MIN} minutes after the last must be skipped`);
    }
  });

  test('the grace is small next to the floor', () => {
    assert.ok(DELIVERY_GRACE_MINUTES <= 60,
      'the grace absorbs run duration; a large one would quietly lower the floor');
  });
});
