// services/cognitive/ContextBuilder.js — Builds LLM context for the Cognitive Core reasoning loop
const { getPersona, STUDY_MODE_DIRECTIVE } = require('../personas');
const { listTools } = require('./ToolRegistry');

/**
 * Build a tool description block for the system prompt.
 *
 * `agentId` is the persona key ('plato', 'nova', …), which is the same
 * namespace as tool_permissions.agent_id. Passing it keeps host-access tools
 * out of the prompt for agents that may not run them, so they stop planning
 * steps that can only fail.
 */
// First sentence of a tool description — the "what it does", without the
// "when to use it" coaching that follows. Falls back to a hard character cap
// for descriptions written without sentence breaks.
function _firstSentence(text, cap = 150) {
  const s = String(text || '');
  const end = s.search(/\.\s/);
  const first = end > 0 ? s.slice(0, end + 1) : s;
  return first.length > cap ? `${first.slice(0, cap).trimEnd()}…` : first;
}

/**
 * Build a tool description block for the system prompt.
 *
 * `agentId` is the persona key ('plato', 'nova', …), which is the same
 * namespace as tool_permissions.agent_id. Passing it keeps host-access tools
 * out of the prompt for agents that may not run them, so they stop planning
 * steps that can only fail.
 *
 * `compact` renders names and one-line purposes without parameter schemas.
 *
 * IMPORTANT: whichever rendering a run uses, it must use it for EVERY turn of
 * that run. See CATALOGUE_COMPACT below for why.
 */
function buildToolDescriptions(allowWeb = true, agentId = null, { compact = false, agentTools = null } = {}) {
  const tools = listTools({ allowWeb, agentId, agentTools });
  if (tools.length === 0) return '';

  const toolLines = tools.map(t => {
    if (compact) return `  - "${t.name}": ${_firstSentence(t.description)}`;
    const params = t.inputSchema?.properties
      ? Object.entries(t.inputSchema.properties).map(([k, v]) => `${k} (${v.type}): ${v.description || ''}`).join(', ')
      : 'no parameters';
    return `  - "${t.name}": ${t.description} | Parameters: ${params}`;
  }).join('\n');

  const webNote = allowWeb ? '' :
    '\n\nNOTE: The user has turned OFF web access for this conversation, so open-web search/browsing tools are hidden. Your data tools (prices, jobs, papers, resume) still work. If the goal truly needs the open web, say so and ask the user to enable the WEB toggle.';

  const compactNote = compact
    ? '\n(Tool list shown in short form. Pass a simple string input unless the tool obviously needs more.)'
    : '';

  return `\n\nAVAILABLE TOOLS:\n${toolLines}${compactNote}${webNote}`;
}

/**
 * The unified action schema per Phase 3 spec, now with tool descriptions from ToolRegistry.
 */
function getActionSchema(allowWeb = true, studyMode = false, agentId = null, { compactTools = false, agentTools = null } = {}) {
  const toolBlock = buildToolDescriptions(allowWeb, agentId, { compact: compactTools, agentTools });

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
- For simple questions, use "respond" directly — but "simple" means conceptual or general ("explain magical realism", "what is an index fund"), NOT a question about a specific named thing. See the verification rule below.
- Only use "plan" if the goal clearly requires multiple sequential steps.
- Use "tool" when you need external data you don't have. Pass the input as a simple string (e.g. for stocks, just the ticker symbol like "TSLA").
- **CRITICAL: If the user asks about ANY time-sensitive data — current prices (stocks/crypto/commodities), today's news, current job listings, recent research papers, "right now"/"today"/"current"/"latest" — you MUST use a tool. Your training data is stale; NEVER guess numbers or fabricate URLs. If no matching tool exists, say so plainly and suggest where the user can look.**
- **CRITICAL — VERIFY NAMED THINGS: If the user asks about a SPECIFIC named work, person, organisation or artefact (a book, story, poem, film, album, paper, company, product, historical event), you MUST verify with a tool — \`wikipedia\` for anything encyclopedic, \`search\` otherwise — BEFORE stating facts about it. Titles, authors, dates, plots, attributions and "is X real?" are exactly the details your training data gets subtly wrong, and a confident wrong answer is worse than a slow one.**
- **NEVER claim that a named work "does not exist", is "misattributed", is "not well known", or that you "cannot find" it unless a tool actually ran and came back empty. Not recognising a title is a fact about YOUR memory, not about the world — many real works are absent from your training data. If a tool reports that search is unavailable, say the search is down; do not convert that into a claim about the work.**
- **If you genuinely cannot verify, you may still answer from memory — but label it plainly as unverified recall ("I'm not certain, and I couldn't check this") and do NOT invent specifics. Never fabricate a date, publication year, plot, form (novel vs short story) or attribution to fill a gap. Omit what you do not know.**
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
 * Standing preferences the MemoryEngine learned from earlier conversations
 * ("explain it like I'm a child", "keep it short", "always cite sources").
 *
 * These are the user's own words about HOW they want to be answered, so they
 * outrank the persona's default voice and the operator's trait sliders — but
 * not an explicit instruction in the message currently being answered.
 *
 * @param {Array<{label: string, instruction: string}>} prefs
 * @returns {string} system-prompt fragment ('' when nothing has been learned)
 */
function buildPreferenceDirective(prefs) {
  if (!Array.isArray(prefs) || prefs.length === 0) return '';
  const lines = prefs
    .map(p => (p && (p.instruction || p.label) ? `- ${p.instruction || p.label}` : null))
    .filter(Boolean)
    .slice(0, 8);
  if (!lines.length) return '';
  return `\n\n--- HOW THIS USER WANTS ANSWERS (learned from earlier conversations) ---\n` +
    `${lines.join('\n')}\n` +
    `Follow these in every reply without being asked again, and without mentioning that you remembered them. ` +
    `If the user's current message contradicts one, the current message wins.`;
}

