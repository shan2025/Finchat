// services/cognitive/CognitiveCore.js — Orchestrates the full cognitive loop: Context -> Reason -> Plan -> Tool -> Reflect
const { buildContext } = require('./ContextBuilder');
const { reason } = require('./ReasoningEngine');
const { executeTool } = require('./ToolManager');
const { plan: generatePlan } = require('./PlanningEngine');
const { retrieveEnrichedContext, appendToScratchpad } = require('./MemoryService');
const { reflect } = require('./ReflectionEngine');
const { eventBus } = require('./EventBus');
const { runWithStallClock, stalledMs } = require('./StallClock');
const { createExecution, updateState, completeExecution, failExecution, checkBudget, incrementUsage, evaluateBudget } = require('./ExecutionManager');
const { STATES, WAIT_REASONS } = require('./StateMachine');
const brainStream = require('./BrainStream');
const { query } = require('../../database');

// Community sources whose facts must be treated as unverified opinion.
const UNVERIFIED_TOOLS = new Set(['reddit', 'quora']);

// Shown when the loop stopped on its own ceiling having produced no prose at
// all. The old wording — "Budget exceeded. Here is my best response given the
// constraints." — promised a response that by definition is not there: this
// string is only ever used when the model wrote nothing. It read to users as
// the system being out of credit, which sent every report of it toward the
// provider quota rather than toward the ceiling that actually stopped the run.
//
// Say what happened, and say what the user can do about it. "think hard" is a
// real escape hatch — see the dynamicBudget keywords in services/aiChat.js.
const BUDGET_EXHAUSTED_MESSAGE =
  'I hit my per-answer limit for this one before I could finish writing it. ' +
  'Ask me again and I\'ll pick up where I left off — or start your message with ' +
  '"think hard" to give me a bigger budget for a heavier question.';

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
// Public entry: every run gets its own stall ledger, so provider backoff time is
// discounted from the runtime ceiling rather than charged to the goal.
async function run(args) {
  return runWithStallClock(() => _runWithinStallClock(args));
}

