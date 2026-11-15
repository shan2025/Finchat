// services/AgentLeaderboard.js — long-term agent performance, computed from the
// executions the pipeline already writes. No new tables: race membership is
// read from executions.metrics->>'raceId' (stamped by CognitiveCore when a run
// is one lane of a race). Turns individual races into standing evidence about
// which agent is actually better — the substrate for Plato eventually selecting
// agents on history, not just capability matching.
const db = require('../database');
const microCache = require('./microCache');
const { agentMeta } = require('./cognitive/ExecutionTrace');
const { personas } = require('./personas');

// Derived from the persona roster, NOT a hand-written list — the literal list
// was frozen at five and silently hid Feynman and Hopper from Ranks and
// Profiles for as long as they have existed. Other assigned_agents (system
// MemoryAgent, Sentinel) are not personas, so they stay off by construction.
const ROSTER = new Set(Object.keys(personas));
// Wall-clock (updated_at - created_at) includes time a run sat parked on a human
// approval or was swept stale — not working time. Cap each run's counted
// duration so one parked execution can't blow an agent's average latency.
const MAX_RUN_SECS = 300;

// How a race is won: a clean finish (answered, and inside its own token
// budget), then the most evidence, then fewest tokens, then fastest.
// Cheapest-first used to crown whoever did the least — an NVDA-risk race went
// to Rasha on one web search over Aurelius's prices + news + search. Evidence
// = distinct successful tool calls, so data tools (prices) count, not just
// links. The Agent Map's Standings (finchat_agentmap.html `standings`) use the
// same order.
const RACE_ORDER_SQL = `(completion_reason = 'natural' AND (max_tokens IS NULL OR tokens_used <= max_tokens)) DESC,
  evidence DESC, tokens_used ASC, secs ASC`;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, d = 0) => { const m = Math.pow(10, d); return Math.round((Number(n) || 0) * m) / m; };

// ── What "good" means here ───────────────────────────────────────────────────
//
// This file used to call the share of runs that ended 'natural' ACCURACY. It is
// not: a run that finishes without an error or a budget stop can still be
// wrong, shallow or off-topic. That number drove 60% of the Cognitive Score and
// half of the history term in Plato's routing, so everything downstream learned
// "who errors least" — a provider-health signal — and called it quality.
//
// Now there are two honest numbers:
//   finished    — share of runs that ended cleanly (the old metric, renamed)
//   helpfulness — the user's thumbs on the answer, stored on the run as
//                 executions.metrics.feedback.rating (1 | -1; routes/executions.js)
// and one combined one:
//   useful      — finished × helpfulness: the expected share of runs that end
//                 with an answer the user found helpful.
//
// Helpfulness is Laplace-smoothed, (up + 1) / (rated + 2): an agent with no
// ratings counts as 50/50, ONE thumbs-up is 67% not 100%, and an agent cannot
// look good by never being rated. With no ratings anywhere, ranking reduces to
// finished-and-efficient — which is all the system genuinely knows.
const MIN_RATED_FOR_CLAIM = 1;
function helpfulness(up, rated) {
  const u = Math.max(0, Number(up) || 0), n = Math.max(u, Number(rated) || 0);
  return (u + 1) / (n + 2);
}
// `accuracy` is still sent, with its ORIGINAL meaning (= finished), for pages
// that were loaded before a deploy and are still open: they read row.accuracy
// and cell.accuracy, and without it printed "undefined%" in every cell. New
// pages read finished / useful and ignore it. Safe to drop once no client
// older than 2026-11-15 can be open — i.e. any later deploy.
const RATED_SQL = "e.metrics->'feedback'->>'rating' IN ('1', '-1')";
const UP_SQL = "e.metrics->'feedback'->>'rating' = '1'";

