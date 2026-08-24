// test/cognitive-core-budget.test.js — the reasoning loop actually stops at its ceiling.
//
// ExecutionManager's arithmetic was already covered (execution-manager.test.js);
// what was not covered is CognitiveCore's *call ordering* around it — where the
// budget is read relative to incrementUsage() and relative to the loop's
// break/continue. That ordering is what let completed runs finish over budget.
//
// Same fake-repository idea as execution-manager.test.js, one level up: the real
// ExecutionManager is bound to an in-memory repository, and CognitiveCore's other
// collaborators (LLM, tools, memory, DB) are swapped out through the require
// cache before it is loaded. No database, no Groq key, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Captured before any stubbing, so the harness always builds from the real thing.
const realExecutionManager = require('../services/cognitive/ExecutionManager');

const CORE_PATH = require.resolve('../services/cognitive/CognitiveCore');
const stubbed = new Set();

function stub(relPath, exports) {
  let filename;
  try {
    filename = require.resolve(relPath);
  } catch {
    return; // optional collaborator (lazily required, may not exist) — nothing to fake
  }
  const m = new Module(filename, null);
  m.filename = filename;
  m.path = path.dirname(filename);
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
  stubbed.add(filename);
}

/**
 * In-memory stand-in for ExecutionRepository, keyed by id so a resumption (which
 * mints a second execution) can be inspected alongside the original.
 */
function fakeRepo(seed = []) {
  const rows = new Map(seed.map(r => [r.execution_id, { ...r }]));
  return {
    rows,
    get: (id) => rows.get(id),
    /** The single row of a plain run — asserts there is exactly one. */
    only() {
      assert.equal(rows.size, 1, `expected one execution, found ${rows.size}`);
      return [...rows.values()][0];
    },
    /** Rows created during the test, oldest first, excluding anything seeded. */
    minted() {
      const seeded = new Set(seed.map(r => r.execution_id));
      return [...rows.values()].filter(r => !seeded.has(r.execution_id));
    },
    async insert(r) {
      const row = {
        execution_id: r.executionId,
        goal: r.goal,
        user_id: r.userId,
        session_id: r.conversationId,
        assigned_agent: r.assignedAgent,
        current_state: r.state,
        max_iterations: r.maxIterations,
        max_tool_calls: r.maxToolCalls,
        max_tokens: r.maxTokens,
        max_runtime_seconds: r.maxRuntimeSeconds,
        iterations_used: 0,
        tool_calls_used: 0,
        tokens_used: 0,
        created_at: new Date().toISOString(),
      };
      rows.set(row.execution_id, row);
      return { ...row };
    },
    async findById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async updateState(id, state, { waitReason = null, completionReason = null, result = null } = {}) {
      const row = rows.get(id);
      if (!row) return null;
      row.current_state = state;
      row.wait_reason = waitReason;
      if (completionReason !== null) row.completion_reason = completionReason;
      if (result !== null) row.result = result;
      return { ...row };
    },
    async incrementUsage(id, { iterations = 0, toolCalls = 0, tokens = 0 } = {}) {
      const row = rows.get(id);
      if (!row) return null;
      row.iterations_used += iterations;
      row.tool_calls_used += toolCalls;
      row.tokens_used += tokens;
      return { ...row };
    },
    async sweepStale() { return []; },
  };
}

const waitingRow = (over = {}) => ({
  execution_id: 'exec_original',
  goal: 'original goal',
  user_id: 'u1',
  session_id: null,
  assigned_agent: 'plato',
  current_state: 'waiting',
  wait_reason: 'human_approval',
  max_iterations: 8, iterations_used: 0,
  max_tool_calls: 5, tool_calls_used: 0,
  max_tokens: 5000, tokens_used: 0,
  max_runtime_seconds: 600,
  created_at: new Date().toISOString(),
  ...over,
});

/**
 * Load CognitiveCore with fake collaborators.
 *
 * @param {Function} reason - fake ReasoningEngine.reason, called with the turn index
 * @param {Array}    [seed] - executions to pre-seed (for resumption tests)
 * @param {object}   [agentConfig] - what AgentRegistry returns; null = an agent
 *                   with no configured budget, which is the framework-default case
 */
