// services/aiChat.js — Cognitive Core Chat Interface (Dual-Entry & Sentinel Support)
const { route } = require('./agents/PlatoOrchestrator');
const { getAgentConfig } = require('./agents/AgentRegistry');
const { SentinelAgent, classifyFraudSeverity } = require('./agents/SentinelAgent');

const FRAUD_TAG = '[FRAUD_DETECTED]';

// ── Greeting fast path ─────────────────────────────────────────
// "hi" used to take the full cognitive loop — a routing decision, a model call
// and several seconds — to produce whatever pleasantry the model felt like that
// day. A bare greeting carries no goal, so it is answered here, before any of
// that starts. The reply is still canned, but it is canned *in character*: each
// agent has its own pool, so the greeting sounds like the desk you walked up to
// and doesn't repeat itself word-for-word every session.
const GREETING_REPLIES = {
  plato: [
    "I'm the switchboard here — tell me the goal and I'll put the right desk on it.",
    "Good to see you. What are we solving? I'll route it to whoever's best at it.",
    "The floor's quiet and everyone's free. What do you want to get done?",
    "Supervisor on deck. Give me a messy problem and I'll break it into clean pieces.",
    "Four specialists downstairs, all idle. Give me something worth waking them for.",
    "You don't have to know which agent you need — that's my job. Just say the goal.",
    "I've got Aurelius on markets, Atlas on your portfolio, Rasha on careers, Nova on research. Pick a lane or describe the problem.",
    "Think of me as the front desk with opinions. What's on your mind?",
    "Big question or small one, I'll find it a home. Go ahead.",
    "Ready to delegate. What's the thing you've been putting off?",
    "Tell me what 'done' looks like and I'll work backwards from there.",
    "At your service. Vague is fine — I'll ask the follow-ups."
  ],
  aurelius: [
    "Markets never sleep and neither do I. What are we looking at — a ticker, a sector, or a headline?",
    "Name a company and I'll tell you what's actually moving it, not what the chyron says.",
    "I hunt catalysts: policy, macro, money flows. Point me at something.",
    "Ready when you are. Give me a symbol or a story and I'll dig for the why.",
    "Price is the last thing to know and the first thing everyone quotes. What do you actually want understood?",
    "Give me a ticker. I'll come back with the catalyst, not the cheerleading.",
    "Regulation, rates, geopolitics, or someone famous tweeting — every move has an author. Whose move are we reading?",
    "I don't do hot tips and I don't do advice. I do evidence. What's the question?",
    "Something rattling your watchlist today, or are we exploring?",
    "Happy to argue with the consensus if you bring me a name.",
    "Sector, stock, or macro — where do you want me to start digging?",
    "The interesting story is usually two layers under the headline. Hand me a headline."
  ],
  atlas: [
    "Your portfolio's where you left it. Want today's read, or are we digging into a position?",
    "I watch the holdings so you don't have to refresh. Ask me how things are sitting.",
    "Steward reporting in. I can walk your risk, your drift, or your growth since you started.",
    "No trades from me, ever — just an honest look at what you own. Where do we start?",
    "I keep a daily snapshot, so 'am I actually growing' is a question I can answer with numbers instead of vibes.",
    "Want the calm version or the concentrated-risk version? Both are true.",
    "I'm the one who notices when a single position quietly becomes half your book.",
    "Checking in on the holdings, or is something specific bothering you?",
    "I can show you what changed since yesterday, since last week, or since day one.",
    "Boring is a compliment in my line of work. Want to see how boring things look today?",
    "Ask me what you own, what it's doing, or what's drifted out of shape.",
    "On watch as always. What would you like me to look at?"
  ],
  rasha: [
    "Career desk. Are we hunting roles today, sharpening the resume, or prepping for a conversation?",
    "Tell me the job you want and I'll tell you the gap between here and there.",
    "I read job posts so you don't have to scroll. What kind of role are we after?",
    "Ready to work on the next move. Applications, positioning, or interviews?",
    "Product, BA, project management — say the title and the city and I'll go looking.",
    "A resume is an argument, not a list. Want to sharpen yours?",
    "I can search fresh postings, tailor your CV to one, or draft the note that goes with it.",
    "Your next role probably exists already — it's just badly titled. Let's go find it.",
    "Want me to check the job alerts sitting in your inbox?",
    "Applications, interview prep, or the awkward salary conversation? I do all three.",
    "Tell me where you are and where you'd rather be. I'll map the distance.",
    "Nothing gets sent without your say-so — I only ever draft. So, what are we working on?"
  ],
  nova: [
    "Research bench is open. What should I go read for you?",
    "Papers, patents, preprints — give me a topic and I'll come back with the state of it.",
    "I like the questions nobody's answered yet. Got one?",
    "Point me at a frontier — AI, bio, energy, space — and I'll map what's real versus hype.",
    "Ask me something you'd normally give up on after three tabs.",
    "I'll read the paper so you can read the summary. What's the topic?",
    "Half of what's announced this week won't replicate. Want help telling which half?",
    "Curiosity is the whole job description. What are you curious about?",
    "Give me a technology and I'll tell you where it actually is, not where the press release says.",
    "I can go shallow and fast or deep and slow. Your call — what's the subject?",
    "New field, old question, or something you read and didn't believe?",
    "The bench is clear and the coffee's fresh. What are we investigating?"
  ],
  _default: [
    "I'm here and ready. What are we working on?",
    "Good to see you. Give me something to chew on.",
    "All set on my end. What do you need?",
    "Ready when you are — what's the task?",
    "Say the word and I'll get started."
  ]
};

