// services/cognitive/SkillRecipes.js — Sprint 5C · Procedural Chaining
// When an execution that ran a real multi-step plan completes naturally, capture the
// plan as a reusable "skill recipe" with an embedding, so future similar goals can
// prime the reasoner with a proven step sequence.

const { query } = require('../../database');
const { generateEmbedding } = require('./MemoryService');

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

    const embedding = await generateEmbedding(goal);
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
 * Falls back to recency ordering when no embedding is available.
 */
async function findRelevant({ goal, agentId, limit = 2 } = {}) {
  if (!goal) return [];
  try {
    const embedding = await generateEmbedding(goal);
    if (embedding) {
      const vectorStr = `[${embedding.join(',')}]`;
      const args = [vectorStr];
      let where = 'WHERE embedding IS NOT NULL';
      if (agentId) { args.push(agentId); where += ` AND (agent_id = $${args.length} OR agent_id IS NULL)`; }
      args.push(limit);
      const res = await query(`
        SELECT recipe_id, title, goal_pattern, steps, times_reused,
               (embedding <=> $1::vector) AS distance
        FROM skill_recipes
        ${where}
        ORDER BY embedding <=> $1::vector
        LIMIT $${args.length}
      `, args);
      // Filter overly-distant matches; pgvector cosine distance in [0,2], keep < 0.6 as "similar"
      return res.rows.filter(r => r.distance === null || r.distance < 0.6);
    }

    // Fallback: latest per agent
    const args = [];
    let where = '';
    if (agentId) { args.push(agentId); where = `WHERE agent_id = $${args.length} OR agent_id IS NULL`; }
    args.push(limit);
    const res = await query(`
      SELECT recipe_id, title, goal_pattern, steps, times_reused, NULL::real AS distance
      FROM skill_recipes ${where}
      ORDER BY created_at DESC LIMIT $${args.length}
    `, args);
    return res.rows;
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