// Character budget for the whole tool-results block.
//
// This block used to be unbounded: every tool result was JSON.stringify'd in
// full and concatenated. A five-source research mission built a 32,667-char
// request, which Groq answered with 413, and inference.js then rescued it by
// capping EVERY message at 12000 (then 4000) chars — blind truncation applied
// equally to the agent's instructions. The run burned 37k tokens on retries
// and never wrote its report.
//
// Budgeting here instead means the request is the right size on the first
// attempt, on any provider, and the truncation is deliberate rather than an
// emergency measure applied to whatever happened to be longest.
const TOOL_BLOCK_BUDGET = parseInt(process.env.TOOL_CONTEXT_BUDGET_CHARS || '12000', 10);

// Never drop a tool entirely. A result trimmed to nothing reads to the model
// as "that tool returned nothing", which invites it to call the tool again —
// the exact loop the "NEVER call a tool that already has a result" rule exists
// to prevent.
const MIN_PER_TOOL = 300;

// Character budget for prior conversation turns.
//
// This was previously unbounded: every message of the session was appended in
// full, on every iteration of the loop, forever. A long-running chat therefore
// grew its own per-turn cost without limit, and because the prompt is re-sent
// and re-charged each iteration the growth is paid several times per answer.
// It had not yet shown up as the dominant cost (the tool catalogue is bigger in
// a fresh session) which is exactly why it was worth capping before it did.
//
// Trimming keeps the MOST RECENT turns: the tail is what the current question
// refers back to, where the head is usually a topic the user has moved on from.
// That is the opposite of the tool-result packer above, which keeps heads —
// deliberately, because there the head of a document is its summary, whereas
// here the end of a conversation is its subject.
const HISTORY_BUDGET_CHARS = parseInt(process.env.HISTORY_CONTEXT_BUDGET_CHARS || '8000', 10);

// How the tool catalogue is rendered — for the WHOLE run, never per turn.
//
// This was briefly decided per turn: full while the model was still choosing a
// tool, compact once results were in hand. It cut ~366 tokens off the second
// turn and was measurably wrong, because it changed the first system message
// mid-run and so destroyed the prompt prefix.
//
// DeepSeek caches an identical prefix automatically. Measured 2026-08-18:
// resending the same 1,933-token prefix returned prompt_cache_hit_tokens 1920
// — 99% of it, billed at a fraction. A prefix that changes between turns can
// never hit, so saving 366 tokens on turn two forfeited a cache hit on the
// ~1,000 tokens before it. The optimisation cost more than it saved.
//
// The catalogue is small enough for that to be the obvious trade now that each
// agent is scoped to its own domain (measured, full rendering): nova 533 tok,
// rasha 575, aurelius 701. Compacting those saves 326-451 tokens once, against
// a cache hit worth far more on every subsequent turn — and full keeps the
// parameter schemas, so tool selection carries no added risk at all.
//
// Set TOOL_CATALOGUE_COMPACT=1 to render compact for every turn instead. That
// is still stable and still cacheable; it trades parameter schemas for a
// smaller `tokens_used`, which is the right call only if a provider WITHOUT
// automatic prefix caching becomes the primary. It is a policy switch, not a
// per-turn decision — flipping it mid-run is the bug this constant documents.
const CATALOGUE_COMPACT = process.env.TOOL_CATALOGUE_COMPACT === '1';

