// services/cognitive/ReasoningEngine.js — Unified JSON reasoning loop with corrective retry per Decision #11
const { runInference } = require('../inference');

/**
 * Valid action types from the unified action schema (Phase 3 spec)
 */
const VALID_ACTIONS = ['respond', 'tool', 'plan', 'wait'];

/**
 * Attempt to parse and validate the LLM output against the unified action schema.
 *
 * @param {string} rawContent - Raw string from the LLM
 * @returns {{ parsed: object|null, valid: boolean, error: string|null }}
 */
function parseActionResponse(rawContent) {
  let cleaned = (rawContent || '').trim();

  // Strip markdown code fences if the model wraps its JSON
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Try to extract JSON block if there's extra text before/after
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e) {
        return { parsed: null, valid: false, error: `JSON parse error: ${err.message}` };
      }
    } else {
      return { parsed: null, valid: false, error: `JSON parse error: ${err.message}` };
    }
  }

  if (typeof parsed !== 'object' || !parsed) {
    return { parsed: null, valid: false, error: 'Parsed content is not an object' };
  }

  // Normalize common LLM action aliases (e.g. "response" -> "respond", "reply" -> "respond")
  if (parsed.action === 'response' || parsed.action === 'reply' || parsed.action === 'answer' || (!parsed.action && parsed.response)) {
    parsed.action = 'respond';
  }

  // Common LLM slip: emit `"action":"<tool_name>"` instead of `"action":"tool", "tool":"<tool_name>"`.
  // Detect by matching a known non-schema action string, then coerce.
  if (parsed.action && !VALID_ACTIONS.includes(parsed.action)) {
    // Treat the action itself as a tool name and gather any sibling fields as tool input.
    const toolName = String(parsed.action);
    const inputFields = { ...parsed };
    delete inputFields.thought;
    delete inputFields.action;
    delete inputFields.tool;
    delete inputFields.input;
    delete inputFields.response;
    let input = parsed.input;
    if (input == null && Object.keys(inputFields).length > 0) input = inputFields;
    parsed.action = 'tool';
    parsed.tool = toolName;
    parsed.input = input != null ? input : '';
  }

  // Normalize missing thought if response exists
  if (!parsed.thought && typeof parsed.response === 'string') {
    parsed.thought = 'Responding directly to user.';
  }

  // Validate required fields
  if (typeof parsed.thought !== 'string' || !parsed.thought) {
    return { parsed, valid: false, error: 'Missing or invalid "thought" field' };
  }
  if (!VALID_ACTIONS.includes(parsed.action)) {
    return { parsed, valid: false, error: `Invalid action "${parsed.action}". Must be one of: ${VALID_ACTIONS.join(', ')}` };
  }

  // Validate action-specific fields
  if (parsed.action === 'respond') {
    if (typeof parsed.response !== 'string') {
      // Try to unwrap a text field from an object response; otherwise force the retry loop.
      if (parsed.response && typeof parsed.response === 'object') {
        const inner = parsed.response.response || parsed.response.content || parsed.response.text || parsed.response.message;
        if (typeof inner === 'string' && inner.trim().length > 0) parsed.response = inner;
        else return { parsed, valid: false, error: '"response" must be a non-empty string' };
      } else {
        return { parsed, valid: false, error: '"response" must be a non-empty string' };
      }
    }
    if (!parsed.response.trim()) {
      return { parsed, valid: false, error: '"response" cannot be empty' };
    }
    // Sprint Z · Study Mode: an optional sibling array of typed study blocks.
    // Kept as real objects (never a string) so the model never has to escape
    // JSON inside JSON — CognitiveCore serialises them on the way out. A
    // malformed value is dropped rather than failing the whole turn: losing
    // the cards is recoverable, losing the answer is not.
    if ('blocks' in parsed) {
      const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : null;
      const clean = (blocks || []).filter(
        b => b && typeof b === 'object' && !Array.isArray(b) && typeof b.type === 'string'
      );
      if (clean.length) parsed.blocks = clean;
      else delete parsed.blocks;
    }
  }
  if (parsed.action === 'tool') {
    if (typeof parsed.tool !== 'string' || !parsed.tool) {
      return { parsed, valid: false, error: 'Action "tool" requires a "tool" string field' };
    }
    // Accept either a string OR an object — object gets JSON-serialized for the tool,
    // and tool executors already parse JSON strings back into objects (or accept both).
    if (typeof parsed.input === 'string') {
      // ok
    } else if (parsed.input && typeof parsed.input === 'object') {
      parsed.input = JSON.stringify(parsed.input);
    } else {
      return { parsed, valid: false, error: 'Action "tool" requires an "input" string or object' };
    }
  }
  if (parsed.action === 'wait') {
    if (typeof parsed.reason !== 'string' || !parsed.reason) {
      return { parsed, valid: false, error: 'Action "wait" requires a "reason" string field (e.g. "human_approval" or "scheduled_trigger")' };
    }
  }

  return { parsed, valid: true, error: null };
}

