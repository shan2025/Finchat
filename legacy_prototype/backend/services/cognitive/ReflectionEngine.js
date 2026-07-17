// services/cognitive/ReflectionEngine.js — Async best-effort learning after execution completes (Decision #6)
const { runInference } = require('../inference');
const { query } = require('../../database');
const { eventBus } = require('./EventBus');
const memoryService = require('./MemoryService');

const REFLECTION_PROMPT = `You are a reflection specialist. After an AI agent completes a task, analyze the execution and extract learnings.

You MUST respond with valid JSON matching this shape:
{
  "summary": "<1-2 sentence summary of what happened>",
  "learnings": [
    "<concrete learning or improvement insight>",
    "<another learning>"
  ]
}

Keep learnings actionable and specific. 2-4 learnings maximum.
Respond with ONLY the JSON object. No markdown, no code fences.`;

/**
 * Reflect on a completed execution: summarize goal + result, extract learnings,
 * store in the reflections table. Called unawaited per Decision #6.
 * 
 * Sprint 3 additions:
 * - Auto-embeds reflection into knowledge_embeddings (pgvector) for semantic retrieval
 * - Distills procedural workflows into memories table for agent habit learning
 *
 * @param {object} execution - The completed execution row from PostgreSQL
 */
async function reflect(execution) {
  const reflectStart = Date.now();

  try {
    const messages = [
      { role: 'system', content: REFLECTION_PROMPT },
      {
        role: 'user',
        content: `GOAL: "${execution.goal}"\nAGENT: ${execution.assigned_agent || 'plato'}\nRESULT: "${execution.result || 'No result'}"\nCOMPLETION REASON: ${execution.completion_reason || 'natural'}\nITERATIONS USED: ${execution.iterations_used}/${execution.max_iterations}\nTOOL CALLS USED: ${execution.tool_calls_used}/${execution.max_tool_calls}`
      }
    ];

    const result = await runInference({
      messages,
      temperature: 0.3,
      jsonMode: true
    });

    let reflectionData;
    try {
      let cleaned = result.content.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      }
      reflectionData = JSON.parse(cleaned);
    } catch {
      reflectionData = {
        summary: `Completed goal: "${execution.goal}" with ${execution.completion_reason || 'natural'} completion.`,
        learnings: ['Reflection parsing failed — raw output stored for review.']
      };
    }

    // Store in reflections table
    const reflectionId = `ref_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    await query(`
      INSERT INTO reflections (reflection_id, execution_id, summary, learnings)
      VALUES ($1, $2, $3, $4)
    `, [
      reflectionId,
      execution.execution_id,
      reflectionData.summary || 'No summary',
      JSON.stringify(reflectionData.learnings || [])
    ]);

    // ─── Sprint 3: Auto-Embed into pgvector Knowledge Base ───
    try {
      const embeddingContent = `${reflectionData.summary || ''} | Insights: ${(reflectionData.learnings || []).join('; ')}`;
      await memoryService.storeWithEmbedding({
        title: `Execution Summary: ${(execution.goal || '').substring(0, 100)}`,
        content: embeddingContent,
        source: 'reflection_engine'
      });
    } catch (embedErr) {
      console.warn(`⚠️ ReflectionEngine: Auto-embedding failed: ${embedErr.message}`);
    }

    // ─── Sprint 3: Distill Procedural Workflows into Agent Memory ───
    try {
      const hasLearnings = reflectionData.learnings && reflectionData.learnings.length > 0;
      const hasPlan = execution.current_plan;

      if (hasLearnings || hasPlan) {
        const agentId = execution.assigned_agent || 'global';
        const proceduralContent = `[Procedural Learning for ${agentId}]: ${reflectionData.summary || ''} -> Actionable steps: ${(reflectionData.learnings || []).join(' | ')}`;

        await memoryService.store({
          userId: execution.user_id || agentId,
          memoryType: 'procedural',
          content: proceduralContent,
          metadata: {
            agentId,
            executionId: execution.execution_id,
            plan: hasPlan ? (typeof hasPlan === 'string' ? hasPlan : JSON.stringify(hasPlan)) : null,
            learnings: reflectionData.learnings
          },
          importance: 7
        });
      }
    } catch (procErr) {
      console.warn(`⚠️ ReflectionEngine: Procedural distillation failed: ${procErr.message}`);
    }

    // ─── Sprint 5C: Entity graph enrichment (best-effort) ───
    try {
      const entityGraph = require('./EntityGraph');
      const ids = await entityGraph.ingestExecution(execution);
      if (ids.length > 0) {
        eventBus.emit('graph:entities_ingested', {
          executionId: execution.execution_id,
          count: ids.length,
          timestamp: new Date().toISOString()
        });
      }
    } catch (graphErr) {
      console.warn(`⚠️ ReflectionEngine: Entity graph enrichment failed: ${graphErr.message}`);
    }

    // ─── Sprint 5C: Skill-recipe capture from natural-completion multi-step plans ───
    try {
      const skillRecipes = require('./SkillRecipes');
      const recorded = await skillRecipes.recordFromExecution(execution);
      if (recorded && recorded.recipeId) {
        eventBus.emit('recipe:recorded', {
          recipeId: recorded.recipeId,
          executionId: execution.execution_id,
          timestamp: new Date().toISOString()
        });
      }
    } catch (recipeErr) {
      console.warn(`⚠️ ReflectionEngine: Recipe capture failed: ${recipeErr.message}`);
    }

    const durationMs = Date.now() - reflectStart;

    // Emit reflection:completed event
    eventBus.emit('reflection:completed', {
      executionId: execution.execution_id,
      reflectionId,
      durationMs,
      timestamp: new Date().toISOString()
    });

    return { reflectionId, summary: reflectionData.summary, learnings: reflectionData.learnings, durationMs };

  } catch (err) {
    // Best-effort: log warning but never crash the system
    console.warn(`⚠️ ReflectionEngine: Reflection failed for ${execution.execution_id}: ${err.message}`);
    return null;
  }
}

module.exports = { reflect };

