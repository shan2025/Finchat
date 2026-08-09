// services/agents/PlatoOrchestrator.js — Dynamic routing with Sentinel Execution Middleware
const { BaseAgent } = require('./BaseAgent');
const { findBestAgent: registryFindBest, getAgentConfig } = require('./AgentRegistry');
const { SentinelAgent } = require('./SentinelAgent');
const { eventBus } = require('../cognitive/EventBus');

/**
 * Get an instantiated BaseAgent (Thick Agent) for a specific agentId.
 * @param {string} agentId
 * @returns {Promise<BaseAgent|null>}
 */
async function getAgentInstance(agentId) {
  return await BaseAgent.fromRegistry(agentId);
}

/**
 * Route a goal to the best agent and execute it through their scoped Cognitive Core.
 * Wrapped in SentinelAgent execution middleware for pre-check (fraud/budget) and post-log (audit/blockchain).
 * Supports Path 1 (Plato routing based on capabilities) and Path 2 (Direct addressing).
 *
 * @param {object} options
 * @param {string} options.goal - The user's goal
 * @param {string} [options.userId] - User ID
 * @param {string} [options.conversationId] - Conversation ID
 * @param {Array} [options.conversationHistory] - Prior messages
 * @param {string} [options.targetAgentId] - Optional direct target agentId (if pre-routed)
 * @returns {Promise<{ executionId, response, execution, logs, delegatedTo, auditTraceHash }>}
 */
async function route({ goal, userId = 'system', conversationId = null, conversationHistory = [], targetAgentId = null, allowWeb = true, studyMode = false, budget = {}, approvedTools = [] }) {
  // 1. Sentinel Middleware Pre-Check (Governance, Fraud & Budget enforcement)
  const preCheckResult = await SentinelAgent.preCheck(goal, { userId });
  if (!preCheckResult.allowed) {
    return {
      executionId: `blocked_${Date.now()}`,
      response: `${preCheckResult.reason}\n${preCheckResult.fraudDetected ? '[FRAUD_DETECTED]' : ''}`.trim(),
      cleanResponse: preCheckResult.reason,
      fraudDetected: Boolean(preCheckResult.fraudDetected),
      delegatedAgent: 'sentinel',
      isDirect: false,
      auditTraceHash: 'BLOCKED_BY_SENTINEL'
    };
  }

  let selectedAgent = null;
  let delegationScore = 0;
  let isDirect = false;

  // If a targetAgentId is explicitly passed (Dual-Entry direct addressing), bypass Plato's matching
  if (targetAgentId) {
    selectedAgent = await getAgentInstance(targetAgentId);
    if (selectedAgent) {
      isDirect = true;
    }
  }

  // Otherwise, run capability scoring against the active specialists in AgentRegistry
  if (!selectedAgent) {
    const match = await registryFindBest(goal);
    if (match) {
      selectedAgent = new BaseAgent(match.agentConfig);
      delegationScore = match.score;
    }
  }

  // Fallback to Plato if no specialist matched
  if (!selectedAgent) {
    selectedAgent = await getAgentInstance('plato');
    if (!selectedAgent) {
      // Fallback in case Plato config missing in DB
      selectedAgent = new BaseAgent({
        agentId: 'plato',
        name: 'Plato',
        type: 'orchestrator',
        systemPrompt: 'You are Plato, the Chief AI Officer of FinChat.',
        capabilities: []
      });
    }
  }

  // Emit delegation event if Plato routed to a specialist
  if (!isDirect && selectedAgent.agentId !== 'plato') {
    eventBus.emit('execution:delegated', {
      fromAgent: 'plato',
      toAgent: selectedAgent.agentId,
      goal,
      matchScore: delegationScore,
      timestamp: new Date().toISOString()
    });
  }

  // Execute the cognitive loop for the selected Thick Agent
  const rawResult = await selectedAgent.execute({
    goal,
    userId,
    conversationId,
    conversationHistory,
    allowWeb,
    studyMode,
    budget,
    approvedTools
  });

  const enrichedResult = {
    ...rawResult,
    delegatedTo: selectedAgent.agentId,
    delegationScore,
    isDirect
  };

  // 2. Sentinel Middleware Post-Log (Cryptographic tracing, Audit logs, and Blockchain prep)
  const finalResult = await SentinelAgent.postLog(enrichedResult, { userId, goal });
  return finalResult;
}

module.exports = {
  route,
  getAgentInstance
};