/**
 * Run one reasoning turn through the LLM with the unified action schema.
 * Implements Decision #11: format: "json" + one corrective retry + raw-text fallback.
 *
 * @param {object} options
 * @param {Array} options.messages - Full message array from ContextBuilder
 * @param {number} [options.temperature] - LLM temperature
 * @param {string} [options.userId] - Whose request this is. Tagged onto the
 *   inference metric so the Knowledge Center can show each user their OWN token
 *   and latency figures; without it every account saw one shared global total.
 * @param {string} [options.agentId] - Which agent is thinking, for the same reason.
 * @returns {Promise<{ action: object, raw: string, provider: string, model: string, retried: boolean, fallback: boolean }>}
 */
async function reason({ messages, temperature = 0.7, model = null, workload = 'chat',
                       userId = null, agentId = null }) {
  // First attempt: call LLM with JSON mode
  let firstResult;
  try {
    firstResult = await runInference({
      messages,
      temperature,
      jsonMode: true,
      model,
      // Selects the provider order for this kind of work — scheduled research
      // and interactive chat draw on different pools. See WORKLOAD_ROUTES.
      workload,
      feature: workload,
      userId,
      agentId
    });
  } catch (err) {
    console.warn(`⚠️ ReasoningEngine: first runInference failed (${err.message}). Attempting non-JSON fallback inference...`);
    try {
      firstResult = await runInference({
        messages,
        temperature,
        jsonMode: false,
        model,
        workload,
        feature: workload,
        userId,
        agentId
      });
    } catch (err2) {
      console.error(`❌ ReasoningEngine: inference failed across providers: ${err2.message}`);
      return {
        action: {
          thought: `Inference failed across providers (${err2.message}).`,
          action: 'respond',
          response: `I am currently experiencing temporary high traffic or network delays connecting to my inference engine (${err2.message}). Please give me just a moment and try asking your question again.`
        },
        raw: '',
        provider: 'system',
        model: 'fallback',
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        retried: true,
        fallback: true
      };
    }
  }

  const firstParse = parseActionResponse(firstResult.content);

  if (firstParse.valid) {
    return {
      action: firstParse.parsed,
      raw: firstResult.content,
      provider: firstResult.provider,
      model: firstResult.model,
      tokens: firstResult.tokens || 0,
      // Carried alongside the total so the execution row can record how much of
      // a turn was context re-read versus text produced. See migration 031.
      promptTokens: firstResult.promptTokens || 0,
      completionTokens: firstResult.completionTokens || 0,
      retried: false,
      fallback: false
    };
  }

  // Corrective retry per Decision #11: one re-prompt asking for valid JSON
  console.warn(`⚠️ ReasoningEngine: First parse failed (${firstParse.error}). Attempting corrective retry...`);

  const correctionMessages = [
    ...messages,
    { role: 'assistant', content: firstResult.content },
    {
      role: 'user',
      content: 'Your previous response was not valid JSON matching the required schema. Respond again with ONLY a JSON object matching one of the three valid shapes. No markdown, no code fences, no explanation — just the JSON object.'
    }
  ];

  try {
    const retryResult = await runInference({
      messages: correctionMessages,
      temperature: 0.3, // Lower temperature for correction
      jsonMode: true,
      model,
      workload,
      feature: workload,
      userId,
      agentId
    });

    const retryParse = parseActionResponse(retryResult.content);

    if (retryParse.valid) {
      return {
        action: retryParse.parsed,
        raw: retryResult.content,
        provider: retryResult.provider,
        model: retryResult.model,
        tokens: (firstResult.tokens || 0) + (retryResult.tokens || 0),
        // A corrective retry re-sends the whole conversation, so BOTH calls'
        // prompts are charged. Summing them is what makes the re-read cost of a
        // retry visible instead of hiding inside the total.
        promptTokens: (firstResult.promptTokens || 0) + (retryResult.promptTokens || 0),
        completionTokens: (firstResult.completionTokens || 0) + (retryResult.completionTokens || 0),
        retried: true,
        fallback: false
      };
    }
  } catch (retryErr) {
    console.warn(`⚠️ ReasoningEngine: Corrective retry inference failed: ${retryErr.message}`);
  }

  // Fallback per Decision #11: treat raw text or extracted response as a "respond" action
  console.warn('⚠️ ReasoningEngine: Corrective retry also failed. Extracting response or falling back to raw text.');

  const GENERIC_EMPTY = 'I encountered an issue processing your request. Please try again.';
  const GENERIC_FORMAT = 'I gathered information but had trouble formatting the reply. Please try asking again.';

  // Part 1 — diagnostic capture. The raw synthesis output is not persisted on the
  // execution row, so a fallback used to be a dead end when debugging WHY a long,
  // URL-heavy report (Rasha's job hunt is the repeat offender) failed to come back
  // as valid JSON. Log a bounded prefix so one real failure reveals the exact
  // malformation (truncated string vs. empty completion vs. bad escaping).
  const rawContent = firstResult.content || '';
  console.warn(
    `⚠️ ReasoningEngine: fallback raw output ` +
    `(len=${rawContent.length}, provider=${firstResult.provider || '?'}/${firstResult.model || '?'}, ` +
    `completionTokens=${firstResult.completionTokens || 0}): ` +
    JSON.stringify(rawContent.slice(0, 2000))
  );

  // Best-effort unescape of a JSON string body salvaged by regex (not full JSON).
  const unescapeJsonString = (s) => s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
    // Drop a dangling incomplete escape left by a truncated string.
    .replace(/\\$/, '')
    .trim();

  // Part 2 — salvage a malformed-but-present report instead of discarding it.
  // `salvaged` stays false only when we could NOT recover real content; it drives
  // the `fallback` flag below, which CognitiveCore maps to completion_reason
  // ('natural' when we delivered a real answer, 'error' when we truly failed).
  let fallbackResponse = rawContent.trim() || GENERIC_EMPTY;
  let salvaged = false;
  const isSubstantial = (s) => typeof s === 'string' && s.trim().length >= 40;

  try {
    const maybeObj = JSON.parse(fallbackResponse);
    if (maybeObj && typeof maybeObj === 'object') {
      // Prefer a real non-empty string field; NEVER dump raw JSON if response was falsy.
      const pickString = (v) => typeof v === 'string' && v.trim().length > 0 ? v : null;
      const body = pickString(maybeObj.response) || pickString(maybeObj.message) || pickString(maybeObj.content);
      if (body) {
        fallbackResponse = body;
        salvaged = isSubstantial(body);
      } else {
        // `thought` is reasoning scaffolding, not the answer — deliver it as a
        // last resort but do NOT treat it as a successfully salvaged report.
        fallbackResponse = pickString(maybeObj.thought) || GENERIC_FORMAT;
      }
    }
  } catch (e) {
    // The JSON did not parse — most often because the big `response` string was
    // truncated mid-body (long report + URLs) so its closing quote never arrived.
    // 1) A complete, well-formed "response":"…" (closing quote present).
    const complete = fallbackResponse.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (complete && complete[1]) {
      fallbackResponse = unescapeJsonString(complete[1]);
      salvaged = isSubstantial(fallbackResponse);
    } else {
      // 2) A TRUNCATED "response":"… with no closing quote — take everything after
      //    the opening quote. This is the case that turned Rasha's finished report
      //    into an "error" notification: the content was all there, just unterminated.
      const truncated = fallbackResponse.match(/"response"\s*:\s*"([\s\S]*)$/);
      if (truncated && truncated[1]) {
        fallbackResponse = unescapeJsonString(truncated[1]);
        salvaged = isSubstantial(fallbackResponse);
      } else {
        // 3) Last resort: strip the JSON scaffolding and keep whatever prose remains.
        //    Unreliable, so this is NOT counted as a salvaged report.
        fallbackResponse = fallbackResponse
          .replace(/\{?\s*"thought"\s*:\s*"[^"]*"\s*,?\s*/i, '')
          .replace(/[\{\}]/g, '')
          .trim() || GENERIC_FORMAT;
      }
    }
  }

  if (salvaged) {
    console.warn('✅ ReasoningEngine: salvaged a real response from malformed JSON — delivering as natural.');
  }

  return {
    action: {
      thought: salvaged
        ? 'Recovered the response from malformed JSON (likely a truncated or unescaped body).'
        : 'Fallback: LLM did not produce valid JSON after correction attempt.',
      action: 'respond',
      response: fallbackResponse
    },
    raw: firstResult.content,
    provider: firstResult.provider,
    model: firstResult.model,
    tokens: firstResult.tokens || 0,
    promptTokens: firstResult.promptTokens || 0,
    completionTokens: firstResult.completionTokens || 0,
    retried: true,
    // A recovered report is a real answer — let CognitiveCore record it as
    // 'natural' so the mission delivers it instead of an "error" notification.
    // We only flag `fallback` (→ 'error') when nothing usable could be recovered.
    fallback: !salvaged
  };
}

module.exports = {
  reason,
  parseActionResponse,
  VALID_ACTIONS
};
