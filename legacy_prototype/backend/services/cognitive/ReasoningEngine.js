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
 * @returns {Promise<{ action: object, raw: string, provider: string, model: string, retried: boolean, fallback: boolean }>}
 */
async function reason({ messages, temperature = 0.7, model = null }) {
  // First attempt: call LLM with JSON mode
  const firstResult = await runInference({
    messages,
    temperature,
    jsonMode: true,
    model
  });

  const firstParse = parseActionResponse(firstResult.content);

  if (firstParse.valid) {
    return {
      action: firstParse.parsed,
      raw: firstResult.content,
      provider: firstResult.provider,
      model: firstResult.model,
      tokens: firstResult.tokens || 0,
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
      model
    });

    const retryParse = parseActionResponse(retryResult.content);

    if (retryParse.valid) {
      return {
        action: retryParse.parsed,
        raw: retryResult.content,
        provider: retryResult.provider,
        model: retryResult.model,
        tokens: (firstResult.tokens || 0) + (retryResult.tokens || 0),
        retried: true,
        fallback: false
      };
    }
  } catch (retryErr) {
    console.warn(`⚠️ ReasoningEngine: Corrective retry inference failed: ${retryErr.message}`);
  }

  // Fallback per Decision #11: treat raw text or extracted response as a "respond" action
  console.warn('⚠️ ReasoningEngine: Corrective retry also failed. Extracting response or falling back to raw text.');

  let fallbackResponse = firstResult.content.trim() || 'I encountered an issue processing your request. Please try again.';
  try {
    const maybeObj = JSON.parse(fallbackResponse);
    if (maybeObj && typeof maybeObj === 'object') {
      // Prefer a real non-empty string field; NEVER dump raw JSON if response was falsy.
      const pickString = (v) => typeof v === 'string' && v.trim().length > 0 ? v : null;
      fallbackResponse =
        pickString(maybeObj.response) ||
        pickString(maybeObj.message) ||
        pickString(maybeObj.content) ||
        pickString(maybeObj.thought) ||
        'I gathered information but had trouble formatting the reply. Please try asking again.';
    }
  } catch (e) {
    const respMatch = fallbackResponse.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (respMatch && respMatch[1]) {
      fallbackResponse = respMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    } else {
      fallbackResponse = fallbackResponse.replace(/\{?\s*"thought"\s*:\s*"[^"]*"\s*,?\s*/i, '').replace(/[\{\}]/g, '').trim();
    }
  }

  return {
    action: {
      thought: 'Fallback: LLM did not produce valid JSON after correction attempt.',
      action: 'respond',
      response: fallbackResponse
    },
    raw: firstResult.content,
    provider: firstResult.provider,
    model: firstResult.model,
    tokens: firstResult.tokens || 0,
    retried: true,
    fallback: true
  };
}

module.exports = {
  reason,
  parseActionResponse,
  VALID_ACTIONS
};
