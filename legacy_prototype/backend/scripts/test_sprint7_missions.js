// Sprint 7 — mission engine: CRUD + validation, next_run_at scheduling state,
// per-run token budget threading, failure backoff + auto-disable, and the
// human-approval state transitions (approve/reject).
// Requires the server running on :3000. Run: node scripts/test_sprint7_missions.js

const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const jwt = require(B + '/node_modules/jsonwebtoken');
const { query } = require(B + '/database');

const UID = '66092ed7-e536-4ed9-ad17-633a5072a65e'; // Bro Test
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

const api = async (path, opts = {}, token) => {
  const res = await fetch('http://localhost:3000/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = {}; }
  return { status: res.status, ok: res.ok, body };
};

(async () => {
  const t = jwt.sign({ userId: UID }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const OTHER = jwt.sign({ userId: 'test_memory_user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const Sched = require(B + '/services/agents/MissionScheduler');
  const cleanupIds = [];

  // ── 1. Seeds shipped disabled ────────────────────────────────
  console.log('\n=== 1. Flagship seeds (disabled by default) ===');
  const seeds = await query(`SELECT mission_id, agent_id, enabled FROM agent_missions WHERE mission_id LIKE 'mission_seed_%' ORDER BY mission_id`);
  ok(seeds.rows.length === 3, 'three flagship seed missions exist');
  ok(seeds.rows.every(s => s.enabled === false), 'ALL seeds are disabled (no unattended token burn)');
  ok(new Set(seeds.rows.map(s => s.agent_id)).size === 3, 'seeds cover rasha, aurelius, nova');

  // ── 2. CRUD + validation via API ─────────────────────────────
  console.log('\n=== 2. Mission CRUD ===');
  const created = await api('/missions', { method: 'POST', body: JSON.stringify({
    agentId: 'nova', title: 'T7 test mission', goal: 'Say the word "pong" and nothing else.', cadence: '1h', maxTokensPerRun: 1500
  }) }, t);
  ok(created.status === 201 && created.body.mission, 'create returns 201 + mission');
  const mid = created.body.mission.mission_id;
  cleanupIds.push(mid);
  ok(created.body.mission.enabled === false, 'new missions start paused');
  ok(created.body.mission.max_tokens_per_run === 1500, 'budget stored');

  const badCadence = await api('/missions', { method: 'POST', body: JSON.stringify({
    agentId: 'nova', title: 'x', goal: 'y', cadence: 'whenever' }) }, t);
  ok(badCadence.status === 400 && /cadence/i.test(badCadence.body.error), 'invalid cadence rejected with 400');

  const listed = await api('/missions', {}, t);
  ok(listed.ok && listed.body.missions.some(m => m.mission_id === mid), 'list includes the new mission');

  const otherList = await api('/missions', {}, OTHER);
  ok(otherList.ok && !otherList.body.missions.some(m => m.mission_id === mid), "another user's list can NOT see it");
  const otherUpd = await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ title: 'hijack' }) }, OTHER);
  ok(otherUpd.status === 404, "another user's update gets 404");

  const upd = await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ cadence: '15m', maxTokensPerRun: 999999 }) }, t);
  ok(upd.ok && upd.body.mission.cadence === '15m', 'cadence update persists');
  ok(upd.body.mission.max_tokens_per_run === 80000, 'budget clamped to sane ceiling');

  // ── 3. Scheduling state on the row (what the cron tick claims) ─
  // Scheduling lives entirely in agent_missions.next_run_at now; there is no
  // queue to reconcile against, so these assertions read the row directly.
  console.log('\n=== 3. next_run_at scheduling ===');
  const nextRunFor = async id =>
    (await query('SELECT next_run_at FROM agent_missions WHERE mission_id = $1', [id])).rows[0]?.next_run_at;

  await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ enabled: true }) }, t);
  let nextRun = await nextRunFor(mid);
  ok(!!nextRun, 'enabling sets next_run_at so the cron tick can claim it');
  ok(new Date(nextRun).getTime() > Date.now(), 'next_run_at is in the future');

  await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ cadence: '6h' }) }, t);
  const afterCadence = await nextRunFor(mid);
  ok(!!afterCadence, 'cadence change keeps the mission scheduled');

  await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ enabled: false }) }, t);
  ok((await nextRunFor(mid)) === null, 'disabling clears next_run_at so nothing claims it');

  // ── 4. Budget threading into executions ──────────────────────
  console.log('\n=== 4. Per-run budget threading ===');
  const CognitiveCore = require(B + '/services/cognitive/CognitiveCore');
  // Direct run with a budget override — verify the executions row records it.
  const PlatoOrch = require(B + '/services/agents/PlatoOrchestrator');
  const realRoute = PlatoOrch.route;
  // (Use the real cognitive path but a trivial goal so it resolves in one turn.)
  const runRes = await realRoute({
    goal: 'Reply with exactly: pong', userId: UID, conversationId: 'mission_' + mid,
    targetAgentId: 'nova', budget: { maxTokens: 1234, maxRuntimeSeconds: 90 }
  });
  const execRow = await query('SELECT max_tokens, max_runtime_seconds, conversation_id FROM executions WHERE execution_id = $1', [runRes.executionId]);
  ok(execRow.rows.length === 1, 'execution row exists for the mission run');
  ok(execRow.rows[0].max_tokens === 1234, 'max_tokens_per_run threads into executions.max_tokens');
  ok(execRow.rows[0].max_runtime_seconds === 90, 'runtime budget threads too');
  ok(execRow.rows[0].conversation_id === 'mission_' + mid, 'run is linked to the mission via conversation_id');

  const hist = await api('/missions/' + mid + '/history', {}, t);
  ok(hist.ok && hist.body.runs.some(r => r.execution_id === runRes.executionId), 'mission history returns the run with telemetry');
  ok(hist.body.runs.every(r => 'tokens_used' in r && 'duration_seconds' in r), 'history rows carry token + duration telemetry');

  // ── 5. Failure backoff + auto-disable ────────────────────────
  console.log('\n=== 5. Failure backoff ===');
  PlatoOrch.route = async () => { throw new Error('synthetic mission failure'); };
  try {
    await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ enabled: true }) }, t);
    for (let i = 1; i <= Sched.MAX_CONSECUTIVE_FAILURES; i++) {
      const r = await Sched.runMission(mid);
      ok(r.success === false && r.failures === i, `failure ${i} recorded (consecutive_failures=${i})`);
    }
    const after = await query('SELECT enabled, consecutive_failures, last_result_preview FROM agent_missions WHERE mission_id = $1', [mid]);
    ok(after.rows[0].enabled === false, `auto-disabled after ${Sched.MAX_CONSECUTIVE_FAILURES} consecutive failures`);
    ok(/FAILED: synthetic/.test(after.rows[0].last_result_preview), 'failure reason recorded on the mission row');
    const repsAfter = await repeatablesFor(mid);
    ok(repsAfter.length === 0, 'auto-disable also removed the schedule');
    const reEnable = await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ enabled: true }) }, t);
    ok(reEnable.body.mission.consecutive_failures === 0, 're-enabling resets the failure counter');
    await api('/missions/' + mid, { method: 'PUT', body: JSON.stringify({ enabled: false }) }, t);
  } finally {
    PlatoOrch.route = realRoute;
  }

  // ── 6. Approval-gate state transitions ───────────────────────
  console.log('\n=== 6. Human-approval gate ===');
  // Fixture: an execution parked in waiting(human_approval) with a pending tool log.
  const execId = 'exec_t7_approval_' + Date.now();
  await query(`
    INSERT INTO executions (execution_id, user_id, goal, assigned_agent, current_state, wait_reason,
                            max_iterations, max_tool_calls, max_tokens, max_runtime_seconds,
                            iterations_used, tool_calls_used, tokens_used)
    VALUES ($1, $2, 'T7 approval fixture', 'rasha', 'waiting', 'human_approval', 8, 5, 5000, 60, 1, 0, 0)
  `, [execId, UID]);
  await query(`
    INSERT INTO execution_logs (execution_id, phase, step_number, content, started_at, ended_at, duration_ms)
    VALUES ($1, 'waiting', 1, $2, now(), now(), 0)
  `, [execId, JSON.stringify({ reason: 'human_approval', pendingTool: 'apply_draft', pendingInput: '{}' })]);

  const waitingList = await api('/executions?state=waiting', {}, t);
  ok(waitingList.ok && waitingList.body.executions.some(x => x.execution_id === execId), 'waiting list surfaces the approval');
  const found = waitingList.body.executions.find(x => x.execution_id === execId);
  ok(found && found.waiting_info && found.waiting_info.pendingTool === 'apply_draft', 'waiting_info carries the pending tool name');

  const otherReject = await api('/executions/' + execId + '/reject', { method: 'POST', body: '{}' }, OTHER);
  ok(otherReject.status === 404, "another user cannot reject someone else's execution");

  const rejected = await api('/executions/' + execId + '/reject', { method: 'POST', body: JSON.stringify({ reason: 'not now' }) }, t);
  ok(rejected.ok && rejected.body.status === 'rejected', 'reject endpoint succeeds');
  const afterReject = await query('SELECT current_state, completion_reason FROM executions WHERE execution_id = $1', [execId]);
  ok(afterReject.rows[0].current_state === 'cancelled', 'reject transitions waiting → cancelled');
  ok(afterReject.rows[0].completion_reason === 'rejected_by_user', 'completion_reason records the rejection');

  const rejectTwice = await api('/executions/' + execId + '/reject', { method: 'POST', body: '{}' }, t);
  ok(rejectTwice.status === 400, 'terminal executions cannot be rejected again');

  // ── cleanup (children before parents: tool_results → tool_calls →
  //     execution_logs → executions) ────────────────────────────
  for (const id of cleanupIds) await api('/missions/' + id, { method: 'DELETE' }, t);
  const staleExec = `SELECT execution_id FROM executions WHERE execution_id = '${execId}' OR (conversation_id LIKE 'mission_mission_%' AND goal LIKE 'Reply with exactly: pong%')`;
  await query(`DELETE FROM tool_results WHERE call_id IN (SELECT call_id FROM tool_calls WHERE execution_id IN (${staleExec}))`);
  await query(`DELETE FROM tool_calls WHERE execution_id IN (${staleExec})`);
  await query(`DELETE FROM execution_logs WHERE execution_id IN (${staleExec})`);
  await query(`DELETE FROM executions WHERE execution_id IN (${staleExec})`);
  const gone = await api('/missions', {}, t);
  ok(!gone.body.missions.some(m => m.mission_id === mid), 'cleanup: test mission deleted');

  console.log(`\n=== Sprint 7 missions: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
