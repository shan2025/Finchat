// test/execution-repository.test.js — the SQL boundary, tested without a database.
//
// The point of the repository is that `query` is injectable. These tests hand it
// a fake and assert on the statements and parameters, which is exactly the class
// of bug (wrong column, wrong param order, read-modify-write) that previously
// could only be caught by running against live Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionRepository } = require('../repositories/ExecutionRepository');

/** Records every call and returns whatever rows the test queues up. */
function fakeQuery(rows = []) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params, normalised: sql.replace(/\s+/g, ' ').trim() });
    return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
  };
  fn.calls = calls;
  return fn;
}

const ROW = { execution_id: 'exec_1', current_state: 'created' };

test('insert writes every column and returns the created row', async () => {
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });

  const out = await repo.insert({
    executionId: 'exec_1', goalId: 'g1', userId: 'u1', conversationId: 'c1',
    goal: 'do a thing', assignedAgent: 'nova', state: 'created',
    maxIterations: 8, maxToolCalls: 5, maxTokens: 5000, maxRuntimeSeconds: 60,
  });

  assert.deepEqual(out, ROW);
  assert.equal(q.calls.length, 1);
  assert.match(q.calls[0].normalised, /^INSERT INTO executions/);

  // Parameter order is the contract with the column list — pin it.
  assert.deepEqual(q.calls[0].params,
    ['exec_1', 'g1', 'u1', 'c1', 'do a thing', 'nova', 'created', 8, 5, 5000, 60]);

  // Usage counters must start at zero in SQL, not be passed in.
  assert.match(q.calls[0].normalised, /0, 0, 0\)/);
});

test('findById returns null rather than throwing when absent', async () => {
  const repo = createExecutionRepository({ query: fakeQuery([]) });
  assert.equal(await repo.findById('nope'), null);
});

test('findById selects by execution_id', async () => {
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.findById('exec_1');
  assert.equal(q.calls[0].normalised,
    'SELECT * FROM executions WHERE execution_id = $1');
  assert.deepEqual(q.calls[0].params, ['exec_1']);
});

test('updateState passes state, waitReason, completionReason, result, id in order', async () => {
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.updateState('exec_1', 'waiting',
    { waitReason: 'human_approval', completionReason: null, result: null });
  assert.deepEqual(q.calls[0].params,
    ['waiting', 'human_approval', null, null, 'exec_1']);
});

test('updateState preserves existing completion_reason and result via COALESCE', async () => {
  // Without COALESCE, a plain state change would null out a previously recorded
  // completion reason.
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.updateState('exec_1', 'running');
  assert.match(q.calls[0].normalised, /completion_reason = COALESCE\(\$3, completion_reason\)/);
  assert.match(q.calls[0].normalised, /result = COALESCE\(\$4, result\)/);
});

test('incrementUsage increments in SQL, never read-modify-write', async () => {
  // Two turns finishing at once must not lose a count, so the addition has to
  // happen in the database.
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.incrementUsage('exec_1', { iterations: 1, toolCalls: 2, tokens: 300 });

  const sql = q.calls[0].normalised;
  assert.match(sql, /iterations_used = iterations_used \+ \$1/);
  assert.match(sql, /tool_calls_used = tool_calls_used \+ \$2/);
  assert.match(sql, /\btokens_used = tokens_used \+ \$3/);
  assert.match(sql, /prompt_tokens_used = prompt_tokens_used \+ \$4/);
  assert.match(sql, /completion_tokens_used = completion_tokens_used \+ \$5/);
  assert.match(sql, /context_chars_saved = context_chars_saved \+ \$6/);
  assert.deepEqual(q.calls[0].params, [1, 2, 300, 0, 0, 0, 'exec_1']);
  assert.equal(q.calls.length, 1, 'must be a single statement, not a read then a write');
});

test('incrementUsage records the prompt/completion split alongside the total', async () => {
  // tokens_used stays the TOTAL — it is what providers meter and what the budget
  // is enforced against. The split is added detail: it is the only way to see
  // that a run spent most of its budget re-reading its own context (88% on the
  // measured Rasha run) rather than producing anything. See migration 031.
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.incrementUsage('exec_1',
    { iterations: 1, tokens: 4751, promptTokens: 3873, completionTokens: 878 });
  assert.deepEqual(q.calls[0].params, [1, 0, 4751, 3873, 878, 0, 'exec_1']);
});

test('incrementUsage accumulates context savings across turns', async () => {
  // The saving is per-turn and the loop runs several, so it accumulates in SQL
  // exactly like the token counters. See migration 032.
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.incrementUsage('exec_1', { iterations: 1, contextCharsSaved: 4577 });
  assert.deepEqual(q.calls[0].params, [1, 0, 0, 0, 0, 4577, 'exec_1']);
});

test('incrementUsage defaults every counter to zero', async () => {
  const q = fakeQuery([ROW]);
  const repo = createExecutionRepository({ query: q });
  await repo.incrementUsage('exec_1');
  assert.deepEqual(q.calls[0].params, [0, 0, 0, 0, 0, 0, 'exec_1']);
});

test.describe('sweepStale', () => {
  test('exempts executions waiting on a human', async () => {
    const q = fakeQuery([]);
    const repo = createExecutionRepository({ query: q });
    await repo.sweepStale();
    assert.match(q.calls[0].normalised,
      /COALESCE\(wait_reason, ''\) <> 'human_approval'/,
      'a person may take as long as they take');
  });

  test('uses the supplied windows', async () => {
    const q = fakeQuery([]);
    const repo = createExecutionRepository({ query: q });
    await repo.sweepStale({ maxActiveMinutes: 5, maxWaitingHours: 1 });
    assert.deepEqual(q.calls[0].params, [5, 1]);
  });

  test('defaults to 30 minutes and 6 hours', async () => {
    const q = fakeQuery([]);
    const repo = createExecutionRepository({ query: q });
    await repo.sweepStale();
    assert.deepEqual(q.calls[0].params, [30, 6]);
  });

  test('only sweeps non-terminal states', async () => {
    const q = fakeQuery([]);
    const repo = createExecutionRepository({ query: q });
    await repo.sweepStale();
    const sql = q.calls[0].normalised;
    assert.match(sql, /current_state IN \('created', 'ready', 'running'\)/);
    assert.doesNotMatch(sql, /'completed'/, 'a completed run must never be swept');
  });

  test('returns the swept rows', async () => {
    const swept = [{ execution_id: 'e1', assigned_agent: 'nova', goal: 'g' }];
    const repo = createExecutionRepository({ query: fakeQuery(swept) });
    assert.deepEqual(await repo.sweepStale(), swept);
  });
});

test('requiring the module does not open a database pool', () => {
  // If the pool were created at require time, none of the above could run.
  assert.doesNotThrow(() => {
    delete require.cache[require.resolve('../repositories/ExecutionRepository')];
    require('../repositories/ExecutionRepository');
  });
});
