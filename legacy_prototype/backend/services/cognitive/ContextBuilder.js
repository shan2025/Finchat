// services/cognitive/ContextBuilder.js — Builds LLM context for the Cognitive Core reasoning loop
const { getPersona, STUDY_MODE_DIRECTIVE } = require('../personas');
const { listTools } = require('./ToolRegistry');

/**
 * Build a tool description block for the system prompt.
 */
function buildToolDescriptions(allowWeb = true) {
  const tools = listTools({ allowWeb });
  if (tools.length === 0) return '';

  const toolLines = tools.map(t => {
    const params = t.inputSchema?.properties
      ? Object.entries(t.inputSchema.properties).map(([k, v]) => `${k} (${v.type}): ${v.description || ''}`).join(', ')
      : 'no parameters';
    return `  - "${t.name}": ${t.description} | Parameters: ${params}`;
  }).join('\n');

  const webNote = allowWeb ? '' :
    '\n\nNOTE: The user has turned OFF web access for this conversation, so open-web search/browsing tools are hidden. Your data tools (prices, jobs, papers, resume) still work. If the goal truly needs the open web, say so and ask the user to enable the WEB toggle.';

  return `\n\nAVAILABLE TOOLS:\n${toolLines}${webNote}`;
}

/**
 * The unified action schema per Phase 3 spec, now with tool descriptions from ToolRegistry.
 */
function getActionSchema(allowWeb = true, studyMode = false) {
  const toolBlock = buildToolDescriptions(allowWeb);

  // Study Mode adds one optional sibling field. It has to be advertised here
  // as well as in the directive — the model follows the shape it is shown.
  const studyField = studyMode
    ? `, "blocks": [ <study blocks — see STUDY MODE below> ]`
    : '';

  return `You MUST respond with valid JSON matching ONE of these three shapes:

1. To respond to the user:
   {"thought": "<your internal reasoning>", "action": "respond", "response": "<your response to the user>"${studyField}}

2. To use a tool:
   {"thought": "<your internal reasoning>", "action": "tool", "tool": "<tool_name>", "input": "<tool input>"}

3. To create a multi-step plan:
   {"thought": "<your internal reasoning>", "action": "plan"}
${toolBlock}

RULES:
- You MUST always include "thought" and "action" fields.
- For simple questions, use "respond" directly.
- Only use "plan" if the goal clearly requires multiple sequential steps.
- Use "tool" when you need external data you don't have. Pass the input as a simple string (e.g. for stocks, just the ticker symbol like "TSLA").
- **CRITICAL: If the user asks about ANY time-sensitive data — current prices (stocks/crypto/commodities), today's news, current job listings, recent research papers, "right now"/"today"/"current"/"latest" — you MUST use a tool. Your training data is stale; NEVER guess numbers or fabricate URLs. If no matching tool exists, say so plainly and suggest where the user can look.**
- Respond with ONLY the JSON object. No markdown, no code fences, no extra text.`;
}

/**
 * Restricted schema used when budget is breached per Decision #2.
 */
const BUDGET_EXCEEDED_SCHEMA = `You MUST respond with valid JSON matching this exact shape:
{"thought": "<your reasoning>", "action": "respond", "response": "<your final response to the user>"}

You are NOT allowed to use tools or create plans. You must respond NOW.
Respond with ONLY the JSON object. No markdown, no code fences, no extra text.`;

/**
 * Turn an agent's runtime settings (risk + Formal/Brief/Serious sliders, 0-100) into a
 * short natural-language style directive injected into the system prompt. Slider semantics
 * match the Agents UI labels: 0 = left label, 100 = right label.
 *   formal:  0 Formal  → 100 Casual
 *   brief:   0 Brief   → 100 Detailed
 *   serious: 0 Serious → 100 Playful
 */
function buildTraitDirective(traits) {
  if (!traits || typeof traits !== 'object') return '';
  const parts = [];
  const f = traits.formal, b = traits.brief, s = traits.serious;
  if (typeof f === 'number') parts.push(f >= 60 ? 'Keep the tone casual and conversational.' : f <= 40 ? 'Maintain a formal, professional tone.' : null);
  if (typeof b === 'number') parts.push(b >= 60 ? 'Be thorough and provide detailed explanations.' : b <= 40 ? 'Be concise and to the point.' : null);
  if (typeof s === 'number') parts.push(s >= 60 ? 'Feel free to be light and a little playful.' : s <= 40 ? 'Stay serious and focused.' : null);
  if (traits.risk === 'High') parts.push('Take a bold, decisive stance and explore unconventional options.');
  else if (traits.risk === 'Low') parts.push('Be conservative, cautious, and precise.');
  const filtered = parts.filter(Boolean);
  return filtered.length ? `\n\n--- STYLE & BEHAVIOR TUNING ---\n${filtered.join(' ')}` : '';
}

