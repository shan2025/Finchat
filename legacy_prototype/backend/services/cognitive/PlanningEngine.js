// services/cognitive/PlanningEngine.js — Generates structured multi-step plans for complex goals
const { runInference } = require('../inference');
const { query } = require('../../database');

const PLANNING_PROMPT = `You are a planning specialist. Given a complex goal, break it down into an ordered list of concrete steps.

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
- Use "tool" action when external data is needed. Use "respond" for the final synthesis step.
- Keep plans concise: 2-5 steps maximum.
- Available tools: "search" (web search), "stocks" (stock price lookup by ticker).
- Respond with ONLY the JSON object. No markdown, no code fences.`;

/**
 * Generate a structured multi-step plan for a complex goal.
 * Invoked only when ReasoningEngine's first turn returns action: "plan" (Decision #5).
 *
 * @param {object} options
 * @param {string} options.executionId - The execution to attach the plan to
 * @param {string} options.goal - The user's complex goal
 * @returns {Promise<{ plan: object, stored: boolean }>}
 */
async function plan({ executionId, goal }) {
  const messages = [
    { role: 'system', content: PLANNING_PROMPT },
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
