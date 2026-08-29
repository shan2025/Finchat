// services/cognitive/RouteStats.js — competitive route adaptation.
//
// A "route" is the ordered set of knowledge districts (tool families) an agent
// traverses to reach a verified answer. This service turns the tool-call history
// the pipeline ALREADY writes into per-task-type route yield — which districts
// tend to produce usable evidence, and how cheaply — so an agent can prefer a
// productive leg and diversify away from one a rival already covers.
//
// No new tables: yield is derived from tool_calls/tool_results joined to
// executions, exactly like AgentLeaderboard derives agent stats. Leg-level token
// cost is not persisted (tokens_used is per-execution), so the honest cost proxy
// here is tool duration_ms; yield is whether the leg returned usable ground.
const db = require('../../database');
const microCache = require('../microCache');
const { classifyTask } = require('../AgentLeaderboard');

// Reuse the SAME tool→district taxonomy the Agent Map and ExecutionTrace use,
// so a scored leg maps to exactly the building the map already draws.
const { TOOL_DISTRICT } = require('./toolDistricts');

const round = (n, d = 0) => { const m = Math.pow(10, d); return Math.round((Number(n) || 0) * m) / m; };
const districtOf = (tool) => (TOOL_DISTRICT[tool] || ['tools'])[0];

/**
 * Aggregate route yield per (taskType → district) from real tool history.
 * verifiedRate = share of leg uses that returned usable ground (no error, output
 * present). avgCostMs = mean tool latency (the available cost proxy). Aggregated
 * across agents: district yield is largely a property of the knowledge source,
 * not of who walked it, and pooling keeps more cells above the sample threshold.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.userId] - scope to one user, or null = global
 * @returns {Promise<{byTask: Object}>} byTask[task][district] = {runs, verifiedRate, avgCostMs}
 */
async function getRouteStats({ userId = null } = {}) {
  const scope = userId ? 'AND e.user_id = $1' : '';
  const params = userId ? [userId] : [];
  let rows = [];
  try {
    const res = await db.query(`
      SELECT e.goal,
        tc.tool_name,
        (tr.error IS NULL AND tr.output IS NOT NULL) AS ok,
        COALESCE(tr.duration_ms, 0) AS ms
      FROM tool_calls tc
      JOIN executions e ON e.execution_id = tc.execution_id
      LEFT JOIN tool_results tr ON tr.call_id = tc.call_id
      WHERE e.current_state IN ('completed', 'failed') ${scope}
      ORDER BY tc.created_at DESC
      LIMIT 8000
    `, params);
    rows = res.rows;
  } catch (_) { /* best-effort read; empty stats degrade to capability-only routing */ }

  const byTask = {};
  for (const r of rows) {
    const task = classifyTask(r.goal);
    const d = districtOf(r.tool_name);
    const T = byTask[task] || (byTask[task] = {});
    const c = T[d] || (T[d] = { runs: 0, ok: 0, ms: 0 });
    c.runs++;
    if (r.ok) c.ok++;
    c.ms += Number(r.ms) || 0;
  }
  for (const task of Object.keys(byTask)) {
    for (const d of Object.keys(byTask[task])) {
      const c = byTask[task][d];
      byTask[task][d] = { runs: c.runs, verifiedRate: round(c.ok / c.runs, 3), avgCostMs: round(c.ms / c.runs) };
    }
  }
  return { byTask };
}

// Routing reads this per decision — cache briefly like the agent profiles.
function getRouteStatsCached({ userId = null } = {}) {
  return microCache.cached('route_stats:' + (userId || 'global'), 60000, () => getRouteStats({ userId }));
}