// …unless the catalogue itself is oversized, in which case compact wins.
//
// The reasoning above holds while an agent is scoped to its own domain (3-5k
// chars). It does not hold for a caller that gets the WHOLE catalogue — the
// orchestrator, and any path that builds a prompt without an agent's tool list.
// That set only ever grows: adding standing tasks, the application ledger and
// the portfolio pushed the full rendering past 20k chars, and with tool results
// alongside it the request went over the size that has already earned a 413
// from a provider once.
//
// This stays a per-RUN decision, not a per-turn one — the catalogue depends on
// the agent's tool set, which cannot change mid-run — so the prompt prefix is
// still byte-identical across turns and still cacheable. It just picks the
// rendering that fits.
const CATALOGUE_MAX_CHARS = parseInt(process.env.TOOL_CATALOGUE_MAX_CHARS || '9000', 10);

/**
 * Keep the most recent conversation turns that fit the budget.
 *
 * Returns the kept messages plus how many were dropped, so the caller can tell
 * the model that older turns exist rather than letting it assume the
 * conversation began where the window starts.
 */
function packHistory(history, budget = HISTORY_BUDGET_CHARS) {
  if (!Array.isArray(history) || history.length === 0) return { kept: [], dropped: 0 };
  const kept = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const size = String(history[i]?.content || '').length;
    // Always keep at least the latest exchange, however large, so a single long
    // message cannot leave the model with no conversational context at all.
    if (used + size > budget && kept.length > 0) break;
    kept.unshift(history[i]);
    used += size;
  }
  return { kept, dropped: history.length - kept.length };
}

/**
 * Fit tool results into a fixed character budget.
 *
 * Allocation is fair-share, smallest first: a tool that needs less than its
 * share releases the remainder to the larger ones. A single enormous search
 * result therefore cannot crowd out the four other sources — which is what
 * naive head-truncation of the concatenated block would do.
 *
 * @param {Array<{tool: string, result: *}>} toolResults
 * @param {number} [budget] - total characters available
 * @returns {string}
 */
