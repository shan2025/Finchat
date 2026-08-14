// services/agents/MissionScheduler.js — Sprint 7 mission engine.
// A mission = a standing goal an agent re-runs on a schedule. Backed by the
// agent_missions table + BullMQ repeatable jobs (same queue/worker as the
// morning briefing). Every run goes through the normal PlatoOrchestrator path,
// so Sentinel pre-checks, token telemetry, and the approval gate all apply.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../database');
const { eventBus } = require('../cognitive/EventBus');

const MISSION_JOB = 'agent-mission';
const MAX_CONSECUTIVE_FAILURES = 3;

// A research mission's plan is several tool steps, and the synthesis pass that
// turns those results into the actual report costs budget of its own. The
// ExecutionManager default of 5 tool calls is spent by the research alone —
// which is how "Monitor the stock market" burned 5/5 calls in 19 seconds and
// delivered the string "Budget exceeded during plan execution." as the day's
// market brief. Give missions room to research *and* write.
const MISSION_MAX_TOOL_CALLS = 12;

// Upper bound a user may set for one mission run. Generous on purpose: the
// binding cost is the provider's daily allowance, not this number, and a
// too-low ceiling fails invisibly as a truncated run rather than as an error.
const MAX_TOKENS_CEILING = 80000;

// completion_reason values that mean the run produced no real report.
//
// runMission used to deliver whatever string came back regardless, so a failed
// synthesis went out titled "🗓️ Mission report: …" carrying an apology about
// inference being unavailable, or a raw dump of the agent's own plan JSON —
// and recorded consecutive_failures = 0, so the backoff never engaged and
// nothing anywhere said the run had failed.
const FAILED_REASONS = new Set(['error', 'budget_exceeded', 'failed', 'timeout']);

// Thrown when a run completes technically but has nothing worth sending, so the
// existing failure bookkeeping (backoff, auto-disable) handles it unchanged.
class DegradedRunError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'DegradedRunError';
    this.completionReason = reason;
  }
}