function buildCore({ reason, seed = [], planSteps = [], agentConfig = null } = {}) {
  const repo = fakeRepo(seed);
  const calls = { reason: [], buildContext: [], executeTool: [] };

  const mgr = realExecutionManager.createExecutionManager({ repository: repo });
  stub('../services/cognitive/ExecutionManager', {
    ...mgr,
    createExecutionManager: realExecutionManager.createExecutionManager,
    evaluateBudget: realExecutionManager.evaluateBudget,
  });

  stub('../database', {
    // execution_logs inserts go nowhere; executions selects come from the repo,
    // because resumeExecution reads the row through query() rather than the
    // repository.
    async query(sql, params = []) {
      if (/from\s+executions/i.test(sql)) {
        const row = repo.get(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      return { rows: [] };
    },
    getPool() { throw new Error('no pool in tests'); },
    getDB() { throw new Error('no db in tests'); },
  });

  stub('../services/cognitive/ContextBuilder', {
    buildContext(args) {
      calls.buildContext.push(args);
      return [{ role: 'user', content: args.goal }];
    },
  });

  stub('../services/cognitive/ReasoningEngine', {
    async reason(args) {
      const out = await reason(calls.reason.length, args);
      calls.reason.push(out);
      return out;
    },
  });

  stub('../services/cognitive/ToolManager', {
    async executeTool(args) {
      calls.executeTool.push(args);
      return { output: { ok: true }, cached: false, durationMs: 1, callId: `call_${calls.executeTool.length}` };
    },
  });

  stub('../services/cognitive/PlanningEngine', {
    async plan() { return { plan: { steps: planSteps }, stored: false }; },
  });
  stub('../services/cognitive/MemoryService', {
    async retrieveEnrichedContext() { return { memories: [], graphContext: [], recipeHints: [] }; },
    async appendToScratchpad() {},
  });
  stub('../services/cognitive/ReflectionEngine', { async reflect() {} });
  stub('../services/cognitive/EventBus', { eventBus: new EventEmitter() });
  stub('../services/cognitive/MemoryEngine', { async getUserPreferences() { return []; } });
  stub('../services/agents/AgentRegistry', { async getAgentConfig() { return agentConfig; } });

  delete require.cache[CORE_PATH];
  const core = require(CORE_PATH);
  return { core, repo, calls };
}

test.after(() => {
  for (const filename of stubbed) delete require.cache[filename];
  delete require.cache[CORE_PATH];
});

// A model that never volunteers an answer — the worst case the ceiling exists for.
const neverResponds = (tokens = 0) => async (i) => ({
  action: { thought: `turn ${i}`, action: 'think' },
  tokens, provider: 'fake', model: 'fake',
});

const alwaysCallsATool = (tokens = 0) => async (i) => ({
  // Distinct names so the duplicate-call guard is not what stops the loop.
  action: { thought: `turn ${i}`, action: 'tool', tool: `tool_${i}`, input: `query ${i}` },
  tokens, provider: 'fake', model: 'fake',
});

test.describe('the reasoning loop stops at its ceiling', () => {
  test('a budget below the old hardcoded 8 is honoured', async () => {
    // The regression: the loop was bounded by a constant 8 rather than by the
    // row's ceiling, so max_iterations = 3 ran 8 times and the row was stored
    // over budget. Now the ceiling is the bound.
    const h = buildCore({ reason: neverResponds() });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxIterations: 3 } });

    const row = h.repo.only();
    assert.equal(row.max_iterations, 3);
    assert.equal(row.iterations_used, 3);
    assert.ok(row.iterations_used <= row.max_iterations,
      `stored over budget: ${row.iterations_used}/${row.max_iterations}`);
    assert.equal(h.calls.reason.length, 3, 'no reasoning turn past the ceiling');
    assert.equal(row.completion_reason, 'budget_exceeded');
  });

  test('the wrap-up turn happens inside the budget, not one turn past it', async () => {
    // The restricted respond-only schema used to be switched on by a verdict
    // read before the increment, so it first appeared on the turn AFTER the
    // ceiling. It now lands on the last permitted turn.
    const h = buildCore({ reason: neverResponds() });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxIterations: 3 } });

    assert.deepEqual(h.calls.buildContext.map(c => c.budgetExceeded), [false, false, true]);
    assert.equal(h.repo.only().iterations_used, 3);
  });

  // --- Write reserve -------------------------------------------------------
  //
  // A research mission spent its whole token budget gathering five sources and
  // then had nothing left to write the brief, so it delivered the placeholder
  // "Budget exceeded during plan execution." holding good data. A slice of the
  // budget is now reserved for the synthesis pass.

  test('the write pass is entered on the reserve, before the token ceiling', async () => {
    // maxTokens 10000 → reserve 2000. Two 4000-token turns leave exactly the
    // reserve, so the third turn is the funded write — while the row is still
    // inside its ceiling (8000/10000), not past it.
    const brief = '# Markets & Macro Intelligence Brief\n\nGold is bid.';
    const h = buildCore({
      reason: async (i) => i < 2
        ? { action: { thought: `turn ${i}`, action: 'think' }, tokens: 4000, provider: 'fake', model: 'fake' }
        : { action: { thought: 'writing', action: 'respond', response: brief }, tokens: 500, provider: 'fake', model: 'fake' },
    });
    const out = await h.core.run({ goal: 'g', userId: 'u1', budget: { maxTokens: 10000 } });

    assert.deepEqual(h.calls.buildContext.map(c => c.budgetExceeded), [false, false, true],
      'the restricted write schema arrives on the reserve turn');
    const row = h.repo.only();
    assert.ok(row.tokens_used <= row.max_tokens,
      `the write was funded, not overshot: ${row.tokens_used}/${row.max_tokens}`);
    assert.equal(row.completion_reason, 'natural');
    assert.match(out.response, /Markets & Macro/, 'the brief is delivered, not a placeholder');
  });

  test('a report written on the last of the budget counts as delivered', async () => {
    // The reserve buys a wrap-up turn, but that turn carries every accumulated
    // tool result in its context and can still land over the ceiling. The loop
    // used to read the breach before the action, so the finished brief was
    // stamped 'budget_exceeded' — and MissionScheduler, which treats that reason
    // as a failed run, binned the report and mailed "Mission didn't complete"
    // instead. A run holding a real report has succeeded, whatever it cost.
    const brief = '# Daily Research Digest\n\nThree sources, one conclusion.';
    const h = buildCore({
      reason: async (i) => i === 0
        ? { action: { thought: 'researching', action: 'think' }, tokens: 5000, provider: 'fake', model: 'fake' }
        : { action: { thought: 'writing', action: 'respond', response: brief }, tokens: 6000, provider: 'fake', model: 'fake' },
    });
    const out = await h.core.run({ goal: 'g', userId: 'u1', budget: { maxTokens: 10000 } });

    const row = h.repo.only();
    assert.ok(row.tokens_used > row.max_tokens, 'the write did overshoot the ceiling');
    assert.equal(row.completion_reason, 'natural', 'an overshooting write is still a delivered report');
    assert.match(out.response, /Daily Research Digest/);
  });

  test('the reserve is sized from the priciest turn, not a flat percentage', async () => {
    // 15% of a 15000 ceiling is 2250 — less than half of what one turn holding
    // the tool results costs. Every "funded" write was underfunded, which is why
    // live missions kept ending at 19808/15000. The reserve now tracks the
    // largest turn the run has actually paid for.
    const h = buildCore({
      reason: async (i) => i < 2
        ? { action: { thought: `turn ${i}`, action: 'think' }, tokens: 5000, provider: 'fake', model: 'fake' }
        : { action: { thought: 'writing', action: 'respond', response: 'done' }, tokens: 100, provider: 'fake', model: 'fake' },
    });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxTokens: 15000 } });

    // After one 5000-token turn the reserve is 5000, and 10000 left is still
    // above it; after two, 5000 left trips it. The write lands on turn 3.
    assert.deepEqual(h.calls.buildContext.map(c => c.budgetExceeded), [false, false, true]);
  });

  // --- Budget precedence ----------------------------------------------------
  //
  // A caller's budget outranks the agent's configured one, because the callers
  // that set a budget (briefing, MissionScheduler) size it deliberately. The
  // "think hard" keywords in aiChat.js are NOT that: they are the user asking
  // for more effort, and as a plain override "think hard" handed an agent LESS
  // than its own budget — 8,000 tokens against Rasha's 15,000 — while also
  // raising its iteration ceiling. It made the breach it claims to relieve.

  const withBudget = (budget) => ({ tools: null, runtimeSettings: { risk: 'Low', budget } });

  test("an agent's own budget applies when the caller sets none", async () => {
    const h = buildCore({
      reason: neverResponds(),
      agentConfig: withBudget({ maxTokens: 30000, maxIterations: 6 })
    });
    await h.core.run({ goal: 'g', userId: 'u1' });

    const row = h.repo.only();
    assert.equal(row.max_tokens, 30000);
    assert.equal(row.max_iterations, 6);
  });

  test('a deliberate caller budget still overrides the agent, up or down', async () => {
    const h = buildCore({
      reason: neverResponds(),
      agentConfig: withBudget({ maxTokens: 30000, maxIterations: 6 })
    });
    // MissionScheduler and briefing.js size runs on purpose; a smaller number
    // from them must mean smaller.
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxTokens: 12000, maxIterations: 2 } });

    const row = h.repo.only();
    assert.equal(row.max_tokens, 12000);
    assert.equal(row.max_iterations, 2);
  });

  test('a floor budget raises ceilings and can never lower them', async () => {
    const h = buildCore({
      reason: neverResponds(),
      agentConfig: withBudget({ maxTokens: 30000, maxIterations: 6, maxToolCalls: 8 })
    });
    // The shape aiChat.js sends for "think hard": more iterations, and a token
    // number that must not be allowed to undercut the agent's own.
    await h.core.run({
      goal: 'think hard about g', userId: 'u1',
      budget: { maxTokens: 8000, maxIterations: 12, maxToolCalls: 10, floor: true }
    });

    const row = h.repo.only();
    assert.equal(row.max_tokens, 30000, 'asking for more effort must not shrink the budget');
    assert.equal(row.max_iterations, 12, 'the higher of the two still wins');
    assert.equal(row.max_tool_calls, 10);
  });

  test('a floor budget still applies to an agent with no budget of its own', async () => {
    const h = buildCore({ reason: neverResponds(), agentConfig: null });
    await h.core.run({
      goal: 'think hard about g', userId: 'u1',
      budget: { maxTokens: 30000, maxIterations: 10, floor: true }
    });

    const row = h.repo.only();
    assert.equal(row.max_tokens, 30000);
    assert.equal(row.max_iterations, 10);
  });

  test('a mid-plan budget breach synthesizes what it gathered', async () => {
    // The plan wants three sources; the tool-call budget covers one. The run
    // used to end on the placeholder, discarding the result it already had.
    const brief = '# Brief\n\nStocks only — commodities and crypto unavailable.';
    const h = buildCore({
      planSteps: [
        { step: 1, action: 'tool', tool: 'stocks', input: 'AAPL' },
        { step: 2, action: 'tool', tool: 'commodities', input: 'gold' },
        { step: 3, action: 'tool', tool: 'crypto', input: 'BTC' },
      ],
      reason: async (i) => i === 0
        ? { action: { thought: 'planning', action: 'plan' }, tokens: 10, provider: 'fake', model: 'fake' }
        : { action: { thought: 'writing', action: 'respond', response: brief }, tokens: 10, provider: 'fake', model: 'fake' },
    });
    const out = await h.core.run({ goal: 'g', userId: 'u1', budget: { maxToolCalls: 1, maxTokens: 50000 } });

    assert.match(out.response, /^# Brief/, 'the report was written from partial research');
    assert.doesNotMatch(out.response, /Budget exceeded/);
    const writeTurn = h.calls.buildContext.find(c => c.budgetExceeded);
    assert.deepEqual(writeTurn.missingSources, ['commodities', 'crypto'],
      'the sources that never ran are named for the write-up');
  });

  test('a mid-plan breach with nothing gathered still reports failure', async () => {
    // The MissionScheduler gate keys off completion_reason: a run that got no
    // data at all must stay a failure, or empty runs go out as reports again.
    const h = buildCore({
      planSteps: [{ step: 1, action: 'tool', tool: 'stocks', input: 'AAPL' }],
      reason: async () => ({ action: { thought: 'planning', action: 'plan' }, tokens: 10, provider: 'fake', model: 'fake' }),
    });
    const out = await h.core.run({ goal: 'g', userId: 'u1', budget: { maxToolCalls: 0, maxTokens: 50000 } });

    // Which placeholder comes back depends on how early the budget ran out;
    // what must hold is that the row says the run failed, because that is the
    // field MissionScheduler's FAILED_REASONS gate reads before delivering.
    assert.equal(h.repo.only().completion_reason, 'budget_exceeded');
    // Any of the three ceiling placeholders is acceptable here, for the reason
    // given above — the point of the test is the completion_reason, not the
    // prose. Matching one exact sentence made this fail when the user-facing
    // wording was corrected, which is a test tracking copy rather than behaviour.
    assert.match(out.response,
      /per-answer limit|Budget exceeded during plan|Iteration budget exhausted/);
    assert.equal(h.calls.executeTool.length, 0, 'nothing was gathered to write from');
  });

  test('the reserve funds exactly one write pass', async () => {
    // The reserve must not become a second open-ended budget: a model that
    // never volunteers an answer gets one restricted turn, then the run ends.
    const h = buildCore({ reason: neverResponds(4000) });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxTokens: 10000 } });

    assert.equal(h.calls.buildContext.filter(c => c.budgetExceeded).length, 1,
      'one funded write pass, not a repeating one');
    assert.equal(h.repo.only().completion_reason, 'budget_exceeded');
  });

  test('an exhausted token ceiling starts no further turn', async () => {
    // 106 live rows are over their token ceiling. Tokens are only knowable after
    // the call, so the turn that crosses the line still lands over it — what is
    // enforced is that the loop stops there instead of taking another turn.
    const h = buildCore({ reason: neverResponds(3000) });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxTokens: 5000 } });

    const row = h.repo.only();
    assert.equal(h.calls.reason.length, 2, 'the third turn was refused');
    assert.equal(row.tokens_used, 6000);
    assert.equal(row.iterations_used, 2);
    assert.equal(row.completion_reason, 'budget_exceeded');
  });

  test('an exhausted tool ceiling buys one synthesis turn and no more tool calls', async () => {
    const h = buildCore({ reason: alwaysCallsATool() });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxToolCalls: 2 } });

    const row = h.repo.only();
    assert.equal(row.tool_calls_used, 2);
    assert.ok(row.tool_calls_used <= row.max_tool_calls);
    assert.equal(h.calls.executeTool.length, 2, 'no tool call after the ceiling');
    assert.equal(h.calls.reason.length, 3, 'one wrap-up turn to synthesize what was gathered');
    assert.equal(row.completion_reason, 'budget_exceeded');
  });

  test('a ceiling above the safety net does not raise the effective cap', async () => {
    // Deliberate: budgets configured above 8 have never been reachable, and
    // making them reachable is a spend decision, not an enforcement one.
    const h = buildCore({ reason: neverResponds() });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxIterations: 20, maxToolCalls: 50, maxTokens: 10 ** 6 } });

    const row = h.repo.only();
    assert.equal(row.max_iterations, 20);
    assert.equal(row.iterations_used, 8);
  });

  test('a run that answers early still completes naturally', async () => {
    // The ceiling must not turn every completion into a budget breach.
    const h = buildCore({
      reason: async () => ({ action: { action: 'respond', response: 'here you go' }, tokens: 10 }),
    });
    const out = await h.core.run({ goal: 'g', userId: 'u1' });

    const row = h.repo.only();
    assert.equal(row.iterations_used, 1);
    assert.equal(row.completion_reason, 'natural');
    assert.equal(out.response, 'here you go');
  });

  test('an explicit zero budget is not silently replaced by the default', async () => {
    // The override was applied on truthiness, so a caller asking for 0 got 8.
    const h = buildCore({ reason: neverResponds() });
    await h.core.run({ goal: 'g', userId: 'u1', budget: { maxIterations: 0 } });

    const row = h.repo.only();
    assert.equal(row.max_iterations, 0);
    assert.equal(row.iterations_used, 0);
    assert.equal(h.calls.reason.length, 0);
  });
});

