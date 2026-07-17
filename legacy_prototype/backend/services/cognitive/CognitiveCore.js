// services/cognitive/CognitiveCore.js — Orchestrates the full cognitive loop: Context -> Reason -> Plan -> Tool -> Reflect
const { buildContext } = require('./ContextBuilder');
const { reason } = require('./ReasoningEngine');
const { executeTool } = require('./ToolManager');
const { plan: generatePlan } = require('./PlanningEngine');
const { retrieveEnrichedContext, appendToScratchpad } = require('./MemoryService');
const { reflect } = require('./ReflectionEngine');
const { eventBus } = require('./EventBus');
const { createExecution, updateState, completeExecution, failExecution, checkBudget, incrementUsage } = require('./ExecutionManager');
const { STATES, WAIT_REASONS } = require('./StateMachine');
const { query } = require('../../database');

/**
 * Log a cognitive phase (thinking, planning, using_tool, reflecting) to execution_logs.
 */
async function logPhase(executionId, phase, stepNumber, content, startedAt) {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();

  await query(`
    INSERT INTO execution_logs (execution_id, phase, step_number, content, started_at, ended_at, duration_ms)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [executionId, phase, stepNumber, JSON.stringify(content), startedAt, endedAt, durationMs]);

  return { phase, stepNumber, durationMs };
}

/**
 * Run one full cognitive cycle for a goal.
 * Phase 4: supports thinking -> tool use -> thinking -> respond loop.
 *
 * @param {object} options
 * @param {string} options.goal - The user's message / goal
 * @param {string} [options.userId] - User ID
 * @param {string} [options.conversationId] - Conversation session ID
 * @param {string} [options.agentName] - Persona key (default: 'plato')
 * @param {Array}  [options.conversationHistory] - Prior messages [{role, content}]
 * @returns {Promise<{ executionId, response, execution, logs }>}
 */
async function run({
  goal,
  userId = 'system',
  conversationId = null,
  agentName = 'plato',
  conversationHistory = []
}) {
  // 1. Create execution record
  const execution = await createExecution({
    userId,
    conversationId,
    goal,
    assignedAgent: agentName
  });
  const execId = execution.execution_id;

  // Load this agent's runtime tuning (risk + traits + optional per-agent model) once.
  // risk → LLM temperature; traits → style directive; model → which Groq model to use.
  let agentTraits = null;
  let agentTemperature = 0.7;
  let agentModel = null;
  try {
    const { getAgentConfig } = require('../agents/AgentRegistry');
    const cfg = await getAgentConfig(agentName);
    if (cfg && cfg.runtimeSettings) {
      agentTraits = cfg.runtimeSettings;
      const RISK_TEMP = { Low: 0.3, Medium: 0.7, High: 1.0 };
      if (RISK_TEMP[agentTraits.risk] != null) agentTemperature = RISK_TEMP[agentTraits.risk];
      if (typeof agentTraits.model === 'string' && agentTraits.model.trim()) agentModel = agentTraits.model.trim();
    }
  } catch (cfgErr) {
    console.warn(`⚠️ CognitiveCore: could not load runtime settings for ${agentName}: ${cfgErr.message}`);
  }

  try {
    // 2. Transition created -> ready -> running
    await updateState(execId, STATES.READY);
    await updateState(execId, STATES.RUNNING);

    let stepNumber = 0;
    let finalResponse = null;
    let completionReason = 'natural';
    const logs = [];
    const accumulatedToolResults = []; // Carry tool results across loop iterations

    // 3. Reasoning loop — now supports tool cycling
    const MAX_LOOP = 8; // Safety net
    for (let i = 0; i < MAX_LOOP; i++) {
      stepNumber++;

      // 3a. Check budget before every reasoning call
      const budget = await checkBudget(execId);

      // 3b. Retrieve memories + graph-hop entities + skill recipes for context (Phase 6 + Sprint 5C)
      const enriched = await retrieveEnrichedContext({
        userId,
        conversationId,
        goal,
        agentName,
        limit: 5
      });

      // 3c. Build context (includes memories + tool results + graph + recipes)
      const messages = buildContext({
        goal,
        agentName,
        conversationHistory,
        toolResults: accumulatedToolResults,
        memories: enriched.memories,
        graphContext: enriched.graphContext,
        recipeHints: enriched.recipeHints,
        budgetExceeded: budget.breached,
        traits: agentTraits
      });

      // 3c. Run reasoning turn (temperature comes from the agent's risk setting;
      //     optional per-agent model override lets specialists pick their own Groq model)
      const thinkStart = new Date();
      const result = await reason({ messages, temperature: agentTemperature, model: agentModel });

      // 3d. Log the thinking phase
      const logEntry = await logPhase(execId, 'thinking', stepNumber, {
        thought: result.action.thought,
        action: result.action.action,
        provider: result.provider,
        model: result.model,
        retried: result.retried,
        fallback: result.fallback,
        budgetBreached: budget.breached
      }, thinkStart);
      logs.push(logEntry);

      // 3e. Increment iteration usage + real LLM token burn from this reasoning turn
      await incrementUsage(execId, { iterations: 1, tokens: result.tokens || 0 });

      // 3f. Handle action
      if (budget.breached) {
        finalResponse = result.action.response || 'Budget exceeded. Here is my best response given the constraints.';
        completionReason = 'budget_exceeded';
        break;
      }

      if (result.action.action === 'wait') {
        const waitReason = result.action.reason || 'human_approval';
        const waitMessage = result.action.message || result.action.thought || 'Waiting for human confirmation.';
        await updateState(execId, STATES.WAITING, { waitReason, waitMessage });
        await logPhase(execId, 'waiting', stepNumber, {
          reason: waitReason,
          message: waitMessage,
          thought: result.action.thought
        }, thinkStart);

        eventBus.emit('execution:waiting', {
          executionId: execId,
          reason: waitReason,
          message: waitMessage,
          timestamp: new Date().toISOString()
        });

        return {
          executionId: execId,
          status: 'waiting',
          waitReason,
          response: `[WAITING] ${waitMessage}`,
          cleanResponse: waitMessage,
          logs
        };
      }

      if (result.action.action === 'respond') {
        finalResponse = result.action.response;
        completionReason = result.fallback ? 'error' : 'natural';
        break;
      }

      if (result.action.action === 'plan') {
        // --- PHASE 5: Generate a structured plan ---
        const planStart = new Date();
        const planResult = await generatePlan({ executionId: execId, goal });

        await logPhase(execId, 'planning', stepNumber, {
          plan: planResult.plan,
          stored: planResult.stored
        }, planStart);

        // Now execute each plan step sequentially
        for (const step of planResult.plan.steps) {
          stepNumber++;

          // Re-check budget before each plan step
          const stepBudget = await checkBudget(execId);
          if (stepBudget.breached) {
            finalResponse = 'Budget exceeded during plan execution. Partial results may be available.';
            completionReason = 'budget_exceeded';
            break;
          }

          if (step.action === 'tool' && step.tool) {
            // Execute the tool from the plan
            await updateState(execId, STATES.WAITING, { waitReason: WAIT_REASONS.TOOL_RESPONSE });
            const toolStart = new Date();
            try {
              const toolOut = await executeTool({
                executionId: execId,
                agentId: execution.assigned_agent || 'system',
                toolName: step.tool,
                input: step.input || goal
              });
              await incrementUsage(execId, { toolCalls: 1 });
              await logPhase(execId, 'using_tool', stepNumber, {
                tool: step.tool,
                input: step.input,
                output: toolOut.output,
                cached: toolOut.cached,
                planStep: step.step
              }, toolStart);
              accumulatedToolResults.push({ tool: step.tool, input: step.input, result: toolOut.output });
            } catch (toolErr) {
              await logPhase(execId, 'using_tool', stepNumber, {
                tool: step.tool,
                input: step.input,
                error: toolErr.message,
                planStep: step.step
              }, toolStart);
              accumulatedToolResults.push({ tool: step.tool, input: step.input, result: { error: toolErr.message } });
            }
            await updateState(execId, STATES.RUNNING);
          }
        }

        // If we didn't break for budget, do a final reasoning pass with all tool results
        if (!finalResponse) {
          continue; // Loop back — ContextBuilder will now see the accumulated tool results
        }
        break;
      }

      if (result.action.action === 'tool') {
        // --- PHASE 4: Execute the tool ---
        const toolName = result.action.tool;
        const toolInput = result.action.input;

        // Transition to waiting state
        await updateState(execId, STATES.WAITING, { waitReason: WAIT_REASONS.TOOL_RESPONSE });

        // Log the using_tool phase
        const toolStart = new Date();
        let toolOutput;

        try {
          toolOutput = await executeTool({
            executionId: execId,
            agentId: execution.assigned_agent || 'system',
            toolName,
            input: toolInput
          });

          // Increment tool call usage
          await incrementUsage(execId, { toolCalls: 1 });

          // Log tool phase
          await logPhase(execId, 'using_tool', stepNumber, {
            tool: toolName,
            input: toolInput,
            output: toolOutput.output,
            cached: toolOutput.cached,
            durationMs: toolOutput.durationMs,
            callId: toolOutput.callId
          }, toolStart);

          // Accumulate the tool result for the next reasoning iteration
          accumulatedToolResults.push({
            tool: toolName,
            input: toolInput,
            result: toolOutput.output
          });

        } catch (toolErr) {
          console.warn(`⚠️ CognitiveCore: Tool "${toolName}" failed: ${toolErr.message}`);
          
          await logPhase(execId, 'using_tool', stepNumber, {
            tool: toolName,
            input: toolInput,
            error: toolErr.message
          }, toolStart);

          accumulatedToolResults.push({
            tool: toolName,
            input: toolInput,
            result: { error: toolErr.message }
          });
        }

        // Transition back to running for the next reasoning iteration
        await updateState(execId, STATES.RUNNING);
        continue; // Loop back to thinking with tool results in context
      }
    }

    // 4. Complete execution
    if (!finalResponse) {
      finalResponse = 'The reasoning loop ended without producing a response.';
      completionReason = 'error';
    }

    const completed = await completeExecution(execId, {
      result: finalResponse,
      completionReason
    });

    // Record the timestamp the user-visible response is ready
    const responseReadyAt = new Date().toISOString();

    // Emit execution:completed event
    eventBus.emit('execution:completed', {
      executionId: execId,
      completionReason,
      responseReadyAt
    });

    // Fire-and-forget reflection per Decision #6 — NEVER awaited, NEVER blocks the response
    reflect(completed).catch(err =>
      console.warn(`⚠️ ReflectionEngine (fire-and-forget) error: ${err.message}`)
    );

    return {
      executionId: execId,
      response: finalResponse,
      execution: completed,
      logs,
      responseReadyAt
    };

  } catch (err) {
    console.error(`❌ CognitiveCore.run() error for ${execId}:`, err.message);
    try {
      await failExecution(execId, { error: err });
    } catch (failErr) {
      console.error('❌ Failed to record execution failure:', failErr.message);
    }
    throw err;
  }
}

/**
 * Resume a paused cognitive execution from the WAITING state.
 *
 * @param {string} executionId - ID of the execution to resume
 * @param {object} [options={}]
 * @param {string} [options.userId='system']
 * @param {object} [options.modifiedParameters={}]
 * @param {string} [options.resumptionMessage='Approved']
 */
async function resumeExecution(executionId, { userId = 'system', modifiedParameters = {}, resumptionMessage = 'Approved' } = {}) {
  const { query } = require('../../database');
  const { appendToScratchpad } = require('./MemoryService');

  const res = await query('SELECT * FROM executions WHERE execution_id = $1', [executionId]);
  if (res.rows.length === 0) {
    throw new Error(`Execution ${executionId} not found`);
  }
  const execution = res.rows[0];
  if (execution.current_state !== 'waiting') {
    throw new Error(`Execution ${executionId} is not in WAITING state (current state: ${execution.current_state})`);
  }

  await updateState(executionId, STATES.RUNNING);
  await appendToScratchpad(executionId, `Resumed from wait state (${execution.wait_reason || 'human_approval'}): ${resumptionMessage}. Modified params: ${JSON.stringify(modifiedParameters)}`);

  eventBus.emit('execution:resumed', {
    executionId,
    resumptionMessage,
    modifiedParameters,
    timestamp: new Date().toISOString()
  });

  // Re-run cognitive loop with the resumption context
  return await run({
    goal: `${execution.goal} (Resumed: ${resumptionMessage})`,
    userId: execution.user_id || userId,
    conversationId: execution.session_id,
    agentName: execution.assigned_agent || 'plato'
  });
}

module.exports = { run, logPhase, resumeExecution };
