// tools/DiagnosticsTool.js — the failure record, as evidence rather than prose.
//
// SystemStatusTool answers "is this agent working?". This answers the question
// that comes next and has never had a tool behind it: "what exactly broke, how
// often, and what did it say?"
//
// Every diagnosis in this project so far has been made by a human reading
// `executions` and `tool_results` by hand — the mission failures of 2026-08-27,
// the briefings that shipped failure prose as news, the runs capped at 8k
// tokens. Each investigation started by clustering failures and reading the
// error text, and each was slow for the same reason: nothing in the system could
// look. An agent asked to diagnose a bug without this tool does not decline; it
// reasons from its own prompt and invents a plausible cause, which is worse than
// no answer because it reads like one.
//
// Read-only, by construction. It runs SELECTs and returns rows. Nothing here
// writes, restarts, retries or repairs anything — the fix is a patch a human
// applies, which is also why the agent that holds this tool holds no host-write
// tools by default.
//
// Scope: executions, tool calls and missions are filtered to the signed-in user,
// like SystemStatusTool. Inference metrics are system-wide by nature (they are
// about providers, not people) and carry no user content.
const { query } = require('../database');

/** Completion reasons that mean the run produced a real answer. */
const HEALTHY_REASONS = new Set(['natural']);

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through to plain string */ }
  }
  // Plain-string convenience: "failures" | "providers" | "tools" | an execution id.
  if (/^exec/i.test(s)) return { scope: 'execution', execution_id: s };
  if (s) return { scope: s.toLowerCase() };
  return {};
}

/**
 * Collapse an error message to the shape of the fault, so that N occurrences of
 * one bug cluster into one line instead of N.
 *
 * Ids, timestamps, quantities and quoted values are what make two reports of the
 * SAME defect look different — "no allowance left on [system:4f2a]" and
 * "…[system:9c11]" are one problem. Blanking them is what turns a wall of
 * distinct-looking errors into "this happened 47 times", which is the number
 * that decides what to fix first.
 */
function fingerprint(message) {
  return String(message || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:exec|tc|tr|msn|sess)_[A-Za-z0-9_]+/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
    .replace(/\[[^\]]*\]/g, '[…]')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+\b/g, '<n>')
    .trim()
    .slice(0, 300);
}

/** Group rows by their error fingerprint, biggest cluster first. */
function cluster(rows, textOf, extra = () => ({})) {
  const byPrint = new Map();
  for (const r of rows) {
    const text = textOf(r);
    if (!text) continue;
    const print = fingerprint(text);
    const entry = byPrint.get(print) || {
      pattern: print, occurrences: 0, example: String(text).slice(0, 600), ...extra(r)
    };
    entry.occurrences += 1;
    entry.lastSeen = entry.lastSeen && entry.lastSeen > r.created_at ? entry.lastSeen : r.created_at;
    byPrint.set(print, entry);
  }
  return [...byPrint.values()].sort((a, b) => b.occurrences - a.occurrences);
}