// A greeting sent at 2am shouldn't read the same as one sent over breakfast.
// These are prepended to the persona line often enough to feel alive, rarely
// enough that they don't become their own tic.
const TIME_OPENERS = {
  night:   ['Up late.', 'Burning the midnight oil, I see.', 'Late one tonight.'],
  morning: ['Morning.', 'Good morning.', 'Early start.'],
  evening: ['Evening.', 'Good evening.']
};

// Render runs in UTC, so the server clock says "morning" in the middle of the
// user's afternoon. Cadence elsewhere in the system defaults to IST; this does
// the same rather than greeting people in the wrong half of their day.
const IST_OFFSET_MIN = 5 * 60 + 30;

function timeBucket(date) {
  const h = Math.floor(
    (((date.getTime() / 60000) + IST_OFFSET_MIN) % 1440 + 1440) % 1440 / 60
  );
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h >= 18) return 'evening';
  return null;               // plain daytime gets no preamble
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function greetingFor(personaId, now = new Date()) {
  const pool = GREETING_REPLIES[String(personaId || '').toLowerCase()] || GREETING_REPLIES._default;
  const line = pick(pool);
  const bucket = timeBucket(now);
  // Roughly one greeting in three picks up the time-of-day nod.
  if (bucket && Math.random() < 0.34) return `${pick(TIME_OPENERS[bucket])} ${line}`;
  return line;
}

// Matches a message that is ONLY a greeting: "hi", "helloo", "hey there",
// "good morning", "hello Plato 👋". Anything with an actual request attached
// ("hi, check TSLA") falls through to the normal path.
const GREETING_RE = new RegExp(
  '^(?:h+i+|h+e+y+|h+e+l+o+|h+e+l+l+o+|hiya|yo|howdy|greetings|sup|namaste|hola|' +
  'good\\s+(?:morning|afternoon|evening|day))' +
  '(?:\\s+(?:there|again|all|team|everyone|folks|guys|bot|ai|agent|' +
  'plato|aurelius|atlas|rasha|nova))*' +
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
    // "@nova hi" greets Nova even if the chat is pointed at someone else.
    const mention = String(userMessage || '').match(/^@([a-zA-Z0-9_-]+)\s/);
    const greeter = (mention && GREETING_REPLIES[mention[1].toLowerCase()])
      ? mention[1].toLowerCase()
      : (personaId || 'plato');
    const reply = greetingFor(greeter);
    return {
      response: reply,
      cleanResponse: reply,
      fraudDetected: false,
      delegatedAgent: greeter,
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
