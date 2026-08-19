// services/agents/AgentRegistry.js — Database-backed Agent Registry with Upstash Redis caching
const { query } = require('../../database');
const { cacheGet, cacheSet } = require('../redis');
const microCache = require('../microCache');

const REGISTRY_CACHE_KEY = 'agent_registry:all_configs';
const REGISTRY_CACHE_TTL = 300; // 5 minutes
// Shorter than the Redis TTL on purpose: this layer only absorbs the repeated
// calls within a burst, and still defers to Redis/Postgres for freshness.
const REGISTRY_MEMORY_TTL_MS = 30_000;

/**
 * Fetch all agent configurations from PostgreSQL joined with agents table.
 *
 * Three layers: process memory, then Redis, then Postgres. The memory layer
 * exists because callers ask for one agent at a time — getAgentConfig() calls
 * straight through to here — so a six-agent group chat was making six Redis
 * round trips to read one object that had not changed between them.
 */
async function getAllAgentConfigs() {
  return microCache.cached('agent_registry', REGISTRY_MEMORY_TTL_MS, _loadAllAgentConfigs);
}

async function _loadAllAgentConfigs() {
  const cached = await cacheGet(REGISTRY_CACHE_KEY);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  const res = await query(`
    SELECT 
      a.agent_id,
      a.name,
      a.type,
      ac.system_prompt,
      ac.color,
      ac.capabilities,
      ac.tools,
      ac.is_direct_addressable,
      ac.memory_namespace,
      ac.runtime_settings
    FROM agents a
    JOIN agent_configs ac ON a.agent_id = ac.agent_id
    ORDER BY a.agent_id
  `);

  const configs = res.rows.map(row => ({
    agentId: row.agent_id,
    name: row.name,
    type: row.type,
    systemPrompt: row.system_prompt,
    color: row.color || '#888888',
    capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : (row.capabilities || []),
    tools: typeof row.tools === 'string' ? JSON.parse(row.tools) : (row.tools || []),
    isDirectAddressable: Boolean(row.is_direct_addressable),
    memoryNamespace: row.memory_namespace || `${row.agent_id}::default`,
    runtimeSettings: typeof row.runtime_settings === 'string' ? JSON.parse(row.runtime_settings) : (row.runtime_settings || {})
  }));

  await cacheSet(REGISTRY_CACHE_KEY, configs, REGISTRY_CACHE_TTL);
  return configs;
}

/**
 * Get a specific agent's config by agentId.
 * @param {string} agentId
 */
async function getAgentConfig(agentId) {
  const configs = await getAllAgentConfigs();
  return configs.find(c => c.agentId === agentId) || null;
}

/**
 * List active agents filtered by options.
 * @param {object} options
 * @param {boolean} [options.includeMiddleware=false] - Whether to include middleware agents like Sentinel
 * @param {boolean} [options.directOnly=false] - Whether to only return direct-addressable agents
 */
async function listActiveAgents({ includeMiddleware = false, directOnly = false } = {}) {
  const configs = await getAllAgentConfigs();
  return configs.filter(c => {
    if (!includeMiddleware && c.type === 'middleware') return false;
    if (directOnly && !c.isDirectAddressable) return false;
    return true;
  });
}

/**
 * Force clear the Redis cache and reload from PostgreSQL.
 */
async function refreshRegistry() {
  // NOTE: cacheGet/cacheSet store under the `cache:` prefix, so the invalidation
  // MUST delete the prefixed key (cacheDel handles that). Deleting the raw key
  // silently no-ops and leaves the registry stale for the full TTL.
  const { cacheDel } = require('../redis');
  await cacheDel(REGISTRY_CACHE_KEY);
  // The process-memory layer in front of Redis has to go too, or a forced
  // refresh keeps serving the old configs for up to REGISTRY_MEMORY_TTL_MS —
  // exactly the silent staleness the note above warns about, one layer up.
  microCache.invalidate('agent_registry');
  return await getAllAgentConfigs();
}

/**
 * Score an agent's capabilities against a user goal text.
 * @param {object} agentConfig
 * @param {string} goal
 */
function scoreCapabilities(agentConfig, goal) {
  if (!agentConfig.capabilities || !Array.isArray(agentConfig.capabilities)) return 0;
  const goalLower = goal.toLowerCase();
  let score = 0;
  for (const cap of agentConfig.capabilities) {
    if (goalLower.includes(cap.toLowerCase())) {
      score++;
    }
  }
  return score;
}

