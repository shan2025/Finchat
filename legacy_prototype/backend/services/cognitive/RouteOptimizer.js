// services/cognitive/RouteOptimizer.js — learned route optimization.
//
// Turns the ordered district transitions of every completed run into a learned,
// persisted map of which district->district moves reliably co-produce verified
// answers. The map biases routing (scoreLegs' transition term) and is drawn as
// paved shortcuts on the Agent Map.
//
// Design (user's calls): GLOBAL map only (no user_id), rebuilt NIGHTLY by the
// external cron. Because it is a full recompute over a trailing window, the
// weight model is deliberately ORDER-INDEPENDENT and stateless — a smoothed
// verified-rate, not a path-dependent EMA — so the pass is idempotent and the
// table is always exactly the function of the last `windowDays` of history.
// Older evidence ages out of the window: that IS the decay.
const db = require('../../database');
const microCache = require('../microCache');
const { classifyTask } = require('../AgentLeaderboard');
const { districtOf } = require('./RouteStats');

// Below this many traversals an edge does not influence routing — the same
// "don't learn on one lucky run" discipline used everywhere else in the arc.
const MIN_TRAVERSALS = 5;
// Laplace-style smoothing: an edge seen once and verified scores 1/(1+K), not a
// falsely-confident 1.0. Also caps rich-get-richer — weight is a RATE, and one
// run moves it by at most ~1/(traversals+K), which shrinks as volume grows.
const SMOOTHING = 3;
// A run older than this no longer counts — the decay horizon.
const WINDOW_DAYS = 60;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Ordered district transitions of one run → the distinct-adjacent hops. Repeated
 * calls in the same district (markets→markets) collapse; only real moves count.
 * PURE.
 * @param {string[]} districts - districts in tool-call order
 * @returns {Array<[string,string]>}
 */
function transitionsOf(districts) {
  const seq = (districts || []).filter(Boolean);
  const out = [];
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) out.push([seq[i - 1], seq[i]]);
  return out;
}

/**
 * Aggregate runs into raw per-edge counters. PURE and order-independent.
 * @param {Array<{districts:string[], verified:boolean}>} runs
 * @returns {Object} agg[from][to] = { traversals, verified }
 */
function aggregateTransitions(runs) {
  const agg = {};
  for (const r of runs || []) {
    const seen = new Set(); // one run reinforces an edge at most once, capping volume bias
    for (const [from, to] of transitionsOf(r.districts)) {
      const key = from + '\u0000' + to;
      if (seen.has(key)) continue;
      seen.add(key);
      const F = agg[from] || (agg[from] = {});
      const c = F[to] || (F[to] = { traversals: 0, verified: 0 });
      c.traversals++;
      if (r.verified) c.verified++;
    }
  }
  return agg;
}

/** Smoothed verified-rate for one edge. PURE. */
function edgeWeight({ traversals = 0, verified = 0 } = {}, smoothing = SMOOTHING) {
  if (traversals <= 0) return 0;
  return clamp01(verified / (traversals + smoothing));
}

/**
 * Flatten an aggregate into a routing weight map, keeping only edges above the
 * influence threshold. PURE.
 * @returns {Object} weights[from][to] = weight(0..1)
 */
function buildWeightMap(agg, { minTraversals = MIN_TRAVERSALS, smoothing = SMOOTHING } = {}) {
  const w = {};
  for (const from of Object.keys(agg || {})) {
    for (const to of Object.keys(agg[from])) {
      const c = agg[from][to];
      if (c.traversals < minTraversals) continue;
      (w[from] || (w[from] = {}))[to] = edgeWeight(c, smoothing);
    }
  }
  return w;
}

/** The learned boost for moving from `last` to `candidate`, 0 if none. PURE. */
function transitionBoost(last, candidate, weights) {
  if (!last || !weights || !weights[last]) return 0;
  return weights[last][candidate] || 0;
}

// ── Nightly reinforcement pass (DB) ──────────────────────────────────────────
/**
 * Recompute the whole learned_routes table from the last `windowDays` of
 * completed runs. Idempotent: the table is replaced with exactly the function of
 * current history, so running it twice changes nothing, and it doubles as the
 * `--rebuild`. One transaction; edges that fell out of the window are pruned.
 */
