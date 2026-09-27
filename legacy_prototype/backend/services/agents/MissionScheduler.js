// services/agents/MissionScheduler.js — Sprint 7 mission engine.
// A mission = a standing goal an agent re-runs on a schedule, held entirely in
// the agent_missions table: `next_run_at` says when it is due, and the external
// cron trigger (/api/cron/tick) claims and runs whatever has come due. Every run
// goes through the normal PlatoOrchestrator path, so Sentinel pre-checks, token
// telemetry, and the approval gate all apply.
//
// The same schedules were once mirrored into BullMQ repeatable jobs as well.
// That mirror owned nothing next_run_at did not already own, and it made a
// Redis outage fatal to the whole process, so it is gone.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../database');
const { eventBus } = require('../cognitive/EventBus');

const MAX_CONSECUTIVE_FAILURES = 3;

// A research mission's plan is several tool steps, and the synthesis pass that
// turns those results into the actual report costs budget of its own. The
// ExecutionManager default of 5 tool calls is spent by the research alone —
// which is how "Monitor the stock market" burned 5/5 calls in 19 seconds and
// delivered the string "Budget exceeded during plan execution." as the day's
// market brief. Give missions room to research *and* write.
const MISSION_MAX_TOOL_CALLS = 12;

// Floor for a mission run's token ceiling. Every reasoning turn re-sends the
// accumulated tool results, so a multi-source research run costs tens of
// thousands of tokens before a word of the report is written — the runs that
// DID succeed landed at 25k–54k. Missions created against the old 4000 default
// (and the 15000 rows) could not finish under any circumstances; they breached
// mid-research and mailed "Mission didn't complete" every single day. A user
// may still raise the ceiling, but not set one that guarantees failure.
const MISSION_MIN_TOKENS = 40000;

// Wall-clock ceiling for one scheduled run. 180s was tuned for an interactive
// chat where someone is watching a spinner; nobody is watching a 4am mission,
// and successful research runs were finishing at 190–240s — i.e. the timeout
// was killing runs that were about to deliver. Provider backoff is already
// discounted from this by StallClock, so it measures real work.
const MISSION_MAX_RUNTIME_SECONDS = 420;

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
// `output` keeps the text the run produced, so the failure path can tell a
// provider outage from a mission that is genuinely broken.
class DegradedRunError extends Error {
  constructor(message, reason, output = '') {
    super(message);
    this.name = 'DegradedRunError';
    this.completionReason = reason;
    this.output = output;
  }
}

// How long to wait before retrying a run that failed because every provider
// was down. The claim lease alone retried after 15 minutes, so a 45-minute
// outage on 2026-09-14 spent all three strikes on one evening and switched
// Rasha's daily job hunt off for two weeks.
const OUTAGE_RETRY_MINUTES = 60;

// Marks a mission whose last run was lost to an outage. A second outage in a
// row goes back to the regular schedule instead of retrying hourly, so a long
// outage costs one extra run per slot rather than one every hour.
const OUTAGE_PREFIX = 'SKIPPED (provider outage)';

// Every provider failing at once says nothing about the mission itself —
// inference.js throws this when the whole fallback chain is exhausted, and
// ReasoningEngine wraps the same failure in its "temporary high traffic"
// apology. Those must not count toward auto-disable.
function isProviderOutage(...texts) {
  return texts.some(t => /unavailable across providers|temporary high traffic or network delays/i.test(String(t || '')));
}

// What to do with the row after a failed run. Pure so it can be tested
// without a database.
function planFailure(mission, { outage, now = Date.now() } = {}) {
  if (outage) {
    const alreadyRetried = String(mission.last_result_preview || '').startsWith(OUTAGE_PREFIX);
    return {
      failures: mission.consecutive_failures || 0, // an outage is not the mission's fault
      autoDisable: false,
      nextRunAt: alreadyRetried
        ? estimateNextRun(mission.cadence, mission.mission_id)
        : new Date(now + OUTAGE_RETRY_MINUTES * 60e3).toISOString()
    };
  }
  const failures = (mission.consecutive_failures || 0) + 1;
  return {
    failures,
    autoDisable: failures >= MAX_CONSECUTIVE_FAILURES,
    nextRunAt: null // null = keep the claim lease as the retry time
  };
}

