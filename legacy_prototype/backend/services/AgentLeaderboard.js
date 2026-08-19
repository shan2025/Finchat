// services/AgentLeaderboard.js — long-term agent performance, computed from the
// executions the pipeline already writes. No new tables: race membership is
// read from executions.metrics->>'raceId' (stamped by CognitiveCore when a run
// is one lane of a race). Turns individual races into standing evidence about
// which agent is actually better — the substrate for Plato eventually selecting
// agents on history, not just capability matching.
const db = require('../database');
const { agentMeta } = require('./cognitive/ExecutionTrace');

// The competitive roster. Other assigned_agents (system MemoryAgent, Sentinel)
// do real work but are not racers, so they stay off the leaderboard.
const ROSTER = new Set(['plato', 'nova', 'aurelius', 'rasha']);
// Wall-clock (updated_at - created_at) includes time a run sat parked on a human
// approval or was swept stale — not working time. Cap each run's counted
// duration so one parked execution can't blow an agent's average latency.
const MAX_RUN_SECS = 300;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, d = 0) => { const m = Math.pow(10, d); return Math.round((Number(n) || 0) * m) / m; };

/**
 * Build the global (or per-user) agent leaderboard.
 *
 * Quality (accuracy = share of runs that finished 'natural', error rate),
 * Efficiency (avg fuel, latency, tool calls, a normalised route-efficiency
 * score), and Wins (per-race, quality-then-cheapest-then-fastest) roll into a
 * single, quality-weighted Cognitive Score. Adaptability (recovery, route
 * improvement, per-task-type) is intentionally left for the profiles step.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.userId] - scope to one user's runs; null = global
 * @returns {Promise<Array>} rows sorted by cognitiveScore desc
 */
async function getLeaderboard({ userId = null } = {}) {
  const scope = userId ? 'AND e.user_id = $1' : '';
  const params = userId ? [userId] : [];

  const aggRes = await db.query(`
    SELECT e.assigned_agent AS agent,
      COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE e.metrics->>'raceId' IS NOT NULL)::int AS races,
      COUNT(*) FILTER (WHERE e.completion_reason = 'natural')::int AS natural_count,
      COUNT(*) FILTER (WHERE e.completion_reason = 'error' OR e.current_state = 'failed')::int AS error_count,
      COALESCE(AVG(e.tokens_used), 0) AS avg_tokens,
      COALESCE(AVG(e.tool_calls_used), 0) AS avg_tools,
      COALESCE(AVG(LEAST(EXTRACT(EPOCH FROM (e.updated_at - e.created_at)), ${MAX_RUN_SECS})), 0) AS avg_secs
    FROM executions e
    WHERE e.assigned_agent IS NOT NULL AND e.assigned_agent <> 'system'
      AND e.current_state IN ('completed', 'failed') ${scope}
    GROUP BY e.assigned_agent
  `, params);

  // Per-race winner: verified first, then cheapest, then fastest — a race-local
  // ranking that does not depend on the global stats it will feed.
  const winRes = await db.query(`
    WITH ranked AS (
      SELECT e.assigned_agent AS agent,
        ROW_NUMBER() OVER (
          PARTITION BY e.metrics->>'raceId'
          ORDER BY (e.completion_reason = 'natural') DESC,
                   e.tokens_used ASC,
                   LEAST(EXTRACT(EPOCH FROM (e.updated_at - e.created_at)), ${MAX_RUN_SECS}) ASC
        ) AS rnk
      FROM executions e
      WHERE e.metrics->>'raceId' IS NOT NULL
        AND e.current_state IN ('completed', 'failed') ${scope}
    )
    SELECT agent, COUNT(*)::int AS wins FROM ranked WHERE rnk = 1 GROUP BY agent
  `, params);

  const wins = {};
  for (const r of winRes.rows) wins[r.agent] = r.wins;

  const rows = aggRes.rows.filter(r => ROSTER.has(r.agent)).map(r => {
    const runs = r.runs || 0;
    const avgFuel = (Number(r.avg_tokens) || 0) / 1000;
    const avgSecs = Number(r.avg_secs) || 0;
    return {
      agent: r.agent, races: r.races || 0, runs,
      wins: wins[r.agent] || 0,
      accuracy: runs ? round(100 * r.natural_count / runs, 1) : 0,
      errorRate: runs ? round(100 * r.error_count / runs, 1) : 0,
      avgFuel: round(avgFuel, 1),
      avgSecs: round(avgSecs, 1),
      avgTools: round(Number(r.avg_tools) || 0, 1),
      _fuel: avgFuel, _secs: avgSecs
    };
  });

  // Route efficiency: normalise fuel + latency across the field (lower is
  // better), so it is a comparative 0..100 rather than an absolute.
  const fuels = rows.map(r => r._fuel), secs = rows.map(r => r._secs);
  const norm = (v, arr) => { const lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr); return hi > lo ? (v - lo) / (hi - lo) : 0; };
  for (const r of rows) {
    r.routeEfficiency = round(clamp(100 - (0.6 * norm(r._fuel, fuels) + 0.4 * norm(r._secs, secs)) * 100, 0, 100), 0);
    r.winRate = r.races ? round(100 * r.wins / r.races, 0) : 0;
    // Quality-weighted: accuracy dominates, efficiency matters, wins are a light
    // bonus (deliberately NOT the primary metric).
    r.cognitiveScore = round(clamp(0.6 * r.accuracy + 0.3 * r.routeEfficiency + 0.1 * r.winRate, 0, 100), 0);
    const m = agentMeta(r.agent);
    r.name = m.name; r.role = m.role; r.color = m.color; r.avatar = m.avatar;
    delete r._fuel; delete r._secs;
  }

  rows.sort((a, b) => b.cognitiveScore - a.cognitiveScore || b.accuracy - a.accuracy);
  return rows;
}

module.exports = { getLeaderboard };
