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

// Community sources whose facts must be treated as unverified opinion.
const UNVERIFIED_TOOLS = new Set(['reddit', 'quora']);

/**
 * Walk the accumulated tool results and pull out the citable sources (title + url)
 * the agent actually consulted, so the chat UI can show "where this came from"
 * like Claude's citations. Deduped by URL, capped, community sources flagged.
 *
 * @param {Array<{tool, input, result}>} toolResults
 * @returns {Array<{tool, title, url, verified}>}
 */
function extractSources(toolResults = []) {
  const out = [];
  const seen = new Set();
  const push = (tool, title, url, verified) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ tool, title: String(title || url).slice(0, 200), url, verified });
  };

  for (const tr of toolResults) {
    const r = tr && tr.result;
    if (!r || typeof r !== 'object' || r.error) continue;
    const verified = !UNVERIFIED_TOOLS.has(tr.tool) && r.verified !== false;

    // Single-page tools (fetch) and Wikipedia's top article.
    if (r.url && (r.title || r.text)) push(tr.tool, r.title, r.url, verified);
    if (r.topArticle && r.topArticle.url) push(tr.tool, r.topArticle.title, r.topArticle.url, verified);

    // List-shaped results across search/news/reddit/quora/wikipedia/paper/crawl/jobs.
    const lists = [r.results, r.papers, r.pages].filter(Array.isArray);
    for (const list of lists) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const url = item.url || item.pdfUrl || item.link;
        const title = item.title || item.question || item.name || item.snippet;
        push(tr.tool, title, url, verified);
      }
    }
  }
  return out.slice(0, 10);
}

/**
 * Sprint Z · Study Mode — fold an action's `blocks` array into its response text.
 *
 * The model emits blocks as real JSON objects SIBLING to `response`, so it never
 * has to escape JSON inside a JSON string (the 8B fallback cannot do that
 * reliably — verified with a control run). We serialise them into the
 * `studyblock` fences the frontend already renders, so the stored message, the
 * chat history replay, and study_blocks.js all keep the same contract.
 *
 * Anything unserialisable is skipped rather than thrown: the prose answer must
 * survive even when a block does not.
 */
