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

/**
 * Find the best matching specialist agent for a goal.
 * Excludes orchestrators (Plato) and middleware (Sentinel).
 * @param {string} goal
 */
async function findBestAgent(goal) {
  const specialists = await listActiveAgents({ includeMiddleware: false });
  let bestAgent = null;
  let bestScore = 0;

  for (const agent of specialists) {
    if (agent.type === 'orchestrator') continue; // Skip Plato when finding specialists
    const score = scoreCapabilities(agent, goal);
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
    }
  }

  if (bestScore === 0) return null;
  return { agentConfig: bestAgent, score: bestScore };
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
// The competitive racers: domain specialists only. Infrastructure agents
// (MemoryAgent, Sentinel) can score on capabilities but must never be entered
// into a race — they are not answering the question, they support the ones who do.
const RACER_IDS = new Set(['nova', 'aurelius', 'rasha']);

async function findTopAgents(goal, n = 3) {
  const count = Math.max(2, Math.min(3, n));
  const specialists = (await listActiveAgents({ includeMiddleware: false }))
    .filter(a => a.type !== 'orchestrator' && RACER_IDS.has(a.agentId));
  const scored = specialists
    .map(a => ({ agentId: a.agentId, score: scoreCapabilities(a, goal) }))
    .sort((x, y) => y.score - x.score);
  const matched = scored.filter(s => s.score > 0);
  const chosen = (matched.length >= 2 ? matched : scored).slice(0, count);
  return chosen.map(s => s.agentId);
}

module.exports = {
  getAllAgentConfigs,
  getAgentConfig,
  listActiveAgents,
  refreshRegistry,
  scoreCapabilities,
  findBestAgent,
  findTopAgents,
  REGISTRY_CACHE_KEY
};