/**
 * Build the full message array for the LLM inference call.
 *
 * @param {object} options
 * @param {string} options.goal - The user's goal/message
 * @param {string} [options.agentName] - Persona key (e.g. 'plato', 'aurelius')
 * @param {Array} [options.conversationHistory] - Prior messages [{role, content}]
 * @param {Array} [options.toolResults] - Results from previous tool calls [{tool, result}]
 * @param {Array} [options.memories] - Retrieved memories (Phase 6 wiring)
 * @param {boolean} [options.budgetExceeded] - If true, use restricted respond-only schema
 * @param {object} [options.traits] - Agent runtime settings {risk, formal, brief, serious}
 * @param {boolean} [options.studyMode] - Composer STUDY toggle: answer as study blocks
 * @returns {Array} messages - Array of {role, content} for the LLM
 */
function buildContext({
  goal,
  agentName = 'plato',
  conversationHistory = [],
  toolResults = [],
  memories = [],
  graphContext = [],
  recipeHints = [],
  budgetExceeded = false,
  traits = null,
  allowWeb = true,
  studyMode = false
}) {
  const messages = [];

  // 1. System prompt: agent persona + runtime style tuning + action schema
  const persona = getPersona(agentName);
  const personaPrompt = persona
    ? persona.systemPrompt
    : 'You are Plato, the Chief AI Officer of FinChat. Answer the user\'s questions thoughtfully and precisely.';

  const actionSchema = budgetExceeded ? BUDGET_EXCEEDED_SCHEMA : getActionSchema(allowWeb, studyMode);
  const traitDirective = budgetExceeded ? '' : buildTraitDirective(traits);
  // Study Mode still applies under a breached budget — the answer is shorter,
  // but it should still come back as cards rather than switching format midway.
  const studyDirective = studyMode ? STUDY_MODE_DIRECTIVE : '';

  messages.push({
    role: 'system',
    content: `${personaPrompt}${traitDirective}${studyDirective}\n\n--- RESPONSE FORMAT ---\n${actionSchema}`
  });

  // 2. Memory context (Phase 6 — now live via MemoryService)
  if (memories.length > 0) {
    const memoryBlock = memories.map(m => {
      const type = m.type || 'general';
      const content = m.content || m;
      return `- [${type}] ${content}`;
    }).join('\n');
    messages.push({
      role: 'system',
      content: `--- RELEVANT MEMORIES ---\n${memoryBlock}`
    });
  }

  // 2b. Sprint 5C: Graph-RAG one-hop related entities
  if (!budgetExceeded && Array.isArray(graphContext) && graphContext.length > 0) {
    const graphBlock = graphContext
      .map(g => `- ${g.name} (${g.type}) — connected via ${g.viaEdge}, weight ${g.weight}`)
      .join('\n');
    messages.push({
      role: 'system',
      content: `--- RELATED CONCEPTS (from prior sessions' knowledge graph) ---\n${graphBlock}\n\nMention these only if they are relevant to the user's actual goal.`
    });
  }

  // 2c. Sprint 5C: Skill recipes — proven step sequences for similar goals
  if (!budgetExceeded && Array.isArray(recipeHints) && recipeHints.length > 0) {
    const recipeBlock = recipeHints.map(r => {
      const steps = Array.isArray(r.steps) ? r.steps : (typeof r.steps === 'string' ? JSON.parse(r.steps) : []);
      const stepLines = steps.map(s => `  ${s.step}. ${s.action}${s.tool ? ` (${s.tool})` : ''}${s.hint ? ` — ${s.hint}` : ''}`).join('\n');
      return `• Previous goal: "${r.title}"\n${stepLines}`;
    }).join('\n\n');
    messages.push({
      role: 'system',
      content: `--- PROVEN SKILL RECIPES (reuse if the shape fits, don't force it) ---\n${recipeBlock}`
    });
  }

  // 3. Tool results from previous iterations
  if (toolResults.length > 0) {
    const toolBlock = toolResults.map(tr =>
      `[Tool: ${tr.tool}] Result: ${typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)}`
    ).join('\n');
    messages.push({
      role: 'system',
      content:
        `--- TOOL RESULTS FROM PREVIOUS STEPS ---\n${toolBlock}\n\n` +
        `Use these results. NEVER call a tool that already has a result listed above — its answer will not change. ` +
        `If the goal explicitly requires data from a DIFFERENT tool you have not called yet, call that tool next; ` +
        `otherwise you MUST use action "respond" now.\n` +
        `CITATION RULE: If any result contains a "url", "source", or "AbstractURL" field, you MUST include ` +
        `those URLs in your response as inline links so the user can verify the information. ` +
        `Never claim you "couldn't find results" if the tool returned any results — instead, present them ` +
        `with their sources. If a tool returned an error, say so plainly and suggest a next step.\n` +
        `SYNTHESIS RULE: When you have results from multiple tools, CROSS-REFERENCE them. ` +
        `Connect related findings across domains (e.g. link a stock earnings report to an industry trend from news, ` +
        `or connect a research paper to a funding round). Produce editorial analysis with "Why it matters" context, ` +
        `not just restated data. Structure your response with clear section headers when the output is long.`
    });
  }

  // 4. Conversation history
  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // 5. Current user goal
  messages.push({
    role: 'user',
    content: goal
  });

  return messages;
}

module.exports = {
  buildContext,
  buildTraitDirective,
  getActionSchema,
  BUDGET_EXCEEDED_SCHEMA
};
