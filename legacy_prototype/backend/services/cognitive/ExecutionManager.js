// services/cognitive/ExecutionManager.js — Cognitive Core Execution Lifecycle & Budget Manager
//
// Lifecycle policy lives here; SQL lives in repositories/ExecutionRepository.js.
// The split exists so budget rules and transition rules can be unit-tested
// without a database — see test/execution-manager.test.js.
//
// The module still exports the same flat functions it always did, bound to the
// default repository, so existing `const { createExecution } = require(...)`
// call sites are unaffected. Tests use createExecutionManager({ repository }).
const { executionRepository } = require('../../repositories/ExecutionRepository');
const { STATES, validateTransition, stateMachineEvents } = require('./StateMachine');

/**
 * Decide whether an execution has breached any ceiling. Pure: takes a row and a
 * clock, returns a verdict. Kept separate from the DB read so the arithmetic —
 * which is ours, not the model's — is testable in isolation.
 *
 * @param {object} row - an executions row
 * @param {number} [now] - epoch ms, injectable so runtime tests are not flaky
 */
function evaluateBudget(row, now = Date.now()) {
  const iterationsBreached = row.iterations_used >= row.max_iterations;
  const toolCallsBreached = row.tool_calls_used >= row.max_tool_calls;
  const tokensBreached = row.tokens_used >= row.max_tokens;

  const elapsedSeconds = (now - new Date(row.created_at).getTime()) / 1000;
  const runtimeBreached = elapsedSeconds >= row.max_runtime_seconds;

  const breached = iterationsBreached || toolCallsBreached || tokensBreached || runtimeBreached;

  return {
    breached,
    reason: breached ? 'budget_exceeded' : null,
    details: {
      iterations: { used: row.iterations_used, max: row.max_iterations, breached: iterationsBreached },
      toolCalls: { used: row.tool_calls_used, max: row.max_tool_calls, breached: toolCallsBreached },
      tokens: { used: row.tokens_used, max: row.max_tokens, breached: tokensBreached },
      runtimeSeconds: { used: Math.round(elapsedSeconds), max: row.max_runtime_seconds, breached: runtimeBreached },
    },
  };
}

function createExecutionManager({ repository = executionRepository } = {}) {
  /**
   * Create a new execution record with budget defaults.
   */
  async function createExecution({
    executionId = null,
    goalId = null,
    userId = 'system',
    conversationId = null,
    goal,
    assignedAgent = null,
    maxIterations = 8,
    maxToolCalls = 5,
    maxTokens = 5000,
    maxRuntimeSeconds = 60,
  }) {
    const id = executionId || `exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const created = await repository.insert({
      executionId: id,
      goalId,
      userId,
      conversationId,
      goal,
      assignedAgent,
      state: STATES.CREATED,
      maxIterations,
      maxToolCalls,
      maxTokens,
      maxRuntimeSeconds,
    });

    stateMachineEvents.emit('execution:created', {
      executionId: id,
      goal,
      userId,
      timestamp: new Date().toISOString(),
    });

    return created;
  }

  /**
   * Get an execution record by ID. Throws when absent — callers treat a missing
   * execution as a programming error, not a normal outcome.
   */
  async function getExecution(executionId) {
    const row = await repository.findById(executionId);
    if (!row) {
      throw new Error(`Execution not found: ${executionId}`);
    }
    return row;
  }

  /**
   * Update the lifecycle state after validating against the StateMachine.
   */
  async function updateState(executionId, newState, { waitReason = null, completionReason = null, result = null } = {}) {
    const current = await getExecution(executionId);

    // Throws IllegalTransitionError if forbidden — validated BEFORE the write,
    // so a refused transition never reaches the database.
    validateTransition(current.current_state, newState, executionId, {
      waitReason,
      completionReason,
      result,
    });

    return repository.updateState(executionId, newState, { waitReason, completionReason, result });
  }

  async function completeExecution(executionId, { result = null, completionReason = 'natural' } = {}) {
    return updateState(executionId, STATES.COMPLETED, { completionReason, result });
  }

  async function failExecution(executionId, { error = null, completionReason = 'error' } = {}) {
    const errMsg = typeof error === 'string' ? error : (error?.message || null);
    return updateState(executionId, STATES.FAILED, { completionReason, result: errMsg });
  }

  /**
   * Check whether any budget ceiling has been breached.
   */
  async function checkBudget(executionId) {
    return evaluateBudget(await getExecution(executionId));
  }

  /**
   * Increment usage counters atomically.
   */
  async function incrementUsage(executionId, { iterations = 0, toolCalls = 0, tokens = 0 } = {}) {
    const row = await repository.incrementUsage(executionId, { iterations, toolCalls, tokens });
    if (!row) {
      throw new Error(`Execution not found for usage increment: ${executionId}`);
    }
    return row;
  }

  /**
   * Sweep executions stuck in non-terminal states (e.g. after a server crash the
   * row stays 'running' forever, which makes /api/agents/status report the agent
   * as WORKING indefinitely).
   */
  async function sweepStaleExecutions({ maxActiveMinutes = 30, maxWaitingHours = 6 } = {}) {
    const rows = await repository.sweepStale({ maxActiveMinutes, maxWaitingHours });
    if (rows.length > 0) {
      console.log(`🧹 Swept ${rows.length} stale execution(s):`,
        rows.map(r => `${r.execution_id} [${r.assigned_agent}]`).join(', '));
    }
    return rows;
  }

  return {
    createExecution,
    getExecution,
    updateState,
    completeExecution,
    failExecution,
    checkBudget,
    incrementUsage,
    sweepStaleExecutions,
  };
}

module.exports = {
  ...createExecutionManager(),
  createExecutionManager,
  evaluateBudget,
};