/**
 * Build the global (or per-user) agent leaderboard.
 *
 * Quality (useful = finished × rated helpfulness; see the note above), Efficiency
 * (avg fuel, latency, tool calls, a normalised route-efficiency score), and Wins
 * (per-race, quality-then-cheapest-then-fastest) roll into a single,
 * quality-weighted Cognitive Score. Adaptability (recovery, route improvement,
 * per-task-type) is intentionally left for the profiles step.
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
      COUNT(*) FILTER (WHERE ${RATED_SQL})::int AS rated,
      COUNT(*) FILTER (WHERE ${UP_SQL})::int AS rated_up,
      COALESCE(AVG(e.tokens_used), 0) AS avg_tokens,
      COALESCE(AVG(e.tool_calls_used), 0) AS avg_tools,
      COALESCE(AVG(LEAST(EXTRACT(EPOCH FROM (e.updated_at - e.created_at)), ${MAX_RUN_SECS})), 0) AS avg_secs
    FROM executions e
    WHERE e.assigned_agent IS NOT NULL AND e.assigned_agent <> 'system'
      AND e.current_state IN ('completed', 'failed') ${scope}
    GROUP BY e.assigned_agent
  `, params);

  // Per-race winner — a race-local ranking that does not depend on the global
  // stats it will feed. See RACE_ORDER_SQL for why evidence outranks cost.
  const winRes = await db.query(`
    WITH lanes AS (
      SELECT e.assigned_agent AS agent, e.metrics->>'raceId' AS race_id,
        e.completion_reason, e.tokens_used, e.max_tokens,
        LEAST(EXTRACT(EPOCH FROM (e.updated_at - e.created_at)), ${MAX_RUN_SECS}) AS secs,
        (SELECT COUNT(DISTINCT tc.tool_name || ':' || COALESCE(tc.arguments::text, ''))
           FROM tool_calls tc JOIN tool_results tr ON tr.call_id = tc.call_id
          WHERE tc.execution_id = e.execution_id AND tr.error IS NULL AND tr.output IS NOT NULL) AS evidence
      FROM executions e
      WHERE e.metrics->>'raceId' IS NOT NULL
        AND e.current_state IN ('completed', 'failed') ${scope}
    ), ranked AS (
      SELECT agent, ROW_NUMBER() OVER (PARTITION BY race_id ORDER BY ${RACE_ORDER_SQL}) AS rnk FROM lanes
    )
    SELECT agent, COUNT(*)::int AS wins FROM ranked WHERE rnk = 1 GROUP BY agent
  `, params);

  const wins = {};
  for (const r of winRes.rows) wins[r.agent] = r.wins;

  const rows = aggRes.rows.filter(r => ROSTER.has(r.agent)).map(r => {
    const runs = r.runs || 0;
    const avgFuel = (Number(r.avg_tokens) || 0) / 1000;
    const avgSecs = Number(r.avg_secs) || 0;
    const finished = runs ? r.natural_count / runs : 0;
    const rated = r.rated || 0, ratedUp = r.rated_up || 0;
    return {
      agent: r.agent, races: r.races || 0, runs,
      wins: wins[r.agent] || 0,
      finished: round(100 * finished, 1),
      accuracy: round(100 * finished, 1), // legacy alias, see RATED_SQL note
      rated, ratedUp,
      helpful: rated >= MIN_RATED_FOR_CLAIM ? round(100 * ratedUp / rated, 0) : null,
      useful: round(100 * finished * helpfulness(ratedUp, rated), 1),
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
    // Quality-weighted: usefulness dominates, efficiency matters, wins are a
    // light bonus (deliberately NOT the primary metric).
    r.cognitiveScore = round(clamp(0.6 * r.useful + 0.3 * r.routeEfficiency + 0.1 * r.winRate, 0, 100), 0);
    const m = agentMeta(r.agent);
    r.name = m.name; r.role = m.role; r.color = m.color; r.avatar = m.avatar;
    delete r._fuel; delete r._secs;
  }

  rows.sort((a, b) => b.cognitiveScore - a.cognitiveScore || b.useful - a.useful);
  return rows;
}

// ── Agent performance profiles by task type ─────────────────────────────────
// Classify each question into a domain so we can see WHERE each agent is strong
// ("Nova is most useful on research; Aurelius is faster on markets"). This is
// the substrate for Plato selecting agents on history, not just capability
// matching. The classifier is shared by everything that buckets runs — routing,
// profiles, route yield and learned routes — so it lives in its own module.
const { classifyTask, TASK_TYPES } = require('./cognitive/taskClassifier');

/**
 * Per-agent, per-task-type performance. Returns each agent's usefulness,
 * finished rate, ratings, fuel and time per domain, the best agent for each task
 * type (min sample), and which task types each agent leads.
 * @param {object} [opts]
 * @param {string|null} [opts.userId]
 */