// The competitive racers: domain specialists only (see findTopAgents).
const RACER_IDS = new Set(['nova', 'aurelius', 'rasha']);

/**
 * Rank candidate agents for a goal by blending capability (70%) with
 * task-conditioned historical performance (30%). History only counts once an
 * agent has ≥ 5 completed runs of that task type; below that it routes on
 * capability alone, preserving prior behavior. Returns the ranked breakdown.
 * @param {string} goal
 * @param {Array} candidateConfigs - agent configs to consider
 * @param {object} [opts] - { userId } scopes history to one user; default global
 */
async function rankForGoal(goal, candidateConfigs, opts = {}) {
  // Deferred require avoids any load-order coupling — AgentRegistry is imported
  // very early, and the leaderboard pulls in the DB + trace helpers lazily.
  const { classifyTask, getProfilesCached, blendAgentScores } = require('../AgentLeaderboard');
  const candidates = candidateConfigs.map(a => ({ agentId: a.agentId, cap: scoreCapabilities(a, goal) }));
  const taskType = classifyTask(goal);
  const profilesByAgent = {};
  try {
    const prof = await getProfilesCached(opts);
    (prof.agents || []).forEach(a => { profilesByAgent[a.agent] = a; });
  } catch (e) {
    // History unavailable → capability-only routing (prior behavior).
  }
  const ranked = blendAgentScores({ candidates, profilesByAgent, taskType });
  return { taskType, ranked, weights: { capability: 0.7, history: 0.3 }, minRuns: 5 };
}

/**
 * Find the best matching specialist agent for a goal, history-aware.
 * Excludes orchestrators (Plato) and middleware (Sentinel). Capability remains a
 * gate: with no capability match at all it returns null (→ Plato), exactly as
 * before — history re-ranks capability-matched agents, it never invents a match.
 * @param {string} goal
 * @param {object} [opts] - { userId }
 * @returns {Promise<{agentConfig, score, finalScore, taskType, breakdown}|null>}
 */
async function findBestAgent(goal, opts = {}) {
  const specialists = (await listActiveAgents({ includeMiddleware: false })).filter(a => a.type !== 'orchestrator');
  const { taskType, ranked, weights, minRuns } = await rankForGoal(goal, specialists, opts);
  const matched = ranked.filter(r => r.cap > 0);
  if (matched.length === 0) return null;
  const winner = matched[0]; // ranked is sorted best-first
  const agentConfig = specialists.find(a => a.agentId === winner.agentId);
  return {
    agentConfig, score: winner.cap, finalScore: winner.finalScore, taskType,
    breakdown: { taskType, weights, minRuns, chosen: winner.agentId, candidates: ranked }
  };
}

/**
 * Pick the top N specialists for a goal — Plato's field for a multi-agent race.
 * Scores every specialist (excluding orchestrators/middleware) and returns the
 * best-matching agent ids. When nothing matches on capabilities, falls back to
 * the top N specialists so a race still has a field.
 * @param {string} goal
 * @param {number} [n=3] - clamped to [2,3]
 * @returns {Promise<string[]>} agent ids
 */
/**
 * Pick the top N racers for a goal — Plato's field for a multi-agent race —
 * history-aware. Restricted to real specialists (never infrastructure agents
 * like MemoryAgent). A race always has a field: all racers are ranked by the
 * blended score and the top N taken. Returns the field plus the breakdown.
 * @param {string} goal
 * @param {number} [n=3] - clamped to [2,3]
 * @param {object} [opts] - { userId }
 * @returns {Promise<{agents:string[], taskType:string, breakdown:object}>}
 */
async function findTopAgents(goal, n = 3, opts = {}) {
  const count = Math.max(2, Math.min(3, n));
  const racers = (await listActiveAgents({ includeMiddleware: false }))
    .filter(a => a.type !== 'orchestrator' && RACER_IDS.has(a.agentId));
  const { taskType, ranked, weights, minRuns } = await rankForGoal(goal, racers, opts);
  const chosen = ranked.slice(0, count);
  return {
    agents: chosen.map(r => r.agentId),
    taskType,
    breakdown: { taskType, weights, minRuns, candidates: ranked }
  };
}

module.exports = {
  getAllAgentConfigs,
  getAgentConfig,
  listActiveAgents,
  refreshRegistry,
  scoreCapabilities,
  findBestAgent,
  findTopAgents,
  rankForGoal,
  RACER_IDS,
  REGISTRY_CACHE_KEY
};