function withStudyBlocks(action) {
  const response = typeof action?.response === 'string' ? action.response : '';
  const blocks = Array.isArray(action?.blocks) ? action.blocks : [];
  if (blocks.length === 0) return response;

  const fences = [];
  for (const block of blocks) {
    try {
      fences.push('```studyblock\n' + JSON.stringify(block) + '\n```');
    } catch (err) {
      // circular or otherwise unserialisable — drop this block only
    }
  }
  if (fences.length === 0) return response;
  return [response.trim(), fences.join('\n\n')].filter(Boolean).join('\n\n');
}

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
  conversationHistory = [],
  allowWeb = true,
  studyMode = false,
  approvedTools = [],
  budget = {} // optional overrides: { maxIterations, maxToolCalls, maxTokens, maxRuntimeSeconds }
}) {
  // 1. Create execution record
  const execution = await createExecution({
    userId,
    conversationId,
    goal,
    assignedAgent: agentName,
    ...(budget.maxIterations ? { maxIterations: budget.maxIterations } : {}),
    ...(budget.maxToolCalls ? { maxToolCalls: budget.maxToolCalls } : {}),
    ...(budget.maxTokens ? { maxTokens: budget.maxTokens } : {}),
    ...(budget.maxRuntimeSeconds ? { maxRuntimeSeconds: budget.maxRuntimeSeconds } : {})
  });
  const execId = execution.execution_id;
  const toolContext = { userId, agentName, conversationId };
  let pendingApproval = null; // set when a requires_approval tool was attempted
  let hasPlanned = false;     // one plan per execution (re-plan loop guard)

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

  // Standing user preferences ("explain it like I'm a child", "keep it short").
  // Loaded ONCE per execution rather than inside the retrieval bundle: unlike
  // memories and graph hops these are not goal-scoped, they cannot change
  // mid-run, and the reasoning loop below runs up to 8 times — which would
  // otherwise mean 8 identical round-trips to Supabase per chat turn.
  let userPreferences = [];
  try {
    const { getUserPreferences } = require('./MemoryEngine');
    userPreferences = await getUserPreferences(userId);
  } catch (prefErr) {
    console.warn(`⚠️ CognitiveCore: could not load user preferences: ${prefErr.message}`);
  }

  try {
    // 2. Transition created -> ready -> running
    await updateState(execId, STATES.READY);
    await updateState(execId, STATES.RUNNING);

    let stepNumber = 0;
    let finalResponse = null;
    let completionReason = 'natural';
    let lastProvider = null; // which inference backend produced the final answer
    let lastModel = null;    // (groq = cloud primary, ollama = local qwen fallback)
    const logs = [];
    const accumulatedToolResults = []; // Carry tool results across loop iterations

    // Sprint X Stage 2 — explainability: which memories/graph nodes fed this answer
    const traceConcepts = new Map();
    let traceMemories = 0, traceRecipes = 0;

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
      for (const g of enriched.graphContext || []) {
        if (g.entity_id && !traceConcepts.has(g.entity_id)) {
          traceConcepts.set(g.entity_id, { entityId: g.entity_id, name: g.name, type: g.type, viaEdge: g.viaEdge });
        }
      }
      traceMemories = Math.max(traceMemories, (enriched.memories || []).length);
      traceRecipes = Math.max(traceRecipes, (enriched.recipeHints || []).length);

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
        traits: agentTraits,
        userPreferences,
        allowWeb,
        studyMode
      });

      // 3c. Run reasoning turn (temperature comes from the agent's risk setting;
      //     optional per-agent model override lets specialists pick their own Groq model)
      const thinkStart = new Date();
      const result = await reason({ messages, temperature: agentTemperature, model: agentModel });
      lastProvider = result.provider || lastProvider;
      lastModel = result.model || lastModel;

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
        finalResponse = withStudyBlocks(result.action) || 'Budget exceeded. Here is my best response given the constraints.';
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
        finalResponse = withStudyBlocks(result.action);
        completionReason = result.fallback ? 'error' : 'natural';
        break;
      }

      if (result.action.action === 'plan') {
        // Re-plan guard: one plan per execution. Weaker models otherwise loop
        // "plan → plan → plan" and burn the whole budget without doing anything.
        if (hasPlanned) {
          accumulatedToolResults.push({
            tool: 'plan',
            input: goal,
            result: { error: 'BLOCKED: you already generated and executed a plan this run. Its tool results are listed above — synthesize them and use action "respond" NOW.' }
          });
          continue;
        }
        hasPlanned = true;

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
                input: step.input || goal,
                allowWeb,
                approvedTools,
                context: toolContext
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
              if (toolErr.name === 'ApprovalRequiredError') {
                pendingApproval = { tool: toolErr.toolName, input: toolErr.toolInput, planStep: step.step };
              }
              await logPhase(execId, 'using_tool', stepNumber, {
                tool: step.tool,
                input: step.input,
                error: toolErr.message,
                planStep: step.step
              }, toolStart);
              accumulatedToolResults.push({ tool: step.tool, input: step.input, result: { error: toolErr.message } });
            }
            await updateState(execId, STATES.RUNNING);
            if (pendingApproval) break;
          }
        }

        if (pendingApproval) break; // exit to the human-approval handler below

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

        // Loop guard: chat-tuned models sometimes re-call the same tool over and
        // over (burning the whole budget on "watchlist" ×5). A repeat call gets
        // a synthetic nudge instead of a real execution.
        const sameToolCalls = accumulatedToolResults.filter(tr => tr.tool === toolName);
        const normalizedInput = typeof toolInput === 'string' ? toolInput.trim().toLowerCase() : JSON.stringify(toolInput || '');
        const isDuplicate = sameToolCalls.some(tr => {
          const prev = typeof tr.input === 'string' ? tr.input.trim().toLowerCase() : JSON.stringify(tr.input || '');
          return prev === normalizedInput;
        });
        if (isDuplicate || sameToolCalls.length >= 3) {
          accumulatedToolResults.push({
            tool: toolName,
            input: toolInput,
            result: { error: `BLOCKED: you already called "${toolName}" ${sameToolCalls.length}× this run — its result is above and will not change. Use it, call a DIFFERENT tool the goal requires, or respond now.` }
          });
          await logPhase(execId, 'using_tool', stepNumber, {
            tool: toolName, input: toolInput, error: 'duplicate_call_blocked'
          }, new Date());
          continue;
        }

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
            input: toolInput,
            allowWeb,
            approvedTools,
            context: toolContext
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

          if (toolErr.name === 'ApprovalRequiredError') {
            pendingApproval = { tool: toolErr.toolName, input: toolErr.toolInput };
          }

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
        if (pendingApproval) break;
        continue; // Loop back to thinking with tool results in context
      }
    }

    // 3z. Human-in-the-loop: a gated tool was attempted — park this execution in
    // WAITING (human_approval), notify the user, and return a holding response.
    // POST /api/executions/:id/approve re-runs with the tool whitelisted.
    if (pendingApproval) {
      await updateState(execId, STATES.WAITING, { waitReason: WAIT_REASONS.HUMAN_APPROVAL });
      await logPhase(execId, 'waiting', stepNumber, {
        reason: 'human_approval',
        pendingTool: pendingApproval.tool,
        pendingInput: pendingApproval.input
      }, new Date());
      try {
        const { createNotification } = require('../notifications');
        await createNotification({
          userId,
          type: 'approval',
          title: `✋ ${agentName} needs your approval`,
          content: `${agentName} wants to run "${pendingApproval.tool}" for: "${String(goal).slice(0, 120)}". Approve or reject it on the Operations page. [execution:${execId}]`
        });
      } catch (notifErr) {
        console.warn(`⚠️ Could not create approval notification: ${notifErr.message}`);
      }
      const waitingResponse = `I've prepared an action that needs your approval before I proceed: tool "${pendingApproval.tool}". Approve or reject it from your notifications / the Operations page, and I'll continue.`;
      return {
        executionId: execId,
        response: waitingResponse,
        execution: await require('./ExecutionManager').getExecution(execId),
        logs,
        awaitingApproval: { tool: pendingApproval.tool, executionId: execId },
        responseReadyAt: new Date().toISOString()
      };
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
      provider: lastProvider,
      model: lastModel,
      responseReadyAt,
      // Claude-style citations: the web/data sources the agent actually consulted.
      sources: extractSources(accumulatedToolResults),
      memoryTrace: {
        concepts: [...traceConcepts.values()],
        memories: traceMemories,
        recipes: traceRecipes,
        agent: agentName
      }
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
async function resumeExecution(executionId, { userId = 'system', modifiedParameters = {}, resumptionMessage = 'Approved', approvedTools = [] } = {}) {
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

  // Re-run cognitive loop with the resumption context (gated tools whitelisted)
  const result = await run({
    goal: `${execution.goal} (Resumed: ${resumptionMessage})`,
    userId: execution.user_id || userId,
    conversationId: execution.session_id,
    agentName: execution.assigned_agent || 'plato',
    approvedTools
  });

  // Close out the ORIGINAL execution — it was flipped waiting→running above and
  // would otherwise sit in 'running' forever (until the stale sweeper killed it).
  try {
    await completeExecution(executionId, {
      result: `Resumed as ${result.executionId}`,
      completionReason: 'resumed'
    });
  } catch (closeErr) {
    console.warn(`⚠️ Could not close resumed execution ${executionId}: ${closeErr.message}`);
  }

  return result;
}

module.exports = { run, logPhase, resumeExecution, withStudyBlocks };