async function execute(input, context = {}) {
  const { scope = 'failures', days: rawDays, agent = null, execution_id = null } = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Diagnostics requires a signed-in user context');
  }
  // Bounded so a diagnostic query cannot become the slow query it is meant to
  // find. The database is ~126ms away and this runs inside a chat turn.
  const days = Math.min(Math.max(Number(rawDays) || 7, 1), 90);

  // ── One execution, in full ─────────────────────────────────────
  // The drill-down after a cluster names a suspect: the actual run, its phases
  // and every tool error inside it.
  if (scope === 'execution') {
    if (!execution_id) throw new Error('scope "execution" needs an execution_id');
    const [run, logs, tools] = await Promise.all([
      query(`SELECT execution_id, assigned_agent, goal, current_state, completion_reason,
                    wait_reason, iterations_used, tool_calls_used, tokens_used, max_tokens,
                    created_at, updated_at, LEFT(COALESCE(result, ''), 2000) AS result
             FROM executions WHERE execution_id = $1 AND user_id = $2`,
        [execution_id, userId]),
      query(`SELECT phase, step_number, content, duration_ms, created_at
             FROM execution_logs WHERE execution_id = $1
             ORDER BY step_number, created_at LIMIT 60`, [execution_id]),
      query(`SELECT tc.tool_name, tc.status, tc.arguments, tr.error, tr.duration_ms, tc.created_at
             FROM tool_calls tc
             LEFT JOIN tool_results tr ON tr.call_id = tc.call_id
             WHERE tc.execution_id = $1
             ORDER BY tc.created_at LIMIT 60`, [execution_id])
    ]);
    if (run.rows.length === 0) {
      return { error: `No execution "${execution_id}" belonging to this user. Do not guess at its contents.` };
    }
    return {
      execution: run.rows[0],
      phases: logs.rows,
      toolCalls: tools.rows,
      note: 'Phase content is what the agent actually thought and did. Quote it rather than paraphrasing when explaining the failure.'
    };
  }

  // ── Provider health ────────────────────────────────────────────
  // Which providers and models are actually carrying traffic, and how slowly.
  // A failure that correlates with one provider is a routing problem, not a
  // code problem, and the two get diagnosed very differently.
  if (scope === 'providers') {
    const metrics = await query(`
      SELECT provider, model, feature,
             COUNT(*)::int                              AS calls,
             ROUND(AVG(latency_ms))::int                AS avg_latency_ms,
             MAX(latency_ms)::int                       AS max_latency_ms,
             SUM(prompt_tokens + completion_tokens)::int AS tokens
      FROM inference_metrics
      WHERE created_at > NOW() - ($1 || ' days')::interval
      GROUP BY provider, model, feature
      ORDER BY calls DESC
      LIMIT 40
    `, [days]);
    return {
      window: `last ${days} days`,
      scope: 'System-wide. Inference metrics describe providers, not users.',
      providers: metrics.rows,
      note: 'Only SUCCESSFUL calls are recorded here — a provider that failed every time appears as absent, not as a zero row. Read absence carefully.'
    };
  }

  // ── Tool failures ──────────────────────────────────────────────
  if (scope === 'tools') {
    const failures = await query(`
      SELECT tc.tool_name, tc.agent_id, tr.error, tc.execution_id, tr.created_at
      FROM tool_results tr
      JOIN tool_calls tc ON tc.call_id = tr.call_id
      JOIN executions e  ON e.execution_id = tc.execution_id
      WHERE tr.error IS NOT NULL
        AND e.user_id = $1
        AND tr.created_at > NOW() - ($2 || ' days')::interval
      ORDER BY tr.created_at DESC
      LIMIT 400
    `, [userId, days]);
    return {
      window: `last ${days} days`,
      failingTools: cluster(failures.rows, r => r.error, r => ({
        tool: r.tool_name, agent: r.agent_id, exampleExecution: r.execution_id
      })),
      totalFailedCalls: failures.rows.length,
      note: 'Clustered by error shape — ids, numbers and quoted values are blanked, so one pattern is one defect. Fix by occurrence count, not by recency.'
    };
  }

  // ── Failing runs (the default) ─────────────────────────────────
  const agentFilter = agent ? 'AND assigned_agent = $3' : '';
  const params = agent ? [userId, days, agent] : [userId, days];

  const [byReason, recent, missions] = await Promise.all([
    query(`
      SELECT assigned_agent, completion_reason, current_state, COUNT(*)::int AS count
      FROM executions
      WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval ${agentFilter}
      GROUP BY assigned_agent, completion_reason, current_state
      ORDER BY count DESC
    `, params),

    // The error text itself. `result` holds the failure prose on a failed run —
    // the same field that has twice been shipped to users as a report because
    // nothing checked completion_reason first.
    query(`
      SELECT execution_id, assigned_agent, completion_reason, current_state,
             LEFT(COALESCE(goal, ''), 160)   AS goal,
             LEFT(COALESCE(result, ''), 800) AS result,
             tokens_used, max_tokens, created_at
      FROM executions
      WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval ${agentFilter}
        AND (completion_reason IS DISTINCT FROM 'natural' OR current_state = 'failed')
      ORDER BY created_at DESC
      LIMIT 120
    `, params),

    query(`
      SELECT mission_id, agent_id, title, enabled, consecutive_failures,
             last_run_at, next_run_at, last_execution_id,
             LEFT(COALESCE(last_result_preview, ''), 400) AS last_result_preview
      FROM agent_missions
      WHERE user_id = $1 AND consecutive_failures > 0
      ORDER BY consecutive_failures DESC
      LIMIT 40
    `, [userId])
  ]);

  let total = 0;
  let healthy = 0;
  const perAgent = new Map();
  for (const r of byReason.rows) {
    total += r.count;
    if (HEALTHY_REASONS.has(r.completion_reason)) healthy += r.count;
    const a = perAgent.get(r.assigned_agent) || { agent: r.assigned_agent, runs: 0, healthy: 0, byReason: {} };
    a.runs += r.count;
    if (HEALTHY_REASONS.has(r.completion_reason)) a.healthy += r.count;
    a.byReason[r.completion_reason || 'unknown'] = (a.byReason[r.completion_reason || 'unknown'] || 0) + r.count;
    perAgent.set(r.assigned_agent, a);
  }

  const agents = [...perAgent.values()].map(a => ({
    ...a,
    failureRatePct: a.runs ? Math.round(((a.runs - a.healthy) / a.runs) * 100) : 0
  })).sort((a, b) => b.failureRatePct - a.failureRatePct);

  // Runs that breached their token ceiling are separated from runs that errored,
  // because they look identical in a failure count and have opposite fixes: one
  // is a bug, the other is a budget row. Conflating them is how "Budget
  // exceeded" was repeatedly investigated as a provider quota problem.
  const budgetBreaches = recent.rows.filter(r => r.completion_reason === 'budget_exceeded');

  return {
    window: `last ${days} days`,
    scope: 'This user\'s runs only.',
    totals: { runs: total, healthy, failed: total - healthy,
              failureRatePct: total ? Math.round(((total - healthy) / total) * 100) : 0 },
    byAgent: agents,
    failureClusters: cluster(recent.rows, r => r.result, r => ({
      agent: r.assigned_agent,
      completionReason: r.completion_reason,
      exampleExecution: r.execution_id
    })),
    budgetBreaches: budgetBreaches.map(r => ({
      execution: r.execution_id, agent: r.assigned_agent,
      tokensUsed: r.tokens_used, ceiling: r.max_tokens, at: r.created_at
    })),
    failingMissions: missions.rows,
    note: total === 0
      ? 'No runs at all in this window. That is an absence of evidence, not a clean bill of health — say so rather than reporting the system healthy.'
      : 'Take the largest cluster, read one of its executions in full with {"scope":"execution","execution_id":"…"}, then read the code it names before proposing any fix.'
  };
}

module.exports = { execute, fingerprint, cluster };
