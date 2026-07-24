// services/aiChat.js — Cognitive Core Chat Interface (Dual-Entry & Sentinel Support)
const { route } = require('./agents/PlatoOrchestrator');
const { getAgentConfig } = require('./agents/AgentRegistry');
const { SentinelAgent, classifyFraudSeverity } = require('./agents/SentinelAgent');

const FRAUD_TAG = '[FRAUD_DETECTED]';

/**
 * Route a chat message through the Cognitive Core via PlatoOrchestrator.
 * Supports Dual-Entry: direct addressing (e.g., "@rasha review my cv") vs. indirect Plato routing.
 * Pre-check and post-log are handled by SentinelAgent middleware inside PlatoOrchestrator.route().
 */
async function chatWithPersona(personaId, userMessage, history = [], options = {}) {
  // Quick pre-check using Sentinel classification
  const severity = classifyFraudSeverity(userMessage);
  if (severity === 'EXTREME' || severity === 'HIGH') {
    return {
      response: 'Request flagged: Security indicator detected. Action restricted by Sentinel governance protocols.\n[FRAUD_DETECTED]',
      fraudDetected: true,
      cleanResponse: 'Request flagged: Security indicator detected. Action restricted by Sentinel governance protocols.',
      delegatedAgent: 'sentinel'
    };
  }

  try {
    let goal = userMessage.trim();
    let targetAgentId = null;

    // Check for direct prefix addressing, e.g. "@rasha what should I learn?" or "@aurelius check TSLA"
    const prefixMatch = goal.match(/^@([a-zA-Z0-9_-]+)\s+(.*)/s);
    if (prefixMatch) {
      const candidateId = prefixMatch[1].toLowerCase();
      const config = await getAgentConfig(candidateId);
      if (config && config.isDirectAddressable) {
        targetAgentId = candidateId;
        goal = prefixMatch[2].trim();
      }
    }

    // If not prefixed, but personaId is itself a specialist agent, target them directly
    if (!targetAgentId && personaId && typeof personaId === 'string') {
      const cleanPersona = personaId.toLowerCase();
      if (cleanPersona !== 'plato' && cleanPersona !== 'susheel' && cleanPersona !== 'sona' && cleanPersona !== 'vishnu') {
        const config = await getAgentConfig(cleanPersona);
        if (config && config.isDirectAddressable) {
          targetAgentId = cleanPersona;
        }
      }
    }

    // Determine dynamic cognitive budget based on user prompt keywords
    let dynamicBudget = undefined;
    const msgLower = goal.toLowerCase();
    
    if (msgLower.includes('ultrathink') || msgLower.includes('think intensely') || msgLower.includes('think super hard')) {
      dynamicBudget = { maxRuntimeSeconds: 300, maxToolCalls: 20, maxIterations: 20, maxTokens: 32000 };
    } else if (msgLower.includes('megathink') || msgLower.includes('think deeply') || msgLower.includes('think really hard')) {
      dynamicBudget = { maxRuntimeSeconds: 180, maxToolCalls: 15, maxIterations: 15, maxTokens: 15000 };
    } else if (msgLower.includes('think hard') || msgLower.includes('think more')) {
      dynamicBudget = { maxRuntimeSeconds: 120, maxToolCalls: 10, maxIterations: 12, maxTokens: 8000 };
    }

    // Pass execution to the full cognitive loop (supporting Dual-Entry routing & Sentinel Middleware)
    const result = await route({
      goal,
      userId: options.userId || 'system',
      conversationId: options.sessionId || 'default_session',
      conversationHistory: history,
      targetAgentId,
      allowWeb: options.webAccess !== false,
      ...(dynamicBudget ? { budget: dynamicBudget } : {})
    });

    // Check if the LLM flagged fraud during generation
    const rawResp = result.response || result.cleanResponse || '';
    const safeResponse = typeof rawResp === 'string' ? rawResp : String(rawResp);
    const fraudDetected = safeResponse.includes(FRAUD_TAG);
    const cleanResponse = safeResponse.replace(FRAUD_TAG, '').trim();

    return {
      response: safeResponse,
      cleanResponse,
      fraudDetected,
      executionId: result.executionId,
      delegatedAgent: result.delegatedTo || 'plato',
      isDirect: result.isDirect,
      auditTraceHash: result.auditTraceHash,
      provider: result.provider || null, // 'groq' | 'ollama' (local qwen fallback)
      model: result.model || null,
      // Sprint X Stage 2 — explainability: graph nodes / memories that fed the answer
      memoryTrace: result.memoryTrace || null,
      // Claude-style citations: web/data sources the agent consulted for this answer
      sources: Array.isArray(result.sources) ? result.sources : []
    };
  } catch (err) {
    console.error('⚠️ CognitiveCore Route Error:', err.stack || err.message);
    const errMessage = err.message || '';
    const userMsg = errMessage.includes('AI Inference unavailable') || errMessage.includes('rate limit') || errMessage.includes('429')
      ? `I'm currently experiencing temporary network delays connecting to my inference engine (${errMessage}). Please try asking your question again in a moment.`
      : 'System error processing your cognitive request. Falling back to safe mode.';
    return {
      response: userMsg,
      cleanResponse: userMsg,
      fraudDetected: false,
      delegatedAgent: 'system'
    };
  }
}

module.exports = {
  chatWithPersona,
  FRAUD_TAG,
  classifyFraudSeverity
};
