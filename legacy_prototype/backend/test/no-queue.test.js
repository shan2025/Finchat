// test/no-queue.test.js — the background queue is gone; keep it gone.
//
// Missions and briefings are started by the external cron service hitting
// /api/cron/tick and /api/cron/briefing. Scheduling state lives in
// agent_missions.next_run_at. There is no queue and no in-process scheduler —
// which is what stops a Redis outage from crash-looping the server and what
// stops an idle worker from silently spending an entire Upstash plan.
//
// What is banned is the *queue*: bullmq and its persistent ioredis socket.
// services/redis.js is a different thing and stays — it caches over Upstash's
// REST API with axios, makes a request only when something asks it to, and
// returns null (falling back to no-op) when the credentials are absent, so it
// can neither crash-loop the process nor burn quota while idle.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'test']);

/** Every .js file that ships as part of the running server. */
function sourceFiles(dir = BACKEND, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('no background queue', () => {
  test('nothing in the backend requires bullmq or ioredis', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      if (/require\(\s*['"](bullmq|ioredis)['"]\s*\)/.test(src)) {
        offenders.push(path.relative(BACKEND, file));
      }
    }
    assert.deepStrictEqual(offenders, [],
      `these files pull the queue back in: ${offenders.join(', ')}`);
  });

  test('neither package is declared as a dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(!deps.bullmq, 'bullmq should not be a dependency');
    assert.ok(!deps.ioredis, 'ioredis should not be a dependency');
  });

  test('the WorkerPool module is deleted, not merely unused', () => {
    assert.ok(
      !fs.existsSync(path.join(BACKEND, 'services', 'queue', 'WorkerPool.js')),
      'services/queue/WorkerPool.js should be gone'
    );
  });

  test('MissionScheduler no longer mirrors schedules into a queue', () => {
    const sched = require('../services/agents/MissionScheduler');
    assert.strictEqual(sched.syncMissionSchedules, undefined,
      'syncMissionSchedules mirrored next_run_at into BullMQ and should not come back');
    assert.strictEqual(typeof sched.runMission, 'function');
    assert.strictEqual(typeof sched.estimateNextRun, 'function');
  });

  test('enabling a mission is what schedules it: next_run_at is in the future', () => {
    const { estimateNextRun } = require('../services/agents/MissionScheduler');
    for (const cadence of ['15m', '1h', '6h', 'daily']) {
      const when = new Date(estimateNextRun(cadence, `mission_${cadence}`));
      assert.ok(when.getTime() > Date.now(),
        `${cadence} must produce a future next_run_at for the cron tick to claim`);
    }
  });

  test('same-cadence missions are spread out, not stacked on one timestamp', () => {
    const { estimateNextRun } = require('../services/agents/MissionScheduler');
    // The cron tick claims up to 5 due missions per call and runs them back to
    // back against the same rate-limited model, so identical timestamps are a
    // real failure mode, not a cosmetic one.
    const a = new Date(estimateNextRun('daily', 'mission_alpha')).getTime();
    const b = new Date(estimateNextRun('daily', 'mission_beta')).getTime();
    assert.notStrictEqual(a, b, 'two daily missions should not come due at the same instant');
  });

  test('the briefing runs as a plain service call', () => {
    const briefing = require('../services/briefing');
    assert.strictEqual(typeof briefing.runMorningBriefing, 'function');
    assert.strictEqual(typeof briefing.briefingSessionTitle, 'function');
    assert.match(briefing.briefingSessionTitle(new Date('2026-08-16')), /16 Aug 2026/);
  });

  test('cron routes are the only scheduling entry point', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'routes', 'cron.js'), 'utf8');
    assert.match(src, /\/tick/, 'the mission tick endpoint must exist');
    assert.match(src, /\/briefing/, 'the briefing endpoint must exist');
    assert.match(src, /runMorningBriefing/, 'briefing must be invoked directly, not queued');
  });
});
