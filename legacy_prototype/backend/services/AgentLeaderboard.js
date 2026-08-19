// services/AgentLeaderboard.js — long-term agent performance, computed from the
// executions the pipeline already writes. No new tables: race membership is
// read from executions.metrics->>'raceId' (stamped by CognitiveCore when a run
// is one lane of a race). Turns individual races into standing evidence about
// which agent is actually better — the substrate for Plato eventually selecting
// agents on history, not just capability matching.
const db = require('../database');
const microCache = require('./microCache');
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

// ── Agent performance profiles by task type ─────────────────────────────────
// Classify each question into a domain so we can see WHERE each agent is strong
// ("Aurelius is more accurate on research; Nova is faster on markets"). This is
// the substrate for Plato eventually selecting agents on history, not just
// capability matching. Keyword classification on the goal — first match wins,
// ordered most-specific first.
const TASK_TYPES = ['markets', 'research', 'news', 'compliance', 'risk', 'portfolio', 'general'];
const TASK_MATCHERS = [
  ['markets', /\b(stock|stocks|price|prices|ticker|crypto|bitcoin|ethereum|solana|forex|currency|commodit|gold|oil|equit|trading|shares?|valuation|earnings|market)\b/i],
  ['research', /\b(research|paper|papers|arxiv|study|studies|academic|literature|whitepaper|deep dive|explain|how does|what is)\b/i],
  ['news', /\b(news|headline|latest|today|announce|update|recent|breaking|happening|this week)\b/i],
  ['compliance', /\b(complian|regulat|\brule|legal|\blaw\b|audit|disclosure|suitab|govern|policy)\b/i],
  ['risk', /\b(risks?|exposure|drawdown|volatil|hedge|downside|stress|defaults?|credit)\b/i],
  ['portfolio', /\b(portfolio|holding|allocation|watchlist|position|rebalanc|diversif|client)\b/i]
];
function classifyTask(goal) {
  const g = String(goal || '');
  for (const [t, re] of TASK_MATCHERS) if (re.test(g)) return t;
  return 'general';
}

/**
 * Per-agent, per-task-type performance. Returns each agent's accuracy/fuel/time
 * per domain, the best agent for each task type (min sample), and which task
 * types each agent leads.
 * @param {object} [opts]
 * @param {string|null} [opts.userId]
 */
async function getAgentProfiles({ userId = null } = {}) {
  const scope = userId ? 'AND e.user_id = $1' : '';
  const params = userId ? [userId] : [];
  const res = await db.query(`
    SELECT e.assigned_agent AS agent, e.goal, e.tokens_used, e.completion_reason,
      LEAST(EXTRACT(EPOCH FROM (e.updated_at - e.created_at)), ${MAX_RUN_SECS}) AS secs
    FROM executions e
    WHERE e.assigned_agent = ANY($${params.length + 1})
      AND e.current_state IN ('completed', 'failed') ${scope}
    ORDER BY e.created_at DESC LIMIT 4000
  `, [...params, [...ROSTER]]);

  const cells = {}; // agent -> task -> {runs, natural, errored, fuel, secs}
  for (const r of res.rows) {
    const t = classifyTask(r.goal);
    const A = cells[r.agent] || (cells[r.agent] = {});
    const c = A[t] || (A[t] = { runs: 0, natural: 0, errored: 0, fuel: 0, secs: 0 });
    c.runs++;
    if (r.completion_reason === 'natural') c.natural++;
    if (r.completion_reason === 'error') c.errored++;
    c.fuel += Number(r.tokens_used) || 0; c.secs += Number(r.secs) || 0;
  }

  const agents = Object.keys(cells).map(id => {
    const m = agentMeta(id), A = cells[id], out = {};
    for (const t of Object.keys(A)) {
      const c = A[t];
      out[t] = {
        runs: c.runs,
        accuracy: round(100 * c.natural / c.runs, 0),
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
      if (c && c.runs >= MIN && (!best || c.accuracy > best.accuracy || (c.accuracy === best.accuracy && c.avgFuel < best.avgFuel))) {
        best = { agent: a.agent, name: a.name, color: a.color, accuracy: c.accuracy, runs: c.runs };
      }
    }
    if (best) bestPerTask[t] = best;
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
// histNorm = 0.5·accuracy + 0.25·reliability + 0.25·efficiency, each 0..1.
// Efficiency is normalised across the candidates that HAVE history (lower fuel/
// time is better), so it is comparative rather than absolute.
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
      const accuracy = clamp((cell.accuracy || 0) / 100, 0, 1);
      const reliability = clamp((100 - (cell.errorRate || 0)) / 100, 0, 1);
      const efficiency = clamp((normLowerBetter(cell.avgFuel || 0, fuels) + normLowerBetter(cell.avgSecs || 0, secs)) / 2, 0, 1);
      histNorm = clamp(0.5 * accuracy + 0.25 * reliability + 0.25 * efficiency, 0, 1);
      history = { runs: cell.runs, accuracy: cell.accuracy, reliability: round(100 - (cell.errorRate || 0)), efficiency: round(efficiency * 100), score: round(histNorm, 3) };
    }
    const finalScore = cell ? (capWeight * capNorm + histWeight * histNorm) : capNorm;
    return { agentId: c.agentId, cap, capNorm: round(capNorm, 3), hasHistory: !!cell, history, finalScore: round(finalScore, 4) };
  });

  // Deterministic order: final score, then raw capability, then id (stable ties).
  rows.sort((a, b) => b.finalScore - a.finalScore || b.cap - a.cap || String(a.agentId).localeCompare(String(b.agentId)));
  return rows;
}

module.exports = { getLeaderboard, getAgentProfiles, getProfilesCached, classifyTask, blendAgentScores };
