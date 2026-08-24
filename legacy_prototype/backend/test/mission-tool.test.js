// test/mission-tool.test.js — chat-created standing tasks.
//
// Two things are worth guarding here, and neither needs a database:
//
// 1. Phrase → cadence. The user says "every day at 7am"; the scheduler stores
//    UTC cron. Getting the timezone arithmetic wrong is invisible — the task is
//    created, reported as scheduled, and then fires 5½ hours off.
// 2. Cron → next_run_at. next_run_at IS the schedule (the cron tick claims rows
//    by timestamp and never reads the pattern), so a pattern that does not
//    resolve to a real wall-clock slot silently degrades to "24h from now".
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeCadence, toUtc } = require('../tools/MissionTool');
const { nextCronRun, estimateNextRun, isValidCadence } = require('../services/agents/MissionScheduler');

const IST = 330;

test('cadence keywords and raw cron pass through untouched', () => {
  for (const k of ['daily', '6h', '1h', '15m']) {
    assert.strictEqual(normalizeCadence(k).cadence, k);
  }
  assert.strictEqual(normalizeCadence('0 */4 * * *').cadence, '0 */4 * * *');
});

test('"every day at 7am" IST becomes 01:30 UTC', () => {
  const { cadence, localTime } = normalizeCadence('every day at 7am', IST);
  assert.strictEqual(cadence, '30 1 * * *');
  assert.strictEqual(localTime, '07:00');
  assert.ok(isValidCadence(cadence));
});

test('a local time that lands before midnight UTC shifts the day back', () => {
  // 02:00 IST is 20:30 UTC the PREVIOUS day. For a daily task the date does not
  // matter, but for a weekday one it moves the cron's day-of-week.
  const { hour, minute, dayShift } = toUtc(2, 0, IST);
  assert.deepStrictEqual({ hour, minute, dayShift }, { hour: 20, minute: 30, dayShift: -1 });

  // Monday 02:00 IST → Sunday 20:30 UTC → dow 0.
  assert.strictEqual(normalizeCadence('every monday at 2am', IST).cadence, '30 20 * * 0');
});

test('weekday and interval phrases', () => {
  assert.strictEqual(normalizeCadence('every monday at 9pm', IST).cadence, '30 15 * * 1');
  assert.strictEqual(normalizeCadence('every 6 hours', IST).cadence, '6h');
  assert.strictEqual(normalizeCadence('hourly', IST).cadence, '1h');
  assert.strictEqual(normalizeCadence('every 4 hours', IST).cadence, '0 */4 * * *');
  // Below the engine's 15-minute floor, rounded up rather than accepted as a
  // schedule the cron tick could never honour.
  assert.strictEqual(normalizeCadence('every 5 minutes', IST).cadence, '15m');
});

test('"twice a day" keeps the minute offset of the local hour', () => {
  const { cadence } = normalizeCadence('twice a day', IST);
  assert.strictEqual(cadence, '30 2,14 * * *'); // 08:00 and 20:00 IST
});

test('an unreadable schedule falls back to daily and says so', () => {
  const out = normalizeCadence('whenever you feel like it', IST);
  assert.strictEqual(out.cadence, 'daily');
  assert.match(out.note, /defaulted to daily/);
});

test('nextCronRun resolves the next wall-clock slot in UTC', () => {
  const from = Date.parse('2026-08-23T05:00:00Z');
  assert.strictEqual(nextCronRun('30 1 * * *', from), '2026-08-24T01:30:00.000Z');
  assert.strictEqual(nextCronRun('30 1 * * *', Date.parse('2026-08-23T00:00:00Z')),
    '2026-08-23T01:30:00.000Z');
  assert.strictEqual(nextCronRun('*/15 * * * *', Date.parse('2026-08-23T05:07:00Z')),
    '2026-08-23T05:15:00.000Z');
  // 2026-08-23 is a Sunday; the next Monday 15:30 UTC is the 24th.
  assert.strictEqual(nextCronRun('30 15 * * 1', from), '2026-08-24T15:30:00.000Z');
});

test('nextCronRun declines patterns it cannot honestly resolve', () => {
  assert.strictEqual(nextCronRun('0 9 1 * *', Date.now()), null);   // day-of-month
  assert.strictEqual(nextCronRun('0 9 * 3 *', Date.now()), null);   // specific month
  assert.strictEqual(nextCronRun('0 9-17 * * *', Date.now()), null); // ranges
  assert.strictEqual(nextCronRun('nonsense', Date.now()), null);
});

test('estimateNextRun honours a cron pattern instead of "24h from now"', () => {
  const next = new Date(estimateNextRun('30 1 * * *'));
  assert.strictEqual(next.getUTCHours(), 1);
  assert.strictEqual(next.getUTCMinutes(), 30);
  assert.ok(next.getTime() > Date.now(), 'next run must be in the future');
  assert.ok(next.getTime() - Date.now() <= 24 * 3600e3, 'a daily slot is at most a day out');
});

test('keyword cadences keep their spread-across-the-hour behaviour', () => {
  // Two missions on the same keyword must not resolve to the same minute, or
  // they queue against the same rate-limited model together.
  const a = new Date(estimateNextRun('daily', 'mission_a')).getTime();
  const b = new Date(estimateNextRun('daily', 'mission_bbb')).getTime();
  assert.notStrictEqual(a, b);
});
