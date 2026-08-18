// test/execution-manager.test.js — lifecycle policy, tested against a fake store.
//
// This is what the repository split bought: the budget rules and the
// validate-before-write ordering can now be checked exhaustively without a
// database, a Groq key, or a running server.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createExecutionManager, evaluateBudget,
} = require('../services/cognitive/ExecutionManager');
const { STATES, IllegalTransitionError } = require('../services/cognitive/StateMachine');

const baseRow = (over = {}) => ({
  execution_id: 'exec_1',
  current_state: STATES.RUNNING,
  iterations_used: 0, max_iterations: 8,
  tool_calls_used: 0, max_tool_calls: 5,
  tokens_used: 0, max_tokens: 5000,
  max_runtime_seconds: 60,
  created_at: '2026-08-13T10:00:00.000Z',
  ...over,
});

/** Minimal in-memory stand-in for ExecutionRepository. */
function fakeRepo(row = baseRow()) {
  const calls = [];
  return {
    calls,
    async insert(r) { calls.push(['insert', r]); return { ...row, ...r }; },
    async findById(id) { calls.push(['findById', id]); return row; },
    async updateState(id, s, o) { calls.push(['updateState', id, s, o]); return { ...row, current_state: s }; },
    async incrementUsage(id, o) { calls.push(['incrementUsage', id, o]); return row; },
    async sweepStale(o) { calls.push(['sweepStale', o]); return []; },
  };
}

test.describe('evaluateBudget (pure)', () => {
  const AT = new Date('2026-08-13T10:00:10.000Z').getTime(); // 10s in

  test('a fresh execution has not breached', () => {
    const v = evaluateBudget(baseRow(), AT);
    assert.equal(v.breached, false);
    assert.equal(v.reason, null);
  });

  test('breaches at the ceiling, not above it', () => {
    // >= is deliberate: hitting the cap is a breach, so an 8-iteration budget
    // permits 8 iterations and then stops.
    assert.equal(evaluateBudget(baseRow({ iterations_used: 7 }), AT).breached, false);
    assert.equal(evaluateBudget(baseRow({ iterations_used: 8 }), AT).breached, true);
  });

  test('each ceiling independently trips the breach', () => {
    for (const over of [
      { iterations_used: 8 }, { tool_calls_used: 5 }, { tokens_used: 5000 },
    ]) {
      const v = evaluateBudget(baseRow(over), AT);
      assert.equal(v.breached, true, JSON.stringify(over));
      assert.equal(v.reason, 'budget_exceeded');
    }
  });

  test('runtime breach is measured from created_at', () => {
    const justUnder = new Date('2026-08-13T10:00:59.000Z').getTime();
    const justOver = new Date('2026-08-13T10:01:00.000Z').getTime();
    assert.equal(evaluateBudget(baseRow(), justUnder).breached, false);
    assert.equal(evaluateBudget(baseRow(), justOver).breached, true);
    assert.equal(evaluateBudget(baseRow(), justOver).details.runtimeSeconds.breached, true);
  });

  test('reports per-ceiling detail for the UI', () => {
    const v = evaluateBudget(baseRow({ tokens_used: 4000 }), AT);
    assert.equal(v.details.tokens.used, 4000);
    assert.equal(v.details.tokens.max, 5000);
    assert.equal(v.details.tokens.breached, false);
    assert.equal(v.details.runtimeSeconds.used, 10);
  });

  test('is pure — the same row and clock always agree', () => {
    const row = baseRow({ tokens_used: 123 });
    assert.deepEqual(evaluateBudget(row, AT), evaluateBudget(row, AT));
  });
});