async function runRouteLearning({ windowDays = WINDOW_DAYS, smoothing = SMOOTHING } = {}) {
  // Ordered tool districts + verification per execution, within the window.
  // A run "verified" its route when it finished cleanly AND the user did not
  // rate the answer down. Finishing alone used to be enough, so a route that
  // reliably produced confident wrong answers was paved like a good one.
  const res = await db.query(`
    SELECT tc.execution_id, tc.tool_name, e.goal,
      (e.completion_reason = 'natural'
        AND COALESCE(e.metrics->'feedback'->>'rating', '0') <> '-1') AS verified
    FROM tool_calls tc
    JOIN executions e ON e.execution_id = tc.execution_id
    WHERE e.current_state IN ('completed', 'failed')
      AND e.created_at >= now() - ($1 || ' days')::interval
    ORDER BY tc.execution_id, tc.created_at ASC
  `, [String(windowDays)]);

  // Group rows into per-run district sequences, tagged by task type.
  const byExec = new Map();
  for (const row of res.rows) {
    let g = byExec.get(row.execution_id);
    if (!g) { g = { districts: [], goal: row.goal, verified: row.verified }; byExec.set(row.execution_id, g); }
    g.districts.push(districtOf(row.tool_name));
  }

  // Aggregate per task type independently.
  const runsByTask = {};
  for (const g of byExec.values()) {
    const t = classifyTask(g.goal);
    (runsByTask[t] || (runsByTask[t] = [])).push({ districts: g.districts, verified: g.verified });
  }

  const rows = [];
  for (const task of Object.keys(runsByTask)) {
    const agg = aggregateTransitions(runsByTask[task]);
    for (const from of Object.keys(agg)) {
      for (const to of Object.keys(agg[from])) {
        const c = agg[from][to];
        rows.push([task, from, to, edgeWeight(c, smoothing), c.traversals, c.verified]);
      }
    }
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE learned_routes');
    for (const r of rows) {
      await client.query(
        `INSERT INTO learned_routes (task_type, from_district, to_district, weight, traversals, verified, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())`,
        r
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Per-task cache keys carry a 60s TTL — a nightly rebuild need not bust them.
  return { taskTypes: Object.keys(runsByTask).length, edges: rows.length, windowDays };
}

/** Routing weight map for one task type (influence-gated). Cached briefly. */
async function getLearnedWeights({ taskType, minTraversals = MIN_TRAVERSALS, smoothing = SMOOTHING } = {}) {
  return microCache.cached('learned_routes:' + taskType, 60000, async () => {
    const res = await db.query(
      'SELECT from_district, to_district, traversals, verified FROM learned_routes WHERE task_type = $1',
      [taskType]
    );
    const agg = {};
    for (const r of res.rows) {
      (agg[r.from_district] || (agg[r.from_district] = {}))[r.to_district] = { traversals: r.traversals, verified: r.verified };
    }
    return buildWeightMap(agg, { minTraversals, smoothing });
  });
}

/** All learned edges for a task type, for the map (paved shortcuts). Not gated
 *  as hard as routing — the map may show a faint emerging edge. */
async function getLearnedEdges({ taskType, minTraversals = 3 } = {}) {
  try {
    const res = await db.query(
      `SELECT from_district, to_district, weight, traversals FROM learned_routes
       WHERE task_type = $1 AND traversals >= $2 ORDER BY weight DESC LIMIT 40`,
      [taskType, minTraversals]
    );
    return res.rows.map(r => ({ from: r.from_district, to: r.to_district, weight: Number(r.weight), traversals: r.traversals }));
  } catch (_) { return []; }
}

module.exports = {
  transitionsOf, aggregateTransitions, edgeWeight, buildWeightMap, transitionBoost,
  runRouteLearning, getLearnedWeights, getLearnedEdges,
  MIN_TRAVERSALS, SMOOTHING, WINDOW_DAYS
};