/**
 * Score candidate legs for the current turn (PURE — no DB, unit-tested).
 *
 * Two blended signals, mirroring the capability-primary discipline used for
 * agent routing:
 *   - Historical yield (slow): proven legs (runs ≥ minRuns) score on
 *     yieldWeight·verifiedRate + costWeight·costEfficiency. UNPROVEN legs get a
 *     neutral baseline (0.5) — never suppressed, never trusted — so behaviour is
 *     unchanged where there is not enough history.
 *   - Live coverage (fast): a leg a RIVAL already has verified evidence from is
 *     multiplied by coveredPenalty, pushing each lane toward complementary
 *     ground rather than duplicating the leader's sources.
 * Exploration: when `shouldExplore`, the single best UNPROVEN, uncovered leg is
 * boosted so a genuinely better new route can be discovered instead of frozen
 * out by the sample threshold. The random draw lives in the caller; this stays
 * deterministic.
 *
 * @param {object} opts
 * @param {Array<{district:string, tool?:string}>} opts.legs - candidate legs
 * @param {Object<string,{runs:number,verifiedRate:number,avgCostMs:number}>} opts.districtStats - for THIS task type
 * @param {Array<string>} [opts.coveredDistricts] - districts rivals already grounded
 * @param {number} [opts.minRuns=5]
 * @param {boolean} [opts.shouldExplore=false]
 * @param {string|null} [opts.lastDistrict] - the district the agent is moving FROM
 * @param {Object} [opts.transitionWeights] - learned from→to→weight map (RouteOptimizer)
 * @param {number} [opts.transitionWeight=0.25] - bounded corrective; yield/cost stay primary
 * @returns {Array} ranked legs, best first, with the scoring breakdown
 */
function scoreLegs({
  legs, districtStats = {}, coveredDistricts = [], minRuns = 5, shouldExplore = false,
  yieldWeight = 0.7, costWeight = 0.3, coveredPenalty = 0.5, exploreBoost = 0.15,
  lastDistrict = null, transitionWeights = null, transitionWeight = 0.25
}) {
  const list = Array.isArray(legs) ? legs : [];
  const covered = new Set(coveredDistricts || []);
  const cellFor = (d) => { const c = districtStats[d]; return (c && c.runs >= minRuns) ? c : null; };

  // Cost efficiency is comparative across the proven legs (lower latency better).
  const provenMs = list.map(l => cellFor(l.district)).filter(Boolean).map(c => c.avgCostMs);
  const lo = provenMs.length ? Math.min.apply(null, provenMs) : 0;
  const hi = provenMs.length ? Math.max.apply(null, provenMs) : 0;
  const costEff = (ms) => (hi > lo ? 1 - (ms - lo) / (hi - lo) : 1);

  const rows = list.map(l => {
    const cell = cellFor(l.district);
    const isCovered = covered.has(l.district);
    let base, yieldVal = null, eff = null;
    if (cell) {
      yieldVal = cell.verifiedRate;
      eff = costEff(cell.avgCostMs);
      base = yieldWeight * yieldVal + costWeight * eff;
    } else {
      base = 0.5; // neutral: unproven legs neither trusted nor penalised
    }
    // Learned transition term: a bounded additive corrective for a move the
    // system has learned tends to lead to verified answers. yield/cost stay
    // primary; this only nudges. Applied AFTER the coverage penalty so a
    // rival-held district is still deprioritised.
    const boost = (lastDistrict && transitionWeights && transitionWeights[lastDistrict])
      ? (transitionWeights[lastDistrict][l.district] || 0) : 0;
    const penalised = isCovered ? base * coveredPenalty : base;
    const score = penalised + transitionWeight * boost;
    return {
      district: l.district, tool: l.tool || null,
      proven: !!cell, runs: cell ? cell.runs : 0,
      yield: yieldVal == null ? null : round(yieldVal, 3),
      costEff: eff == null ? null : round(eff, 3),
      covered: isCovered, explored: false,
      transitionBoost: round(boost, 3),
      score: round(score, 4)
    };
  });

  if (shouldExplore) {
    // Surface the best unproven, uncovered leg so new routes can be discovered.
    const cand = rows.filter(r => !r.proven && !r.covered);
    if (cand.length) {
      cand.sort((a, b) => b.score - a.score || String(a.district).localeCompare(String(b.district)));
      const pick = cand[0];
      pick.explored = true;
      pick.score = round(pick.score + exploreBoost, 4);
    }
  }

  rows.sort((a, b) => b.score - a.score || b.runs - a.runs || String(a.district).localeCompare(String(b.district)));
  return rows;
}

module.exports = { getRouteStats, getRouteStatsCached, scoreLegs, districtOf };