// Application drafts this run wrote, rendered as a report appendix. The letters
// cannot ride inside the tool result — every result in a run shares a 12k-char
// budget and three letters alone are ~10k — so the job ledger holds them and
// the report picks them up here, verbatim, without the model re-typing them.
function formatDraftAppendix(rows) {
  if (!rows || !rows.length) return '';
  const parts = rows.map(r => {
    const head = `### ${r.role}${r.company ? ` — ${r.company}` : ''}` +
      (r.match_score != null ? ` (fit ${r.match_score}/100)` : '');
    return [head, r.url ? `**Apply:** ${r.url}` : null, String(r.draft).trim()].filter(Boolean).join('\n\n');
  });
  return `\n\n---\n\n## ✉️ Application drafts\n` +
    `Review and edit before sending — nothing has been submitted.\n\n${parts.join('\n\n---\n\n')}`;
}

async function draftsFromRun(mission, since) {
  try {
    const res = await query(`
      SELECT role, company, url, match_score, draft FROM job_applications
       WHERE mission_id = $1 AND user_id = $2 AND draft IS NOT NULL AND updated_at >= $3
       ORDER BY match_score DESC NULLS LAST, updated_at ASC LIMIT 5`,
    // A few seconds of slack: `since` is this server's clock, updated_at the DB's.
    [mission.mission_id, mission.user_id, new Date(since - 5000)]);
    return res.rows;
  } catch (e) {
    return []; // the report still goes out without its appendix
  }
}

// The run's own date, in the user's timezone. Without it the model titled
// reports with whatever date the first source carried — "09 February 2026",
// "27 August 2026" — on runs made in September.
function missionDateLine(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric'
  }).format(now);
  return `[TODAY IS ${date} (IST). Use exactly this date in the report title. ` +
    `Dates inside tool results belong to those sources, not to this run.]`;
}

// Deterministic 0–50 minute offset per mission. Every 'daily' mission used to
// fire at exactly 08:00, so three of them plus the morning briefing hit the
// same rate-limited Groq model within four minutes of each other — which is
// what "AI Inference unavailable across providers" was reporting. Stable per
// mission id, so a mission keeps its slot across restarts.
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
  // Five cron-shaped fields. The check used to be `(\S+\s+){4}\S+`, which any
  // five-word phrase satisfies — so "whenever you feel like it" validated,
  // stored, and produced a mission that could never come due.
  return /^[\d*,/-]+(\s+[\d*,/-]+){4}$/.test(c);
}

// Does a cron field match a value? Supports "*", "N", "*/N" and "a,b,c" —
// everything the cadence phrases in MissionTool can produce, and everything a
// user is likely to hand-write. Ranges (1-5) are deliberately not supported;
// isValidCadence would accept one, and matching nothing is safer than matching
// the wrong minute, so it falls back to the interval estimate below.
function cronFieldMatches(field, value) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const step = part.match(/^\*\/(\d+)$/);
    if (step) { if (value % parseInt(step[1], 10) === 0) return true; continue; }
    if (/^\d+$/.test(part) && parseInt(part, 10) === value) return true;
  }
  return false;
}