async function getAgentProfiles({ userId = null } = {}) {
  const scope = userId ? 'AND e.user_id = $1' : '';
  const params = userId ? [userId] : [];
  const res = await db.query(`
    SELECT e.assigned_agent AS agent, e.goal, e.tokens_used, e.completion_reason,
      e.metrics->'feedback'->>'rating' AS rating,
      LEAST(EXTRACT(EPOCH FROM (e.updated_at - e.created_at)), ${MAX_RUN_SECS}) AS secs
    FROM executions e
    WHERE e.assigned_agent = ANY($${params.length + 1})
      AND e.current_state IN ('completed', 'failed') ${scope}
    ORDER BY e.created_at DESC LIMIT 4000
  `, [...params, [...ROSTER]]);

  const cells = {}; // agent -> task -> {runs, natural, errored, rated, up, fuel, secs}
  for (const r of res.rows) {
    const t = classifyTask(r.goal);
    const A = cells[r.agent] || (cells[r.agent] = {});
    const c = A[t] || (A[t] = { runs: 0, natural: 0, errored: 0, rated: 0, up: 0, fuel: 0, secs: 0 });
    c.runs++;
    if (r.completion_reason === 'natural') c.natural++;
    if (r.completion_reason === 'error') c.errored++;
    if (r.rating === '1' || r.rating === '-1') c.rated++;
    if (r.rating === '1') c.up++;
    c.fuel += Number(r.tokens_used) || 0; c.secs += Number(r.secs) || 0;
  }

  const agents = Object.keys(cells).map(id => {
    const m = agentMeta(id), A = cells[id], out = {};
    for (const t of Object.keys(A)) {
      const c = A[t];
      const finished = c.natural / c.runs;
      out[t] = {
        runs: c.runs,
        finished: round(100 * finished, 0),
        accuracy: round(100 * finished, 0), // legacy alias, see RATED_SQL note
        rated: c.rated,
        ratedUp: c.up,
        helpful: c.rated >= MIN_RATED_FOR_CLAIM ? round(100 * c.up / c.rated, 0) : null,
        useful: round(100 * finished * helpfulness(c.up, c.rated), 0),
        errorRate: round(100 * c.errored / c.runs, 0),
        avgFuel: round(c.fuel / c.runs / 1000, 1),
        avgSecs: round(c.secs / c.runs, 1)
      };
    }
    return { agent: id, name: m.name, role: m.role, color: m.color, avatar: m.avatar, cells: out };
  });

  const MIN = 3; // don't crown an agent on a single lucky run
  const bestPerTask = {};
  for (const t of TASK_TYPES) {
    let best = null;
    for (const a of agents) {
      const c = a.cells[t];
      if (c && c.runs >= MIN && (!best || c.useful > best.useful || (c.useful === best.useful && c.avgFuel < best.avgFuel))) {
        best = { agent: a.agent, name: a.name, color: a.color, useful: c.useful, rated: c.rated, runs: c.runs, avgFuel: c.avgFuel,
          accuracy: c.finished }; // legacy alias, see RATED_SQL note
      }
    }
    if (best) { delete best.avgFuel; bestPerTask[t] = best; }
  }
  for (const a of agents) a.bestAt = TASK_TYPES.filter(t => bestPerTask[t] && bestPerTask[t].agent === a.agent);

  return { taskTypes: TASK_TYPES, agents, bestPerTask };
}

