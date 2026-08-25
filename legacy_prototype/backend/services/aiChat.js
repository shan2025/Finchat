// services/aiChat.js — Cognitive Core Chat Interface (Dual-Entry & Sentinel Support)
const { route } = require('./agents/PlatoOrchestrator');
const { getAgentConfig } = require('./agents/AgentRegistry');
const { SentinelAgent, classifyFraudSeverity } = require('./agents/SentinelAgent');

const FRAUD_TAG = '[FRAUD_DETECTED]';

// ── Greeting fast path ─────────────────────────────────────────
// "hi" used to take the full cognitive loop — a routing decision, a model call
// and several seconds — to produce whatever pleasantry the model felt like that
// day. A bare greeting carries no goal, so it is answered here, identically
// every time, before any of that starts.
const GREETING_REPLY = 'Welcome to our system! How can we help you today?';

// Matches a message that is ONLY a greeting: "hi", "helloo", "hey there",
// "good morning", "hello Plato 👋". Anything with an actual request attached
// ("hi, check TSLA") falls through to the normal path.
const GREETING_RE = new RegExp(
  '^(?:h+i+|h+e+y+|h+e+l+o+|h+e+l+l+o+|hiya|yo|howdy|greetings|sup|namaste|hola|' +
  'good\\s+(?:morning|afternoon|evening|day))' +
  '(?:\\s+(?:there|again|all|team|everyone|folks|guys|bot|ai|agent|' +
  'plato|aurelius|rasha|nova))*' +
  '[\\s!.,?~\\-]*$',
  'i'
);

function isGreeting(text) {
  const t = String(text || '')
    .replace(/^@[a-zA-Z0-9_-]+\s+/, '')          // "@nova hi" is still a greeting
    .replace(/[\p{Extended_Pictographic}️]/gu, '') // drop 👋 / 🙂
    .trim();
  return t.length > 0 && t.length <= 40 && GREETING_RE.test(t);
}

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

  if (isGreeting(userMessage)) {
    return {
      response: GREETING_REPLY,
      cleanResponse: GREETING_REPLY,
      fraudDetected: false,
      delegatedAgent: personaId || 'plato',
      provider: 'system',
      model: 'greeting',
      sources: []
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

    // "think hard" and friends: the user asking for more effort than usual.
    //
    // These are FLOORS (`floor: true`), not overrides. As plain caller budgets
    // they outranked the agent's own configured budget in CognitiveCore, so
    // asking an agent to think harder could hand it LESS than it normally gets
    // — which is exactly what happened: "think hard" capped a run at 8,000
    // tokens while raising it to 12 iterations, guaranteeing the breach whose
    // error message recommends saying "think hard".
    //
    // The old numbers were sized against the 4,000-5,000 default that migration
    // 030 replaced; they were never re-scaled. A tool-using chat turn now costs
    // ~4k prompt tokens on its own (measured: Rasha's turn-2 prompt is 4,596),
    // and a reasoning model bills its thinking as completion on top, so a
    // two-turn answer lands near 15k before any extra effort is asked for.
    // Each rung must clear that by a real margin or it means nothing.
    let dynamicBudget = undefined;
    const msgLower = goal.toLowerCase();

    if (msgLower.includes('ultrathink') || msgLower.includes('think intensely') || msgLower.includes('think super hard')) {
      dynamicBudget = { maxRuntimeSeconds: 300, maxToolCalls: 20, maxIterations: 20, maxTokens: 60000, floor: true };
    } else if (msgLower.includes('megathink') || msgLower.includes('think deeply') || msgLower.includes('think really hard')) {
      dynamicBudget = { maxRuntimeSeconds: 240, maxToolCalls: 15, maxIterations: 15, maxTokens: 45000, floor: true };
    } else if (msgLower.includes('think hard') || msgLower.includes('think more')) {
      dynamicBudget = { maxRuntimeSeconds: 180, maxToolCalls: 10, maxIterations: 10, maxTokens: 30000, floor: true };
    }

    // Pass execution to the full cognitive loop (supporting Dual-Entry routing & Sentinel Middleware)
    const result = await route({
      goal,
      userId: options.userId || 'system',
      conversationId: options.sessionId || 'default_session',
      conversationHistory: history,
      targetAgentId,
      allowWeb: options.webAccess !== false,
      studyMode: options.studyMode === true, // composer STUDY toggle → card-format answers

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
    let userMsg;
    if (err.code === 'BYOK_REQUIRED' || errMessage.includes('BYOK_REQUIRED')) {
      userMsg = "You've used up your free allowance on our shared AI pool. To keep going, connect your own AI provider key (Groq, Gemini, DeepSeek, Mistral, Cerebras or OpenRouter) in **Settings → Bring Your Own AI**. Once connected, all the tools, knowledge and agents run on your key.";
    } else if (errMessage.includes('AI Inference unavailable') || errMessage.includes('rate limit') || errMessage.includes('429')) {
      userMsg = `I'm currently experiencing temporary network delays connecting to my inference engine (${errMessage}). Please try asking your question again in a moment.`;
    } else {
      userMsg = 'System error processing your cognitive request. Falling back to safe mode.';
    }
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
