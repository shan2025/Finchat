// services/agents/AgentRegistry.js — Database-backed Agent Registry with Upstash Redis caching
const { query } = require('../../database');
const { cacheGet, cacheSet } = require('../redis');

const REGISTRY_CACHE_KEY = 'agent_registry:all_configs';
const REGISTRY_CACHE_TTL = 300; // 5 minutes

/**
 * Fetch all agent configurations from PostgreSQL joined with agents table.
 * Uses Redis caching to prevent DB hits on the hot routing path.
 */
async function getAllAgentConfigs() {
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

module.exports = {
  getAllAgentConfigs,
  getAgentConfig,
  listActiveAgents,
  refreshRegistry,
  scoreCapabilities,
  findBestAgent,
  REGISTRY_CACHE_KEY
};