// Routing reads profiles on every decision — cache briefly so a chat turn does
// not re-run the aggregate each time. Keyed by scope.
function getProfilesCached({ userId = null } = {}) {
  return microCache.cached('agent_profiles:' + (userId || 'global'), 60000, () => getAgentProfiles({ userId }));
}

// ── History-aware routing score (PURE — no DB, unit-tested) ──────────────────
// Blend capability with task-conditioned historical performance:
//   final = capWeight·capNorm + histWeight·histNorm   (when the agent has ≥ minRuns
//   completed runs for this task type), otherwise final = capNorm so agents
//   without enough history route exactly as before (capability only).
//
// histNorm = 0.5·helpfulness + 0.25·finished + 0.25·efficiency, each 0..1.
// Helpfulness is the smoothed thumbs ratio (see helpfulness()): with no ratings
// it is 0.5 for every agent, so it cannot reorder them and the choice rests on
// finishing and efficiency — the history term no longer claims a quality it has
// no evidence for. Efficiency is normalised across the candidates that HAVE
// history (lower fuel/time is better), so it is comparative, not absolute.
//
// @param {object} opts
// @param {Array<{agentId:string, cap:number}>} opts.candidates
// @param {Object<string,{cells:Object}>} opts.profilesByAgent - keyed by agentId
// @param {string} opts.taskType
// @param {number} [opts.minRuns=5]
// @param {number} [opts.capWeight=0.7]
// @param {number} [opts.histWeight=0.3]
// @returns {Array} ranked candidates with the routing breakdown, best first
function blendAgentScores({ candidates, profilesByAgent = {}, taskType, minRuns = 5, capWeight = 0.7, histWeight = 0.3 }) {
  const list = candidates || [];
  const maxCap = Math.max(1, ...list.map(c => Number(c.cap) || 0));
  const cellFor = id => {
    const p = profilesByAgent[id];
    const cell = p && p.cells && p.cells[taskType];
    return (cell && cell.runs >= minRuns) ? cell : null;
  };
  const withHist = list.map(c => c.agentId).filter(id => cellFor(id));
  const fuels = withHist.map(id => cellFor(id).avgFuel);
  const secs = withHist.map(id => cellFor(id).avgSecs);
  const normLowerBetter = (v, arr) => {
    if (!arr.length) return 1;
    const lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr);
    return hi > lo ? 1 - (v - lo) / (hi - lo) : 1;
  };

  const rows = list.map(c => {
    const cap = Number(c.cap) || 0;
    const capNorm = maxCap > 0 ? cap / maxCap : 0;
    const cell = cellFor(c.agentId);
    let histNorm = null, history = null;
    if (cell) {
      const rated = Number(cell.rated) || 0, up = Number(cell.ratedUp) || 0;
      const helpful = helpfulness(up, rated);
      const finished = clamp((cell.finished || 0) / 100, 0, 1);
      const efficiency = clamp((normLowerBetter(cell.avgFuel || 0, fuels) + normLowerBetter(cell.avgSecs || 0, secs)) / 2, 0, 1);
      histNorm = clamp(0.5 * helpful + 0.25 * finished + 0.25 * efficiency, 0, 1);
      history = {
        runs: cell.runs, rated,
        helpful: rated >= MIN_RATED_FOR_CLAIM ? round(100 * up / rated) : null,
        finished: round(cell.finished || 0),
        efficiency: round(efficiency * 100),
        score: round(histNorm, 3)
      };
    }
    const finalScore = cell ? (capWeight * capNorm + histWeight * histNorm) : capNorm;
    return { agentId: c.agentId, cap, capNorm: round(capNorm, 3), hasHistory: !!cell, history, finalScore: round(finalScore, 4) };
  });

  // Deterministic order: final score, then raw capability, then id (stable ties).
  rows.sort((a, b) => b.finalScore - a.finalScore || b.cap - a.cap || String(a.agentId).localeCompare(String(b.agentId)));
  return rows;
}

module.exports = {
  getLeaderboard, getAgentProfiles, getProfilesCached, classifyTask, blendAgentScores,
  helpfulness, TASK_TYPES
};