async function _runWithinStallClock({
  goal,
  userId = 'system',
  conversationId = null,
  agentName = 'plato',
  // Which provider pool this run should draw on. Scheduled research and
  // interactive chat are routed differently so they cannot starve each other —
  // see WORKLOAD_ROUTES in services/inference.js.
  workload = 'chat',
  conversationHistory = [],
  allowWeb = true,
  studyMode = false,
  approvedTools = [],
  // When set, this run is one lane of a multi-agent race — the id is forwarded
  // on the live start pulse so the Brain Model groups the parallel runs onto one
  // map. Purely a telemetry tag; it changes nothing about how the loop executes.
  raceId = null,
  // Why Plato selected this agent (capability vs history blend). Stored in the
  // execution metadata so the Brain Model can explain the routing decision.
  routing = null,
  budget = {} // optional overrides: { maxIterations, maxToolCalls, maxTokens, maxRuntimeSeconds }
}) {
  // Load this agent's runtime tuning (risk + traits + optional per-agent model
  // and budget) once, BEFORE the execution row is created — the budget it may
  // carry has to be in hand at createExecution time or it cannot apply.
  // risk → LLM temperature; traits → style directive; model → which Groq model
  // to use; budget → this agent's ceilings.
  let agentTraits = null;
  let agentTemperature = 0.7;
  let agentModel = null;
  let agentBudget = {};
  // This agent's tool domain, so the prompt advertises the tools it is actually
  // for rather than all 18. Read from the same config load, not a second query.
  let agentTools = null;
  try {
    const { getAgentConfig } = require('../agents/AgentRegistry');
    const cfg = await getAgentConfig(agentName);
    if (cfg && Array.isArray(cfg.tools) && cfg.tools.length > 0) agentTools = cfg.tools;
    if (cfg && cfg.runtimeSettings) {
      agentTraits = cfg.runtimeSettings;
      const RISK_TEMP = { Low: 0.3, Medium: 0.7, High: 1.0 };
      if (RISK_TEMP[agentTraits.risk] != null) agentTemperature = RISK_TEMP[agentTraits.risk];
      if (typeof agentTraits.model === 'string' && agentTraits.model.trim()) agentModel = agentTraits.model.trim();
      if (agentTraits.budget && typeof agentTraits.budget === 'object') agentBudget = agentTraits.budget;
    }
  } catch (cfgErr) {
    console.warn(`⚠️ CognitiveCore: could not load runtime settings for ${agentName}: ${cfgErr.message}`);
  }

  // 1. Create execution record.
  // Overrides are applied on "is it a number", not on truthiness: a caller that
  // asks for 0 of something means 0, and silently swapping that for the default
  // is how a deliberately tight budget turns into a generous one.
  const override = (v) => Number.isFinite(Number(v)) && Number(v) >= 0;

  // Precedence: what the CALLER asked for beats what the AGENT is configured
  // for, which beats the framework default.
  //
  // The caller keeps winning because the callers that set a budget set it for a
  // reason they know and the agent config does not — briefing.js sizes 40k for a
  // multi-tool research run, MissionScheduler passes the mission's own
  // max_tokens_per_run. Slotting the agent config underneath them changes
  // nothing for those paths.
  //
  // What it DOES change is the path with no caller budget at all: interactive
  // chat. Every specialist ran on the bare framework default there, because
  // nothing in the chat path had ever set one — which is the whole reason Rasha
  // and Aurelius were capped at 5,000 while Plato and Nova got 15k-40k from
  // their callers. An agent can now carry its own working budget.
  const effectiveBudget = {
    maxIterations: override(budget.maxIterations) ? budget.maxIterations : agentBudget.maxIterations,
    maxToolCalls: override(budget.maxToolCalls) ? budget.maxToolCalls : agentBudget.maxToolCalls,
    maxTokens: override(budget.maxTokens) ? budget.maxTokens : agentBudget.maxTokens,
    maxRuntimeSeconds: override(budget.maxRuntimeSeconds) ? budget.maxRuntimeSeconds : agentBudget.maxRuntimeSeconds
  };

  const execution = await createExecution({
    userId,
    conversationId,
    goal,
    assignedAgent: agentName,
    ...(override(effectiveBudget.maxIterations) ? { maxIterations: Number(effectiveBudget.maxIterations) } : {}),
    ...(override(effectiveBudget.maxToolCalls) ? { maxToolCalls: Number(effectiveBudget.maxToolCalls) } : {}),
    ...(override(effectiveBudget.maxTokens) ? { maxTokens: Number(effectiveBudget.maxTokens) } : {}),
    ...(override(effectiveBudget.maxRuntimeSeconds) ? { maxRuntimeSeconds: Number(effectiveBudget.maxRuntimeSeconds) } : {})
  });
  const execId = execution.execution_id;
  // Live telemetry clock — atMs on every pulse is measured from here so the
  // Brain Model can lay the route out on one timeline without parsing timestamps.
  const t0 = Date.now();
  let liveTokens = 0; // last-known cumulative token spend, carried onto tool pulses
  brainStream.start({
    executionId: execId, userId, question: goal, agentId: agentName, raceId,
    fuelCap: Math.round((Number(execution.max_tokens) || 15000) / 1000), createdAt: execution.created_at
  });
  // Stamp race membership + the routing breakdown onto the row (existing metrics
  // jsonb — no schema change). raceId lets the leaderboard group races; routing
  // lets the Brain Model explain why Plato chose this agent.
  const metaPatch = {};
  if (raceId) metaPatch.raceId = raceId;
  if (routing) metaPatch.routing = routing;
  if (Object.keys(metaPatch).length) {
    query(
      `UPDATE executions SET metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb WHERE execution_id = $2`,
      [JSON.stringify(metaPatch), execId]
    ).catch(() => { /* best-effort; the run must not fail on a telemetry write */ });
  }
  const toolContext = { userId, agentName, conversationId };
  let pendingApproval = null; // set when a requires_approval tool was attempted
  let hasPlanned = false;     // one plan per execution (re-plan loop guard)

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

    // Write-reserve state. `forceSynthesis` is set when research stopped early
    // (mid-plan budget breach) and the run still owes the user a report;
    // `synthesisDone` makes that funded pass strictly one-shot, so the reserve
    // cannot become an open-ended second budget.
    let forceSynthesis = false;
    let synthesisDone = false;
    let missingSources = [];
    // Largest single reasoning turn this run has paid for. The write reserve is
    // sized from it, because the synthesis turn carries every accumulated tool
    // result in its context and so costs at least as much as the priciest turn
    // so far — a flat percentage of a small ceiling (15% of 15000 = 2250) did
    // not come close, and the "funded" wrap-up blew the budget writing itself.
    let maxTurnTokens = 0;

    // Sprint X Stage 2 — explainability: which memories/graph nodes fed this answer
    const traceConcepts = new Map();
    let traceMemories = 0, traceRecipes = 0;


    // 3. Reasoning loop — now supports tool cycling.
    //
    // The bound follows the row's ceiling instead of being a parallel constant.
    // A hardcoded 8 equalled the default ceiling, which is the only reason the
    // off-by-one below never showed up in stored rows: the constant clipped the
    // extra turn before it could be written. Any budget tighter than 8 got the
    // overshoot for real.
    //
    // The 8 survives as an explicit upper safety net rather than the bound
    // itself. Budgets configured above it — aiChat's 12/15/20, the briefing's 14 —
    // have never actually been reachable, so letting them through here would
    // raise real LLM spend as a side effect of a containment fix. That is a
    // deliberate decision to take separately, not to smuggle in.
    const LOOP_SAFETY_NET = 8;
    const rowCeiling = Number(execution.max_iterations);
    const iterationCeiling = Math.min(
      Number.isFinite(rowCeiling) ? Math.max(0, rowCeiling) : LOOP_SAFETY_NET,
      LOOP_SAFETY_NET
    );

    for (let i = 0; i < iterationCeiling; i++) {
      // 3a. Budget check BEFORE anything is spent on this turn — and, crucially,
      // the decision to stop is taken here rather than after the LLM call. The
      // old ordering read the budget, spent a full reasoning turn, incremented,
      // and only then acted on the by-then-stale verdict: the turn that first
      // saw the breach was itself charged to the budget it had already broken.
      // That is the token overshoot visible across the live rows.
      const verdict = await checkBudget(execId, Date.now() - stalledMs());

      // Iterations are the loop's own currency: once they are gone there is no
      // turn left to spend, not even a wrap-up one. (The loop bound above
      // normally gets here first; this is the invariant, stated where it is
      // enforced, and it also covers a row whose counters moved underneath us.)
      if (verdict.details.iterations.breached) {
        finalResponse = 'Iteration budget exhausted before a response could be produced.';
        completionReason = 'budget_exceeded';
        break;
      }

      stepNumber++;

      // Tokens and tool calls used to reach `lastTurn` only through
      // verdict.breached — i.e. once the ceiling was already crossed, with
      // nothing left to pay for the wrap-up. A research mission therefore
      // gathered five sources and then died holding them: "Monitor the stock
      // market" spent 37166/40000 tokens on tools and never wrote a word of the
      // brief. Reserve a slice of the budget for the synthesis pass and enter it
      // BEFORE the ceiling, so the write is funded rather than cut off.
      const tokenCeiling = Number(verdict.details.tokens.max) || 0;
      const writeReserve = Math.max(4000, maxTurnTokens, Math.round(tokenCeiling * 0.15));
      const tokensLeft = tokenCeiling - Number(verdict.details.tokens.used || 0);
      const reserveEntered = tokenCeiling > 0 && tokensLeft <= writeReserve;
      const toolCallsSpent = verdict.details.toolCalls.used >= verdict.details.toolCalls.max;

      // This is the last turn the budget allows — either a non-iteration ceiling
      // has already breached, or spending this iteration exhausts the iteration
      // ceiling. Either way the model gets the restricted respond-only schema
      // and the loop stops afterwards, so the wrap-up turn now happens INSIDE
      // the budget instead of one turn past it.
      const lastTurn = verdict.breached || forceSynthesis || reserveEntered || toolCallsSpent ||
        verdict.details.iterations.used + 1 >= verdict.details.iterations.max;

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
      if ((enriched.graphContext || []).length) {
        brainStream.knowledge({
          executionId: execId, userId, atMs: Date.now() - t0,
          entities: (enriched.graphContext || []).map(g => ({ entityId: g.entity_id, name: g.name, type: g.type }))
        });
      }

      // 3c. Build context (includes memories + tool results + graph + recipes)
      const ctxStats = {};
      const messages = buildContext({
        goal,
        agentName,
        conversationHistory,
        toolResults: accumulatedToolResults,
        memories: enriched.memories,
        graphContext: enriched.graphContext,
        recipeHints: enriched.recipeHints,
        budgetExceeded: lastTurn,
        missingSources,
        traits: agentTraits,
        userPreferences,
        allowWeb,
        studyMode,
        agentTools,
        stats: ctxStats
      });

      // 3c. Run reasoning turn (temperature comes from the agent's risk setting;
      //     optional per-agent model override lets specialists pick their own Groq model)
      const thinkStart = new Date();
      // userId/agentName ride along purely as attribution for inference_metrics:
      // the Knowledge Center reports tokens and latency PER USER, and an
      // unattributed row is invisible to the person who actually paid for it.
      const result = await reason({
        messages, temperature: agentTemperature, model: agentModel, workload,
        userId, agentId: agentName
      });
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
        budgetBreached: verdict.breached,
        lastTurn
      }, thinkStart);
      logs.push(logEntry);

      // 3e. Increment iteration usage + real LLM token burn from this reasoning
      // turn. The write returns the updated row, so the post-spend verdict costs
      // no extra round-trip — and it is the only verdict that reflects what this
      // turn actually cost. Tokens can only be counted after the call, so a
      // single turn may still land above the token ceiling; what is enforced is
      // that no further turn is started once it has.
      const usage = await incrementUsage(execId, {
        iterations: 1,
        tokens: result.tokens || 0,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        // Accumulates across turns for the same reason the token counters do:
        // the saving is per-turn and the loop runs several. This is the KPI for
        // context work — see migration 032.
        contextCharsSaved: ctxStats.charsSaved || 0
      });
      const spent = evaluateBudget(usage);
      maxTurnTokens = Math.max(maxTurnTokens, Number(result.tokens) || 0);
      liveTokens = Number(usage.tokens_used) || liveTokens;
      brainStream.step({ executionId: execId, userId, reason: result.action.thought, atMs: Date.now() - t0, tokensUsed: liveTokens });

      // This turn ran on the reserve, so the run has now had its one funded
      // chance to write. Anything after this falls through to the ordinary
      // breach handling below.
      if (lastTurn) { synthesisDone = true; forceSynthesis = false; }

      // 3f. Handle action
      // A wrap-up turn that actually WROTE the report is a success, even though
      // writing it spent the last of the budget — that is precisely what the
      // reserve above exists to buy. The old ordering read the breach first, so
      // every reserve-funded synthesis was still stamped 'budget_exceeded',
      // MissionScheduler discarded the finished report as a failed run, and the
      // user got "Mission didn't complete" while the brief itself sat unread in
      // the execution. The breach now only decides the reason when the turn left
      // us with nothing to deliver.
      if (verdict.breached || spent.breached) {
        const written = withStudyBlocks(result.action);
        finalResponse = written || BUDGET_EXHAUSTED_MESSAGE;
        completionReason = (written && !result.fallback) ? 'natural' : 'budget_exceeded';
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
          userId,
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

      // Nothing left to start new work with: this was the final permitted
      // iteration and the model chose to keep going anyway. Take whatever prose
      // it produced rather than launching a plan or a tool call we cannot pay
      // for — and rather than falling out of the loop with no response at all.
      if (lastTurn) {
        finalResponse = withStudyBlocks(result.action) || BUDGET_EXHAUSTED_MESSAGE;
        completionReason = 'budget_exceeded';
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
        // agentName is the persona key, which doubles as the permission agent_id.
      // Passing it scopes the planner's tool list to what this agent may
      // actually run, so it stops planning steps that can only fail.
      const planResult = await generatePlan({ executionId: execId, goal, agentId: agentName, workload, userId });

        await logPhase(execId, 'planning', stepNumber, {
          plan: planResult.plan,
          stored: planResult.stored
        }, planStart);

        // Now execute each plan step sequentially
        for (const step of planResult.plan.steps) {
          stepNumber++;

          // Re-check budget before each plan step. Running out here used to end
          // the whole run on a placeholder string, throwing away every result
          // already gathered — the mission had the data and still delivered
          // "Budget exceeded during plan execution." as the day's brief. Stop
          // researching, but hand what we have to the synthesis pass; only a run
          // that gathered nothing at all has no report to write.
          const stepBudget = await checkBudget(execId, Date.now() - stalledMs());
          if (stepBudget.breached) {
            if (accumulatedToolResults.length && !synthesisDone) {
              missingSources = planResult.plan.steps
                .filter(s => s.action === 'tool' && s.tool)
                .map(s => s.tool)
                .filter(t => !accumulatedToolResults.some(tr => tr.tool === t));
              forceSynthesis = true;
            } else {
              finalResponse = 'Budget exceeded during plan execution. Partial results may be available.';
              completionReason = 'budget_exceeded';
            }
            break;
          }

          if (step.action === 'tool' && step.tool) {
            // Execute the tool from the plan
            await updateState(execId, STATES.WAITING, { waitReason: WAIT_REASONS.TOOL_RESPONSE });
            const toolStart = new Date();
            brainStream.toolStart({ executionId: execId, userId, tool: step.tool, input: step.input || goal, atMs: Date.now() - t0 });
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
              brainStream.toolEnd({
                executionId: execId, userId, tool: step.tool, input: step.input || goal,
                error: toolOut.output && toolOut.output.error, durationMs: toolOut.durationMs,
                atMs: Date.now() - t0, tokensUsed: liveTokens
              });
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
              brainStream.toolEnd({ executionId: execId, userId, tool: step.tool, input: step.input || goal, error: toolErr.message, atMs: Date.now() - t0, tokensUsed: liveTokens });
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
        brainStream.toolStart({ executionId: execId, userId, tool: toolName, input: toolInput, atMs: Date.now() - t0 });

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
          brainStream.toolEnd({
            executionId: execId, userId, tool: toolName, input: toolInput,
            error: toolOutput.output && toolOutput.output.error, durationMs: toolOutput.durationMs,
            atMs: Date.now() - t0, tokensUsed: liveTokens
          });

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
          brainStream.toolEnd({ executionId: execId, userId, tool: toolName, input: toolInput, error: toolErr.message, atMs: Date.now() - t0, tokensUsed: liveTokens });

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
    brainStream.done({
      executionId: execId, userId, completionReason,
      tokensUsed: (completed && completed.tokens_used) || liveTokens, atMs: Date.now() - t0
    });

    // Record the timestamp the user-visible response is ready
    const responseReadyAt = new Date().toISOString();

    // Emit execution:completed event. userId is required for the socket bridge
    // in server.js to route this pulse to the owning user instead of dropping it.
    eventBus.emit('execution:completed', {
      executionId: execId,
      userId,
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
    brainStream.error({ executionId: execId, userId, message: err.message, atMs: Date.now() - t0 });
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

  // A resumption must not be handed a brand-new budget. run() mints a fresh
  // execution row, so without carrying the remainder the ceiling launders across
  // executions: park at 7/8 iterations, get approved, and the continuation
  // starts again at 0/8. Neither row ever reads as over budget while the work as
  // a whole quietly runs to twice its ceiling.
  //
  // Runtime is deliberately NOT carried. It is wall-clock from created_at, and
  // an execution parked on a human approval can sit for hours without spending
  // any compute; charging that to the resumption would make every approval
  // impossible to resume. The countable ceilings do carry.
  const remainingBudget = {
    maxIterations: execution.max_iterations - execution.iterations_used,
    maxToolCalls: execution.max_tool_calls - execution.tool_calls_used,
    maxTokens: execution.max_tokens - execution.tokens_used
  };
  const exhausted = Object.entries(remainingBudget)
    .filter(([, left]) => !(left > 0))
    .map(([name]) => name);

  if (exhausted.length > 0) {
    // Checked before the waiting -> running transition so a refused resumption
    // does not strand the row in 'running' for the stale sweeper to find. Parked
    // rows terminate as CANCELLED (waiting -> completed is not a legal
    // transition), the same way POST /api/executions/:id/reject retires one.
    await updateState(executionId, STATES.CANCELLED, {
      completionReason: 'budget_exceeded',
      result: `Cannot resume: budget already exhausted (${exhausted.join(', ')})`
    });
    throw new Error(`Execution ${executionId} cannot be resumed: its budget is exhausted (${exhausted.join(', ')})`);
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
  // under what is left of the original execution's budget.
  const result = await run({
    goal: `${execution.goal} (Resumed: ${resumptionMessage})`,
    userId: execution.user_id || userId,
    conversationId: execution.session_id,
    agentName: execution.assigned_agent || 'plato',
    approvedTools,
    budget: remainingBudget
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