test.describe('lifecycle', () => {
  test('createExecution mints an id and inserts in the created state', async () => {
    const repo = fakeRepo();
    const mgr = createExecutionManager({ repository: repo });
    const out = await mgr.createExecution({ goal: 'test goal', userId: 'u1' });

    const [, inserted] = repo.calls.find(c => c[0] === 'insert');
    assert.equal(inserted.state, STATES.CREATED);
    assert.match(inserted.executionId, /^exec_/);
    assert.equal(inserted.goal, 'test goal');
    assert.equal(out.goal, 'test goal');
  });

  test('createExecution honours an explicit id', async () => {
    const repo = fakeRepo();
    const mgr = createExecutionManager({ repository: repo });
    await mgr.createExecution({ goal: 'g', executionId: 'exec_fixed' });
    const [, inserted] = repo.calls.find(c => c[0] === 'insert');
    assert.equal(inserted.executionId, 'exec_fixed');
  });

  test('createExecution applies the documented budget defaults', async () => {
    const repo = fakeRepo();
    const mgr = createExecutionManager({ repository: repo });
    await mgr.createExecution({ goal: 'g' });
    const [, i] = repo.calls.find(c => c[0] === 'insert');
    assert.equal(i.maxIterations, 8);
    assert.equal(i.maxToolCalls, 5);
    // Raised from 5000/60s on 2026-08-18. One reasoning turn measures ~2,614
    // tokens against live traffic (the prompt is re-sent and re-charged every
    // iteration), so 5000 could not fund a second turn and agents with no
    // caller-supplied budget answered "Budget exceeded" to ordinary questions.
    assert.equal(i.maxTokens, 15000);
    assert.equal(i.maxRuntimeSeconds, 120);
  });

  test('getExecution throws when the row is missing', async () => {
    const repo = fakeRepo();
    repo.findById = async () => null;
    const mgr = createExecutionManager({ repository: repo });
    await assert.rejects(() => mgr.getExecution('gone'), /Execution not found: gone/);
  });

  test('an illegal transition never reaches the store', async () => {
    // The whole point of validating before the write.
    const repo = fakeRepo(baseRow({ current_state: STATES.COMPLETED }));
    const mgr = createExecutionManager({ repository: repo });

    await assert.rejects(
      () => mgr.updateState('exec_1', STATES.RUNNING),
      (e) => e instanceof IllegalTransitionError);

    assert.equal(repo.calls.some(c => c[0] === 'updateState'), false,
      'no write may occur after a refused transition');
  });

  test('a legal transition does reach the store', async () => {
    const repo = fakeRepo(baseRow({ current_state: STATES.RUNNING }));
    const mgr = createExecutionManager({ repository: repo });
    await mgr.updateState('exec_1', STATES.WAITING, { waitReason: 'human_approval' });

    const call = repo.calls.find(c => c[0] === 'updateState');
    assert.ok(call);
    assert.equal(call[2], STATES.WAITING);
    assert.equal(call[3].waitReason, 'human_approval');
  });

  test('completeExecution records the natural completion reason', async () => {
    const repo = fakeRepo(baseRow({ current_state: STATES.RUNNING }));
    const mgr = createExecutionManager({ repository: repo });
    await mgr.completeExecution('exec_1', { result: 'done' });
    const call = repo.calls.find(c => c[0] === 'updateState');
    assert.equal(call[2], STATES.COMPLETED);
    assert.equal(call[3].completionReason, 'natural');
    assert.equal(call[3].result, 'done');
  });

  test('failExecution unwraps an Error into its message', async () => {
    const repo = fakeRepo(baseRow({ current_state: STATES.RUNNING }));
    const mgr = createExecutionManager({ repository: repo });
    await mgr.failExecution('exec_1', { error: new Error('boom') });
    const call = repo.calls.find(c => c[0] === 'updateState');
    assert.equal(call[2], STATES.FAILED);
    assert.equal(call[3].result, 'boom');
  });

  test('failExecution accepts a plain string', async () => {
    const repo = fakeRepo(baseRow({ current_state: STATES.RUNNING }));
    const mgr = createExecutionManager({ repository: repo });
    await mgr.failExecution('exec_1', { error: 'plain reason' });
    assert.equal(repo.calls.find(c => c[0] === 'updateState')[3].result, 'plain reason');
  });

  test('incrementUsage throws when the row vanished', async () => {
    const repo = fakeRepo();
    repo.incrementUsage = async () => null;
    const mgr = createExecutionManager({ repository: repo });
    await assert.rejects(
      () => mgr.incrementUsage('gone', { tokens: 1 }),
      /Execution not found for usage increment/);
  });

  test('checkBudget reads the row and applies the pure policy', async () => {
    const repo = fakeRepo(baseRow({ tokens_used: 99999 }));
    const mgr = createExecutionManager({ repository: repo });
    const v = await mgr.checkBudget('exec_1');
    assert.equal(v.breached, true);
    assert.equal(v.reason, 'budget_exceeded');
  });

  test('sweepStaleExecutions forwards its windows', async () => {
    const repo = fakeRepo();
    const mgr = createExecutionManager({ repository: repo });
    await mgr.sweepStaleExecutions({ maxActiveMinutes: 15, maxWaitingHours: 2 });
    assert.deepEqual(repo.calls.find(c => c[0] === 'sweepStale')[1],
      { maxActiveMinutes: 15, maxWaitingHours: 2 });
  });
});

test('the module still exports the flat functions call sites destructure', () => {
  // 12 call sites do `const { createExecution } = require('./ExecutionManager')`.
  const mod = require('../services/cognitive/ExecutionManager');
  for (const name of ['createExecution', 'getExecution', 'updateState',
    'completeExecution', 'failExecution', 'checkBudget', 'incrementUsage',
    'sweepStaleExecutions']) {
    assert.equal(typeof mod[name], 'function', `missing export: ${name}`);
  }
});