function packToolResults(toolResults, budget = TOOL_BLOCK_BUDGET) {
  const entries = toolResults.map(tr => ({
    tool: tr.tool,
    text: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
  }));
  if (!entries.length) return '';

  const render = (e, text) => `[Tool: ${e.tool}] Result: ${text}`;
  const total = entries.reduce((n, e) => n + e.text.length, 0);
  if (total <= budget) return entries.map(e => render(e, e.text)).join('\n');

  const caps = new Map();
  let remaining = budget;
  let claimants = entries.length;
  // Ascending, so satisfied-in-full results hand their slack to the big ones.
  for (const e of [...entries].sort((a, b) => a.text.length - b.text.length)) {
    const fair = Math.max(MIN_PER_TOOL, Math.floor(remaining / claimants));
    const take = Math.min(e.text.length, fair);
    caps.set(e, take);
    remaining -= take;
    claimants--;
  }

  return entries.map(e => {
    const cap = caps.get(e);
    if (e.text.length <= cap) return render(e, e.text);
    const dropped = e.text.length - cap;
    return render(e, `${e.text.slice(0, cap)}…[${dropped} more chars trimmed to fit the context budget]`);
  }).join('\n');
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
  missingSources = [],
  // Live contest status during a multi-agent race — the structured standings
  // that let this agent decide, economically, whether more evidence is worth the
  // fuel. A prebuilt string (see RaceState.contestNote); injected only mid-race.
  contest = null,
  // Competitive route hint — the historically most productive, still-uncovered
  // knowledge districts for this task, so the agent can prefer a proven leg and
  // diversify away from ground a rival already holds. A prebuilt string (see
  // CognitiveCore.buildRouteHint); advisory, injected only when it exists.
  routeHint = null,
  traits = null,
  userPreferences = [],
  allowWeb = true,
  studyMode = false,
  // This agent's configured tool domain, from agent_configs.tools. Passed in
  // because the caller already holds the config — see listTools.
  agentTools = null,
  // Populated in place with what this build cost and what it saved, so the
  // effect of context work is measurable instead of "the prompt feels smaller".
  // An out-parameter rather than a changed return type: buildContext returns a
  // message array to several callers and a test harness, and none of them
  // should have to change to make a KPI available.
  stats = null
}) {
  const messages = [];

  // Fixed for the whole run, deliberately NOT derived from toolResults — the
  // first system message must be byte-identical on every turn or the provider's
  // prefix cache can never hit. See CATALOGUE_COMPACT.
  const compactTools = CATALOGUE_COMPACT ||
    buildToolDescriptions(allowWeb, agentName, { compact: false, agentTools }).length > CATALOGUE_MAX_CHARS;

  // 1. System prompt: agent persona + runtime style tuning + action schema
  const persona = getPersona(agentName);
  const personaPrompt = persona
    ? persona.systemPrompt
    : 'You are Plato, the Chief AI Officer of FinChat. Answer the user\'s questions thoughtfully and precisely.';

  // agentName is the persona key, which doubles as the permission agent_id —
  // so the tool block shown to this agent matches what it may actually run.
  const actionSchema = budgetExceeded
    ? BUDGET_EXCEEDED_SCHEMA
    : getActionSchema(allowWeb, studyMode, agentName, { compactTools, agentTools });
  const traitDirective = budgetExceeded ? '' : buildTraitDirective(traits);
  // Preferences survive a breached budget: "keep it short" matters MORE when
  // the answer is being cut off, and dropping "explain it simply" mid-session
  // is exactly the inconsistency the user notices.
  const prefDirective = buildPreferenceDirective(userPreferences);
  // Study Mode still applies under a breached budget — the answer is shorter,
  // but it should still come back as cards rather than switching format midway.
  const studyDirective = studyMode ? STUDY_MODE_DIRECTIVE : '';

  messages.push({
    role: 'system',
    content: `${personaPrompt}${traitDirective}${prefDirective}${studyDirective}\n\n--- RESPONSE FORMAT ---\n${actionSchema}`
  });

  // Research stopped short of the plan. Name the sources that never ran so the
  // write-up states the gap instead of quietly reading as a complete brief —
  // and so the model does not fill the hole with invented numbers.
  if (budgetExceeded && Array.isArray(missingSources) && missingSources.length > 0) {
    messages.push({
      role: 'system',
      content:
        `--- PARTIAL RESEARCH ---\nThese planned sources were NOT retrieved: ${missingSources.join(', ')}.\n` +
        `Write the report from the results you do have, and state plainly near the top which sources are ` +
        `missing. Do NOT invent figures for the missing sources.`
    });
  }

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

  // 2d. Contest awareness (multi-agent race). Never under a breached budget —
  // when the answer is being cut off, "go gather more" is exactly the wrong
  // nudge. The note itself tells the agent to weigh fuel against evidence, so it
  // is a decision input, not an order to keep searching.
  if (!budgetExceeded && contest) {
    messages.push({ role: 'system', content: contest });
  }

  // 2b-bis. Route hint — advisory guidance toward proven, uncovered legs. Also
  // suppressed under a breached budget: with the answer being cut off, steering
  // the agent toward one more district is the wrong nudge.
  if (!budgetExceeded && routeHint) {
    messages.push({ role: 'system', content: routeHint });
  }

  // 3. Tool results from previous iterations
  if (toolResults.length > 0) {
    const toolBlock = packToolResults(toolResults);
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

  // 4. Conversation history, most-recent-first within a fixed budget.
  const { kept: keptHistory, dropped: droppedTurns } = packHistory(conversationHistory);
  if (droppedTurns > 0) {
    // Say that the window was trimmed. Without this the model reads the oldest
    // kept turn as the start of the conversation and can contradict something
    // it agreed to earlier, which is worse than admitting the gap.
    messages.push({
      role: 'system',
      content: `--- EARLIER CONVERSATION TRIMMED ---\n${droppedTurns} older message(s) are not shown. ` +
        `If the user refers to something you cannot see, say so and ask them to restate it rather than guessing.`
    });
  }
  for (const msg of keptHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // 5. Current user goal
  messages.push({
    role: 'user',
    content: goal
  });

  if (stats && typeof stats === 'object') {
    const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
    // What the same request would have cost built the old way. Only the two
    // reductions are counted, and each is measured rather than assumed: the
    // catalogue delta is the real difference between the two renderings, and
    // the history delta is the real size of what was dropped.
    const fullTools = compactTools && !budgetExceeded
      ? buildToolDescriptions(allowWeb, agentName, { compact: false, agentTools }).length -
        buildToolDescriptions(allowWeb, agentName, { compact: true, agentTools }).length
      : 0;
    const droppedChars = conversationHistory
      .slice(0, conversationHistory.length - keptHistory.length)
      .reduce((n, m) => n + String(m?.content || '').length, 0);

    stats.chars = chars;
    stats.charsSaved = fullTools + droppedChars;
    stats.toolCatalogueCharsSaved = fullTools;
    stats.historyCharsSaved = droppedChars;
    stats.droppedTurns = droppedTurns;
    stats.compactTools = compactTools;
    // Share of what an un-optimised build of this same turn would have cost.
    stats.compressionRatio = (chars + stats.charsSaved) > 0
      ? Number((stats.charsSaved / (chars + stats.charsSaved)).toFixed(4))
      : 0;
  }

  return messages;
}

module.exports = {
  buildContext,
  packToolResults,
  packHistory,
  buildToolDescriptions,
  TOOL_BLOCK_BUDGET,
  HISTORY_BUDGET_CHARS,
  buildTraitDirective,
  buildPreferenceDirective,
  getActionSchema,
  BUDGET_EXCEEDED_SCHEMA
};