// Next UTC time a 5-field cron pattern fires, or null if the pattern uses
// syntax this understands too little of to answer honestly.
//
// This exists because next_run_at IS the schedule — the cron tick claims rows
// by timestamp and never reads the pattern. Without it, "daily at 07:00" was
// stored faithfully in `cadence` and then fired 24 hours after whatever moment
// the mission happened to be created.
function nextCronRun(pattern, from = Date.now()) {
  const f = String(pattern).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (!/^[\d*,/]+$/.test(f.join(''))) return null;
  // Day-of-month and month are matched only as "*": a mission that fires on the
  // 3rd of the month is not something the cadence phrases produce, and guessing
  // would put the next run a month out.
  if (dom !== '*' || mon !== '*') return null;

  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (cronFieldMatches(min, d.getUTCMinutes()) &&
        cronFieldMatches(hour, d.getUTCHours()) &&
        cronFieldMatches(dow, d.getUTCDay())) {
      return d.toISOString();
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

// When this mission next comes due. This is the schedule, not an estimate of
// one: the cron tick claims rows whose next_run_at has passed, so whatever this
// returns is exactly when the mission runs (give or take the cron interval).
function estimateNextRun(cadence, missionId = null) {
  const now = Date.now();
  const c = String(cadence || 'daily');
  const steps = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, 'daily': 24 * 3600e3 };
  // A raw cron pattern names a wall-clock slot; honour it rather than treating
  // it as "some time tomorrow".
  if (!steps[c]) {
    const exact = nextCronRun(c, now);
    if (exact) return exact;
  }
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
    // Reschedule immediately. next_run_at is the schedule; leaving it alone
    // meant "make it hourly" took effect only after one more run at the old
    // cadence — up to a day later for a daily mission.
    if (patch.enabled == null && mission.enabled) set('next_run_at', estimateNextRun(patch.cadence, missionId));
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
  return res.rows[0];
}

async function deleteMission(missionId, userId) {
  const res = await query(
    'DELETE FROM agent_missions WHERE mission_id = $1 AND user_id = $2 RETURNING mission_id', [missionId, userId]);
  return res.rows.length > 0;
}

// ── Execution: what happens when a mission fires ────────────────

/**
 * Run one mission now (called by the cron tick once it claims the row, or by
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

  // Concurrency guard. A manual "run now" firing while the scheduled tick (or a
  // previous click) is still in flight used to start a SECOND execution on the
  // same mission conversation; the two collided on shared per-conversation state
  // and surfaced as `Illegal state transition from "running" to "running"` plus a
  // spurious "Mission didn't complete" notification. Refuse to start when a run
  // for this mission is already active. Bounded to the runtime window so a
  // crashed/orphaned run (the stale sweeper moves it to 'timeout'/'failed') can
  // never wedge the mission shut. This is a best-effort check, not a lock — it
  // closes the seconds-apart double-click that was actually observed, not a
  // sub-millisecond race.
  try {
    const active = await query(
      `SELECT execution_id FROM executions
         WHERE conversation_id = $1
           AND current_state IN ('created', 'ready', 'running', 'waiting')
           AND created_at > now() - make_interval(secs => $2)
         ORDER BY created_at DESC
         LIMIT 1`,
      [`mission_${mission.mission_id}`, MISSION_MAX_RUNTIME_SECONDS + 30]);
    if (active.rows.length) {
      console.log(`🗓️ [Missions] "${mission.title}" already has an active run (${active.rows[0].execution_id}) — skipping duplicate trigger${manual ? ' (manual)' : ''}`);
      return { skipped: true, reason: 'already_running', executionId: active.rows[0].execution_id };
    }
  } catch (e) {
    // A guard failure must not block a legitimate run — fall through and start.
    console.warn(`⚠️ [Missions] concurrency guard check failed (${e.message}) — proceeding`);
  }

  console.log(`🗓️ [Missions] Running "${mission.title}" [${mission.agent_id}] for user ${mission.user_id}${manual ? ' (manual)' : ''}`);
  const start = Date.now();

  try {
    const { route } = require('./PlatoOrchestrator');
    // Autonomous framing: without this, chat-tuned models tend to ANNOUNCE what
    // they would do ("I will fetch...") instead of doing it — there is no user
    // in the loop to say "go ahead" on a scheduled run.
    const missionGoal =
      `${mission.goal}\n\n${missionDateLine()}\n\n[AUTONOMOUS SCHEDULED RUN — nobody will reply to you. ` +
      `This is a multi-step goal: use action "plan" on your FIRST turn so every ` +
      `tool step runs in one pass. Do NOT describe what you are about to do or ask ` +
      `for confirmation, and never invent numbers or URLs — only report what tools returned. ` +
      `A response that only promises future work is a FAILED run.]`;
    const result = await route({
      goal: missionGoal,
      userId: mission.user_id,
      conversationId: `mission_${mission.mission_id}`,
      targetAgentId: mission.agent_id,
      // Scheduled research draws on its own provider pool so a nightly digest
      // cannot spend the allowance interactive chat needs the next morning.
      workload: 'mission',
      allowWeb: true,
      budget: {
        maxTokens: Math.max(Number(mission.max_tokens_per_run) || 0, MISSION_MIN_TOKENS),
        maxRuntimeSeconds: MISSION_MAX_RUNTIME_SECONDS,
        maxToolCalls: MISSION_MAX_TOOL_CALLS
      }
    });

    const durationMs = Date.now() - start;
    let fullReport = String(result.cleanResponse || result.response || '').trim();
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
        completionReason, fullReport);
    }
    if (!fullReport) {
      throw new DegradedRunError('the run finished but produced no report text', 'empty');
    }
    fullReport += formatDraftAppendix(await draftsFromRun(mission, start));

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
    const outage = isProviderOutage(err.message, err.output);
    const { failures, autoDisable, nextRunAt } = planFailure(mission, { outage });
    console.error(outage
      ? `⏸️ [Missions] "${mission.title}" hit a provider outage — not counted, retrying at ${nextRunAt}: ${err.message}`
      : `❌ [Missions] "${mission.title}" failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);

    await query(`
      UPDATE agent_missions
      SET consecutive_failures = $1, enabled = CASE WHEN $2 THEN false ELSE enabled END,
          last_run_at = now(), last_result_preview = $3, updated_at = now(),
          next_run_at = CASE WHEN $2 THEN NULL ELSE COALESCE($5::timestamptz, next_run_at) END
      WHERE mission_id = $4
    `, [failures, autoDisable,
        `${outage ? OUTAGE_PREFIX : 'FAILED'}: ${err.message}`.slice(0, 500), missionId, nextRunAt]);

    // Tell the user the run failed. Previously nothing was sent until the third
    // consecutive failure, so a mission that silently degraded just stopped
    // producing news with no explanation — or worse, delivered its own error
    // text as though it were the report.
    //
    // The switch-off notice goes out as 'system', not 'mission'. telegramEditor
    // reviews every 'mission' notification with a model and holds anything it
    // scores 1–3, so whether "your mission has stopped" reached the phone was
    // the reviewer's call (on 2026-09-14 it scored the notice 5 and sent it, and
    // held the two failure notices before it). The review also needs inference,
    // which is exactly what an outage takes away. A switch-off must always land.
    try {
      const { createNotification } = require('../notifications');
      await createNotification(autoDisable
        ? {
          userId: mission.user_id,
          type: 'system',
          title: `⛔ Mission switched off: ${mission.title}`,
          content: `"${mission.title}" failed ${failures} runs in a row and has been switched off, ` +
            `so it will not run again until you turn it back on from the Agents page.\n\n` +
            `Last error: ${err.message}.`
        }
        : {
          userId: mission.user_id,
          type: 'mission',
          title: `⚠️ Mission didn't complete: ${mission.title}`,
          content: outage
            ? `Every AI provider was unavailable for this run, so there's no report for it — ${err.message}.\n\n` +
              `This doesn't count against the mission. Next attempt: ${new Date(nextRunAt).toUTCString()}.`
            : `This run failed, so there's no report for it — ${err.message}.\n\n` +
              `Attempt ${failures} of ${MAX_CONSECUTIVE_FAILURES} before it is auto-disabled.`
        });
    } catch (e) { /* notification is best-effort; the row already records it */ }

    // Auto-disable needs no extra bookkeeping: the UPDATE above already cleared
    // next_run_at, and the cron tick only claims rows that are enabled and due.

    eventBus.emit('mission:failed', { missionId, failures, autoDisabled: autoDisable, outage });
    return { success: false, error: err.message, failures, autoDisabled: autoDisable, outage };
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
  runMission, missionHistory,
  cadenceToCron, isValidCadence, estimateNextRun, nextCronRun, MAX_CONSECUTIVE_FAILURES,
  isProviderOutage, planFailure, missionDateLine, formatDraftAppendix, OUTAGE_PREFIX, OUTAGE_RETRY_MINUTES
};
