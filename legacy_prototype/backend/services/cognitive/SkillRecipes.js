// services/cognitive/SkillRecipes.js — Sprint 5C · Procedural Chaining
// When an execution that ran a real multi-step plan completes naturally, capture the
// plan as a reusable "skill recipe" with an embedding, so future similar goals can
// prime the reasoner with a proven step sequence.

const { query } = require('../../database');
const { generateEmbedding } = require('./MemoryService');

// Cosine distance under which two goals count as the same task. Calibrated on
// Gemini SEMANTIC_SIMILARITY vectors: paraphrases land near 0.07, unrelated
// questions near 0.31.
const RECIPE_MAX_DISTANCE = 0.2;

/**
 * Normalize a plan into a compact steps array. Accepts either the plan object with
 * .steps or a raw array. Trims to essential fields for future replay hints.
 */
function normalizeSteps(plan) {
  const raw = Array.isArray(plan) ? plan : (plan && Array.isArray(plan.steps) ? plan.steps : null);
  if (!raw) return null;
  const steps = raw
    .map((s, i) => ({
      step: s.step || i + 1,
      action: s.action || (s.tool ? 'tool' : 'respond'),
      tool: s.tool || null,
      hint: (s.input ? String(s.input).slice(0, 160) : null) || (s.thought ? String(s.thought).slice(0, 160) : null)
    }))
    .filter(s => s.action);
  return steps.length ? steps : null;
}

/**
 * Store a recipe from a completed execution. No-op unless the execution actually ran
 * a plan and completed naturally. Best-effort — never throws.
 *
 * @param {object} execution - completed execution row
 * @returns {Promise<{ recipeId } | null>}
 */
async function recordFromExecution(execution) {
  try {
    if (!execution) return null;
    if (execution.completion_reason !== 'natural') return null;
    const steps = normalizeSteps(execution.current_plan);
    if (!steps || steps.length < 2) return null;

    const recipeId = `recipe_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const goal = (execution.goal || '').slice(0, 500);
    const title = goal.length > 80 ? goal.slice(0, 77) + '…' : goal;
    const agentId = execution.assigned_agent || null;

    const embedding = await generateEmbedding(goal, { purpose: 'similar' });
    const vectorStr = embedding ? `[${embedding.join(',')}]` : null;

    if (vectorStr) {
      await query(`
        INSERT INTO skill_recipes (recipe_id, title, goal_pattern, agent_id, steps, embedding, source_execution_id)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, $7)
      `, [recipeId, title, goal, agentId, JSON.stringify(steps), vectorStr, execution.execution_id]);
    } else {
      await query(`
        INSERT INTO skill_recipes (recipe_id, title, goal_pattern, agent_id, steps, source_execution_id)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [recipeId, title, goal, agentId, JSON.stringify(steps), execution.execution_id]);
    }

    return { recipeId };
  } catch (err) {
    console.warn(`⚠️ SkillRecipes.recordFromExecution failed: ${err.message}`);
    return null;
  }
}

/**
 * Retrieve the top-k recipes most similar to a fresh goal, optionally scoped to an agent.
 *
 * Scoped to recipes learned from this user's own executions or from runs with
 * no user behind them: a recipe's title is the original goal, verbatim, and it
 * is pasted into the prompt as "Previous goal: …" — so an unscoped search put
 * one user's questions in front of another.
 *
 * Empty when no embedding is available. The old fallback handed back the newest
 * recipes whatever the goal, which the model was then told to reuse.
 */
async function findRelevant({ goal, agentId, userId = null, limit = 2 } = {}) {
  if (!goal) return [];
  try {
    const embedding = await generateEmbedding(goal, { purpose: 'similar' });
    if (!embedding) return [];

    const vectorStr = `[${embedding.join(',')}]`;
    const args = [vectorStr, userId];
    let where = `WHERE r.embedding IS NOT NULL
        AND (x.user_id IS NULL OR x.user_id = $2)`;
    if (agentId) { args.push(agentId); where += ` AND (r.agent_id = $${args.length} OR r.agent_id IS NULL)`; }
    args.push(limit);
    const res = await query(`
      SELECT r.recipe_id, r.title, r.goal_pattern, r.steps, r.times_reused,
             (r.embedding <=> $1::vector) AS distance
      FROM skill_recipes r
      LEFT JOIN executions x ON x.execution_id = r.source_execution_id
      ${where}
      ORDER BY r.embedding <=> $1::vector
      LIMIT $${args.length}
    `, args);
    // Keep only goals close enough to reuse a plan for. The old < 0.6 suited
    // hash vectors (unrelated text sat near 1.0); Gemini puts even unrelated
    // questions around 0.3, so 0.6 would let every recipe through.
    return res.rows.filter(r => r.distance !== null && r.distance < RECIPE_MAX_DISTANCE);
  } catch (err) {
    console.warn(`⚠️ SkillRecipes.findRelevant failed: ${err.message}`);
    return [];
  }
}

/**
 * Bump reuse counter when a recipe is offered to a new execution.
 */
async function markReused(recipeId) {
  try {
    await query(`UPDATE skill_recipes SET times_reused = times_reused + 1 WHERE recipe_id = $1`, [recipeId]);
  } catch (err) { /* best-effort */ }
}

module.exports = { recordFromExecution, findRelevant, markReused, normalizeSteps };
