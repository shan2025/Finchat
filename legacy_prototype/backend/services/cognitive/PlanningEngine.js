// services/cognitive/PlanningEngine.js — Generates structured multi-step plans for complex goals
const { runInference } = require('../inference');
const { query } = require('../../database');
const { listTools, getToolNames } = require('./ToolRegistry');

// The tool list is built from the live ToolRegistry, so new tools are plannable
// the moment they're registered (this prompt once hardcoded search+stocks only,
// which silently crippled every multi-tool plan).
//
// It is also scoped to the agent doing the planning. This is the prompt that
// produced `bash "synthesis.sh"` / `bash "brief.sh"` for nova — steps naming
// scripts that do not exist, for work that is reasoning rather than shell —
// purely because bash was listed as available to an agent that may not run it.
function buildPlanningPrompt(agentId = null) {
  const toolLines = listTools({ agentId })
    .map(t => `  - "${t.name}": ${t.description.split('.')[0]}.`)
    .join('\n');

  return `You are a planning specialist. Given a complex goal, break it down into an ordered list of concrete steps.

You MUST respond with valid JSON matching this exact shape:
{
  "plan_summary": "<1-sentence summary of the overall approach>",
  "steps": [
    {"step": 1, "action": "tool|respond", "description": "<what this step does>", "tool": "<tool_name or null>", "input": "<tool input or null>"},
    {"step": 2, "action": "tool|respond", "description": "<what this step does>", "tool": "<tool_name or null>", "input": "<tool input or null>"}
  ]
}

RULES:
- Each step must have a "step" number, "action" type, and "description".
- Use "tool" action when external data is needed. The LAST step must be action "respond" for the final synthesis.
- Keep plans concise: 2-8 steps maximum. One tool call per step; repeat a tool with different inputs as separate steps (e.g. one "crypto" step per symbol).
- "input" must be the exact input string/JSON for that tool.
AVAILABLE TOOLS:
${toolLines}
- Respond with ONLY the JSON object. No markdown, no code fences.`;
}

/**
 * Generate a structured multi-step plan for a complex goal.
 * Invoked only when ReasoningEngine's first turn returns action: "plan" (Decision #5).
 *
 * @param {object} options
 * @param {string} options.executionId - The execution to attach the plan to
 * @param {string} options.goal - The user's complex goal
 * @returns {Promise<{ plan: object, stored: boolean }>}
 */
async function plan({ executionId, goal, agentId = null }) {
  const messages = [
    { role: 'system', content: buildPlanningPrompt(agentId) },
    { role: 'user', content: `Goal: "${goal}"` }
  ];

  const result = await runInference({
    messages,
    temperature: 0.3, // Low temperature for structured planning
    jsonMode: true
  });

  let planData;
  try {
    let cleaned = result.content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    planData = JSON.parse(cleaned);
  } catch (parseErr) {
    console.warn(`⚠️ PlanningEngine: Failed to parse plan JSON: ${parseErr.message}`);
    // Fallback: create a simple 2-step plan
    planData = {
      plan_summary: `Execute the goal: ${goal}`,
      steps: [
        { step: 1, action: 'tool', description: 'Gather information', tool: 'search', input: goal },
        { step: 2, action: 'respond', description: 'Synthesize findings and respond', tool: null, input: null }
      ]
    };
  }

  // Validate plan structure
  if (!planData.steps || !Array.isArray(planData.steps) || planData.steps.length === 0) {
    planData.steps = [
      { step: 1, action: 'respond', description: 'Respond directly to the goal', tool: null, input: null }
    ];
  }

  // Normalize malformed steps — smaller models often emit the tool name AS the
  // action ({"action":"watchlist","tool":null}), which would silently execute
  // zero steps. Coerce anything tool-shaped into {action:'tool', tool:<name>}.
  //
  // Deliberately the FULL registry, not the agent-scoped list: this is parsing,
  // not authorisation. If a model names a tool it was not offered, the step
  // should still be recognised as a tool step so ToolManager can refuse it with
  // a clear permission error — mis-parsing it into a `respond` step would hide
  // the mistake and silently drop the work instead.
  const toolNames = getToolNames();
  planData.steps = planData.steps.map(s => {
    const step = { ...s };
    if (step.action !== 'tool' && step.action !== 'respond') {
      if (toolNames.includes(String(step.action))) {
        step.tool = String(step.action);
        step.action = 'tool';
      } else if (step.tool && toolNames.includes(String(step.tool))) {
        step.action = 'tool';
      } else {
        step.action = 'respond';
      }
    }
    if (step.action === 'tool' && !step.tool && toolNames.includes(String(s.action))) {
      step.tool = String(s.action);
    }
    return step;
  });

  // Store plan in executions.current_plan
  let stored = false;
  try {
    await query(
      'UPDATE executions SET current_plan = $1, updated_at = now() WHERE execution_id = $2',
      [JSON.stringify(planData), executionId]
    );
    stored = true;
  } catch (err) {
    console.warn(`⚠️ PlanningEngine: Failed to store plan: ${err.message}`);
  }

  return { plan: planData, stored };
}

module.exports = { plan };
