// test/mission-failure.test.js — what a failed mission run does to its schedule.
//
// On 2026-09-14 every provider was down for about 45 minutes. The claim lease
// retried Rasha's daily job hunt every 15 minutes, all three attempts failed,
// and the mission switched itself off. It stayed off for two weeks, because the
// switch-off notice was a 'mission' notification that the Telegram editor held.
// None of this needs a database: planFailure and the helpers are pure.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  isProviderOutage, planFailure, missionDateLine,
  OUTAGE_PREFIX, OUTAGE_RETRY_MINUTES, MAX_CONSECUTIVE_FAILURES
} = require('../services/agents/MissionScheduler');

const mission = (over = {}) => ({
  mission_id: 'mission_seed_rasha_jobhunt', cadence: 'daily',
  consecutive_failures: 0, last_result_preview: '# Career Intelligence Brief', ...over
});

test('the provider-exhausted error and its chat apology both read as an outage', () => {
  assert.ok(isProviderOutage('AI Inference unavailable across providers (tried: deepseek, groq).'));
  assert.ok(isProviderOutage('', 'I am currently experiencing temporary high traffic or network delays connecting to my inference engine (x).'));
  assert.ok(!isProviderOutage('ran out of tool-call/token budget before writing the report', '# A real but short report'));
  assert.ok(!isProviderOutage(undefined, null));
});

test('an outage never counts toward auto-disable, however many strikes are already on the row', () => {
  const now = Date.parse('2026-09-14T19:45:00Z');
  const plan = planFailure(mission({ consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1 }), { outage: true, now });
  assert.strictEqual(plan.autoDisable, false);
  assert.strictEqual(plan.failures, MAX_CONSECUTIVE_FAILURES - 1);
  assert.strictEqual(plan.nextRunAt, new Date(now + OUTAGE_RETRY_MINUTES * 60e3).toISOString());
});

test('a second outage in a row falls back to the regular schedule instead of retrying hourly', () => {
  const now = Date.now();
  const plan = planFailure(mission({ last_result_preview: `${OUTAGE_PREFIX}: AI Inference unavailable` }), { outage: true, now });
  // Daily cadence: the next regular slot is roughly a day out, not an hour.
  assert.ok(Date.parse(plan.nextRunAt) - now > 20 * 3600e3, `expected a daily slot, got ${plan.nextRunAt}`);
  assert.strictEqual(plan.autoDisable, false);
});

test('an ordinary failure still counts and still switches the mission off at the limit', () => {
  const first = planFailure(mission(), { outage: false });
  assert.deepStrictEqual(first, { failures: 1, autoDisable: false, nextRunAt: null });

  const last = planFailure(mission({ consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1 }), { outage: false });
  assert.strictEqual(last.autoDisable, true);
});

test('the run date is stated in IST, so an evening UTC run carries the next day', () => {
  // 20:00 UTC on 13 Sep is 01:30 IST on 14 Sep.
  const line = missionDateLine(new Date('2026-09-13T20:00:00Z'));
  assert.match(line, /TODAY IS 14 September 2026 \(IST\)/);
  assert.match(line, /report title/);
});