// Deterministic 0–50 minute offset per mission. Every 'daily' mission used to
// fire at exactly 08:00, so three of them plus the morning briefing hit the
// same rate-limited Groq model within four minutes of each other — which is
// what "AI Inference unavailable across providers" was reporting. Stable per
// mission id, so syncMissionSchedules still recognises its own patterns.
function minuteOffset(missionId) {
  let h = 0;
  for (const ch of String(missionId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Minute granularity, not five-minute buckets: with only a handful of
  // missions, 12 buckets collide often enough that two still fire together.
  return h % 60;
}

// Cadence keywords → cron patterns (raw cron strings pass through untouched).
const CADENCE_CRON = {
  '15m': '*/15 * * * *',
  '1h': '0 * * * *',
  '6h': '0 */6 * * *',
  'daily': '0 8 * * *'
};

function cadenceToCron(cadence, missionId = null) {
  const c = String(cadence || 'daily').trim();
  const base = CADENCE_CRON[c];
  if (!base) return c; // assume raw cron if not a keyword
  // Spread same-cadence missions across the hour so they do not all queue
  // against the same model at once. See minuteOffset.
  if (missionId && (c === 'daily' || c === '6h')) {
    return base.replace(/^0 /, `${minuteOffset(missionId)} `);
  }
  return base;
}

function isValidCadence(cadence) {
  const c = String(cadence || '').trim();
  if (CADENCE_CRON[c]) return true;
  // Loose 5-field cron validation
  return /^(\S+\s+){4}\S+$/.test(c);
}

// Rough next-fire estimate for UI display (exact scheduling is BullMQ's job).
function estimateNextRun(cadence, missionId = null) {
  const now = Date.now();
  const c = String(cadence || 'daily');
  const steps = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, 'daily': 24 * 3600e3 };
  // The external cron (/api/cron/tick) schedules off next_run_at, and claims up
  // to 5 due missions in one batch, so identical timestamps put them back to
  // back against the same model. Offset them the same way the cron pattern is.
  const spread = missionId && (c === 'daily' || c === '6h') ? minuteOffset(missionId) * 60e3 : 0;
  return new Date(now + (steps[c] || 24 * 3600e3) + spread).toISOString();
}

// ── CRUD helpers (used by routes/missions.js) ───────────────────

async function listMissions(userId) {
  const res = await query(
    'SELECT * FROM agent_missions WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
  return res.rows;
}

async function getMission(missionId, userId = null) {
  const res = userId
    ? await query('SELECT * FROM agent_missions WHERE mission_id = $1 AND user_id = $2', [missionId, userId])
    : await query('SELECT * FROM agent_missions WHERE mission_id = $1', [missionId]);
  return res.rows[0] || null;
}

async function createMission({ userId, agentId, title, goal, cadence = 'daily', enabled = false, maxTokensPerRun = 4000 }) {
  if (!userId || !agentId || !title || !goal) throw new Error('userId, agentId, title and goal are required');
  if (!isValidCadence(cadence)) throw new Error(`Invalid cadence "${cadence}" — use 15m, 1h, 6h, daily, or a 5-field cron pattern`);
  const id = `mission_${uuidv4()}`;
  const res = await query(`
    INSERT INTO agent_missions (mission_id, user_id, agent_id, title, goal, cadence, enabled, max_tokens_per_run, next_run_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [id, userId, agentId, title, goal, cadence, !!enabled, maxTokensPerRun, enabled ? estimateNextRun(cadence, id) : null]);
  await syncMissionSchedules();
  return res.rows[0];
}

async function updateMission(missionId, userId, patch = {}) {
  const mission = await getMission(missionId, userId);
  if (!mission) return null;

  const fields = [];
  const params = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); params.push(val); };

  if (patch.title != null) set('title', patch.title);
  if (patch.goal != null) set('goal', patch.goal);
  if (patch.cadence != null) {
    if (!isValidCadence(patch.cadence)) throw new Error(`Invalid cadence "${patch.cadence}"`);
    set('cadence', patch.cadence);
  }
  if (patch.enabled != null) {
    set('enabled', !!patch.enabled);
    set('consecutive_failures', 0); // re-enabling resets the backoff counter
    set('next_run_at', patch.enabled ? estimateNextRun(patch.cadence || mission.cadence, missionId) : null);
  }
  // 20000 was below what a research mission actually costs: each reasoning pass
  // re-sends the accumulated tool output, so a five-source brief spent 20187
  // tokens and was cut off before writing a word of the report. The ceiling has
  // to sit above the real cost or the budget silently caps every run.
  if (patch.maxTokensPerRun != null) set('max_tokens_per_run', Math.max(500, Math.min(MAX_TOKENS_CEILING, patch.maxTokensPerRun)));
  if (!fields.length) return mission;

  set('updated_at', new Date());
  params.push(missionId, userId);
  const res = await query(
    `UPDATE agent_missions SET ${fields.join(', ')} WHERE mission_id = $${i++} AND user_id = $${i} RETURNING *`, params);
  await syncMissionSchedules();
  return res.rows[0];
}

async function deleteMission(missionId, userId) {
  const res = await query(
    'DELETE FROM agent_missions WHERE mission_id = $1 AND user_id = $2 RETURNING mission_id', [missionId, userId]);
  if (res.rows.length) await syncMissionSchedules();
  return res.rows.length > 0;
}

// ── Scheduling: one BullMQ repeatable job per enabled mission ───

/**
 * Reconcile BullMQ repeatable jobs with the agent_missions table:
 * remove schedules for disabled/deleted/re-cadenced missions, add missing ones.
 * Idempotent — safe to call after any mission mutation and on boot.
 */
async function syncMissionSchedules() {
  const { getQueue } = require('../queue/WorkerPool');
  const q = getQueue();

  const enabledRes = await query('SELECT mission_id, cadence FROM agent_missions WHERE enabled = true');
  const wanted = new Map(enabledRes.rows.map(m => [m.mission_id, cadenceToCron(m.cadence, m.mission_id)]));

  // BullMQ job schedulers: key = mission_id, so reconciliation is exact.
  // (Plain repeatable jobs don't expose their jobId in this BullMQ version.)
  const schedulers = await q.getJobSchedulers();
  const existing = new Map();
  for (const s of schedulers) {
    if (s.name !== MISSION_JOB) continue;
    const want = wanted.get(s.key);
    if (!want || want !== s.pattern) {
      await q.removeJobScheduler(s.key); // stale: disabled, deleted, or cadence changed
    } else {
      existing.set(s.key, s.pattern);
    }
  }

  let added = 0;
  for (const [missionId, cron] of wanted) {
    if (existing.has(missionId)) continue;
    await q.upsertJobScheduler(missionId, { pattern: cron }, {
      name: MISSION_JOB,
      data: { missionId },
      opts: {
        attempts: 1, // failure handling is ours (consecutive_failures backoff)
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 }
      }
    });
    added++;
  }

  const summary = { scheduled: wanted.size, added };
  if (added > 0) console.log(`🗓️ [Missions] Schedules synced: ${wanted.size} enabled, ${added} newly registered`);
  return summary;
}

// ── Execution: what happens when a mission fires ────────────────

/**
 * Run one mission now (called by the BullMQ worker on schedule, or by
 * POST /api/missions/:id/run-now). Enforces per-run token budget, records
 * telemetry on the mission row, notifies the user, and backs off after
 * repeated failures (auto-disable at MAX_CONSECUTIVE_FAILURES).
 */
async function runMission(missionId, { manual = false } = {}) {
  const mission = await getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  if (!mission.enabled && !manual) {
    console.log(`🗓️ [Missions] Skipping disabled mission ${missionId}`);
    return { skipped: true, reason: 'disabled' };
  }

  console.log(`🗓️ [Missions] Running "${mission.title}" [${mission.agent_id}] for user ${mission.user_id}${manual ? ' (manual)' : ''}`);
  const start = Date.now();

  try {
    const { route } = require('./PlatoOrchestrator');
    // Autonomous framing: without this, chat-tuned models tend to ANNOUNCE what
    // they would do ("I will fetch...") instead of doing it — there is no user
    // in the loop to say "go ahead" on a scheduled run.
    const missionGoal =
      `${mission.goal}\n\n[AUTONOMOUS SCHEDULED RUN — nobody will reply to you. ` +
      `This is a multi-step goal: use action "plan" on your FIRST turn so every ` +
      `tool step runs in one pass. Do NOT describe what you are about to do or ask ` +
      `for confirmation, and never invent numbers or URLs — only report what tools returned. ` +
      `A response that only promises future work is a FAILED run.]`;
    const result = await route({
      goal: missionGoal,
      userId: mission.user_id,
      conversationId: `mission_${mission.mission_id}`,
      targetAgentId: mission.agent_id,
      allowWeb: true,
      budget: {
        maxTokens: mission.max_tokens_per_run,
        maxRuntimeSeconds: 180,
        maxToolCalls: MISSION_MAX_TOOL_CALLS
      }
    });

    const durationMs = Date.now() - start;
    const fullReport = String(result.cleanResponse || result.response || '').trim();
    const preview = fullReport.slice(0, 500); // short teaser stored on the mission row / in-app bell

    // Did this run actually produce a report? Ask the execution row rather than
    // trusting the response string: CognitiveCore substitutes placeholder prose
    // ("Budget exceeded during plan execution.", the inference-unavailable
    // apology) that reads like content but is a failure. The row is the only
    // authoritative record of how the run ended.
    let completionReason = null;
    if (result.executionId) {
      const execRow = await query(
        'SELECT completion_reason FROM executions WHERE execution_id = $1', [result.executionId]);
      completionReason = execRow.rows[0] && execRow.rows[0].completion_reason;
    }
    if (completionReason && FAILED_REASONS.has(completionReason)) {
      throw new DegradedRunError(
        completionReason === 'budget_exceeded'
          ? 'ran out of tool-call/token budget before writing the report'
          : 'the agent could not complete the run (model or tool failure)',
        completionReason);
    }
    if (!fullReport) {
      throw new DegradedRunError('the run finished but produced no report text', 'empty');
    }

    await query(`
      UPDATE agent_missions
      SET last_run_at = now(), last_execution_id = $1, last_result_preview = $2,
          next_run_at = $3, consecutive_failures = 0, updated_at = now()
      WHERE mission_id = $4
    `, [result.executionId || null, preview, mission.enabled ? estimateNextRun(mission.cadence, missionId) : null, missionId]);

    const { createNotification } = require('../notifications');
    await createNotification({
      userId: mission.user_id,
      type: 'mission',
      title: `🗓️ Mission report: ${mission.title}`,
      // Deliver the FULL report to external channels (email/Telegram split long
      // messages themselves) so the user actually gets the news/research, not a
      // 200-char teaser. Fall back to the preview if the run produced no body.
      content: fullReport || preview || 'Mission run finished (no output produced).'
    });

    eventBus.emit('mission:completed', { missionId, executionId: result.executionId, durationMs });
    console.log(`🗓️ [Missions] "${mission.title}" done in ${durationMs}ms → ${result.executionId}`);
    return { success: true, executionId: result.executionId, durationMs, preview };

  } catch (err) {
    const failures = (mission.consecutive_failures || 0) + 1;
    const autoDisable = failures >= MAX_CONSECUTIVE_FAILURES;
    console.error(`❌ [Missions] "${mission.title}" failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);

    await query(`
      UPDATE agent_missions
      SET consecutive_failures = $1, enabled = CASE WHEN $2 THEN false ELSE enabled END,
          last_run_at = now(), last_result_preview = $3, updated_at = now(),
          next_run_at = CASE WHEN $2 THEN NULL ELSE next_run_at END
      WHERE mission_id = $4
    `, [failures, autoDisable, `FAILED: ${err.message}`.slice(0, 500), missionId]);

    // Tell the user the run failed. Previously nothing was sent until the third
    // consecutive failure, so a mission that silently degraded just stopped
    // producing news with no explanation — or worse, delivered its own error
    // text as though it were the report.
    try {
      const { createNotification } = require('../notifications');
      await createNotification({
        userId: mission.user_id,
        type: 'mission',
        title: `⚠️ Mission didn't complete: ${mission.title}`,
        content: `This run failed, so there's no report for it — ${err.message}.\n\n` +
          `Attempt ${failures} of ${MAX_CONSECUTIVE_FAILURES} before it is auto-disabled.` +
          (autoDisable ? '\n\nIt has now been disabled. Re-enable it from the Agents page once the cause is fixed.' : '')
      });
    } catch (e) { /* notification is best-effort; the row already records it */ }

    if (autoDisable) {
      await syncMissionSchedules(); // drop the repeatable job
    }

    eventBus.emit('mission:failed', { missionId, failures, autoDisabled: autoDisable });
    return { success: false, error: err.message, failures, autoDisabled: autoDisable };
  }
}

async function missionHistory(missionId, userId, limit = 10) {
  const mission = await getMission(missionId, userId);
  if (!mission) return null;
  const res = await query(`
    SELECT execution_id, current_state, completion_reason, tokens_used, tool_calls_used,
           iterations_used, created_at, updated_at,
           ROUND(EXTRACT(EPOCH FROM (updated_at - created_at))) AS duration_seconds
    FROM executions
    WHERE conversation_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [`mission_${missionId}`, Math.min(limit, 50)]);
  return { mission, runs: res.rows };
}

module.exports = {
  listMissions, getMission, createMission, updateMission, deleteMission,
  syncMissionSchedules, runMission, missionHistory,
  cadenceToCron, isValidCadence, MISSION_JOB, MAX_CONSECUTIVE_FAILURES
};
