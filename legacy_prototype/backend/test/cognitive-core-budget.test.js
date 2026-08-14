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
 */
function buildCore({ reason, seed = [] } = {}) {
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
    async plan() { return { plan: { steps: [] }, stored: false }; },
  });
  stub('../services/cognitive/MemoryService', {
    async retrieveEnrichedContext() { return { memories: [], graphContext: [], recipeHints: [] }; },
    async appendToScratchpad() {},
  });
  stub('../services/cognitive/ReflectionEngine', { async reflect() {} });
  stub('../services/cognitive/EventBus', { eventBus: new EventEmitter() });
  stub('../services/cognitive/MemoryEngine', { async getUserPreferences() { return []; } });
  stub('../services/agents/AgentRegistry', { async getAgentConfig() { return null; } });

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