test.describe('resumeExecution re-enters the loop under the remaining budget', () => {
  test('the continuation inherits what is left, not a fresh ceiling', async () => {
    // run() mints a new execution, so without carrying the remainder an approval
    // launders the ceiling: neither row reads as over budget while the work as a
    // whole runs to twice its limit.
    const h = buildCore({
      reason: async () => ({ action: { action: 'respond', response: 'done' }, tokens: 5 }),
      seed: [waitingRow({ iterations_used: 6, tool_calls_used: 1, tokens_used: 1000 })],
    });

    await h.core.resumeExecution('exec_original', { userId: 'u1' });

    const [continuation] = h.repo.minted();
    assert.ok(continuation, 'the resumption should mint a continuation execution');
    assert.equal(continuation.max_iterations, 2);   // 8 - 6
    assert.equal(continuation.max_tool_calls, 4);   // 5 - 1
    assert.equal(continuation.max_tokens, 4000);    // 5000 - 1000

    assert.equal(h.repo.get('exec_original').current_state, 'completed');
  });

  test('a spent budget refuses to resume instead of granting a new one', async () => {
    const h = buildCore({
      reason: neverResponds(),
      seed: [waitingRow({ iterations_used: 8 })],
    });

    await assert.rejects(
      () => h.core.resumeExecution('exec_original', { userId: 'u1' }),
      /budget is exhausted \(maxIterations\)/);

    assert.equal(h.calls.reason.length, 0, 'no continuation may run');
    assert.deepEqual(h.repo.minted(), [], 'no continuation execution may be minted');

    // Retired the way the reject route retires a parked execution — waiting ->
    // completed is not a legal transition.
    const original = h.repo.get('exec_original');
    assert.equal(original.current_state, 'cancelled', 'must not be stranded in running');
    assert.equal(original.completion_reason, 'budget_exceeded');
  });
});

