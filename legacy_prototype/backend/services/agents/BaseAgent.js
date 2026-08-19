// services/agents/BaseAgent.js — Thick Agent Factory & Wrapper
const { run } = require('../cognitive/CognitiveCore');
const { getAgentConfig, scoreCapabilities } = require('./AgentRegistry');

/**
 * BaseAgent represents a "Thick Agent" in FinChat.
 * Each agent gets its own instantiation of the Cognitive Core, scoped with its
 * specific persona, capabilities, tool manifest, and memory namespace.
 */
class BaseAgent {
  /**
   * @param {object} config - Agent configuration from AgentRegistry
   * @param {string} config.agentId - Agent identifier ('aurelius', 'rasha', etc.)
   * @param {string} config.name - Human-readable name
   * @param {string} config.type - Agent type ('orchestrator', 'specialist', 'middleware')
   * @param {string} config.systemPrompt - Detailed system prompt persona
   * @param {string[]} config.capabilities - Capability keywords
   * @param {string[]} config.tools - Allowed tool names
   * @param {boolean} config.isDirectAddressable - Whether user can @agent directly
   * @param {string} config.memoryNamespace - Memory isolation namespace
   */
  constructor(config) {
    this.agentId = config.agentId;
    this.name = config.name;
    this.type = config.type;
    this.systemPrompt = config.systemPrompt;
    this.capabilities = config.capabilities || [];
    this.tools = config.tools || [];
    this.isDirectAddressable = config.isDirectAddressable;
    this.memoryNamespace = config.memoryNamespace || `${this.agentId}::default`;
    this.config = config;
  }

  /**
   * Factory method: instantiate a BaseAgent by fetching its config dynamically from AgentRegistry.
   * @param {string} agentId
   * @returns {Promise<BaseAgent|null>}
   */
  static async fromRegistry(agentId) {
    const config = await getAgentConfig(agentId);
    if (!config) return null;
    return new BaseAgent(config);
  }

  /**
   * Check if this agent's capabilities match a given goal.
   * Returns relevance score (0 = no match).
   * @param {string} goal
   */
  matchesGoal(goal) {
    return scoreCapabilities(this.config, goal);
  }

  /**
   * Execute a goal through this agent's scoped Cognitive Core instance.
   * @param {object} options
   * @param {string} options.goal - User query/goal
   * @param {string} [options.userId='system']
   * @param {string} [options.conversationId=null]
   * @param {Array} [options.conversationHistory=[]]
   */
  async execute({ goal, userId = 'system', conversationId = null, conversationHistory = [], allowWeb = true, studyMode = false, budget = {}, approvedTools = [], workload = 'chat', routing = null }) {
    return await run({
      goal,
      userId,
      conversationId,
      agentName: this.agentId,
      conversationHistory,
      allowWeb,
      studyMode,
      budget,
      approvedTools,
      workload,
      routing
    });
  }
}

module.exports = { BaseAgent };
