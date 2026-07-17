// services/cognitive/ExecutionManager.js — Cognitive Core Execution Lifecycle & Budget Manager
const { query } = require('../../database');
const { STATES, validateTransition, stateMachineEvents } = require('./StateMachine');

/**
 * Create a new execution record in Supabase PostgreSQL with budget defaults.
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
  maxRuntimeSeconds = 60
}) {
  const id = executionId || `exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  
  const insertSql = `
    INSERT INTO executions (
      execution_id, goal_id, user_id, conversation_id, goal,
      assigned_agent, current_state, max_iterations, max_tool_calls,
      max_tokens, max_runtime_seconds, iterations_used, tool_calls_used, tokens_used
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0)
    RETURNING *;
  `;

  const params = [
    id,
    goalId,
    userId,
    conversationId,
    goal,
    assignedAgent,
    STATES.CREATED,
    maxIterations,
    maxToolCalls,
    maxTokens,
    maxRuntimeSeconds
  ];

  const res = await query(insertSql, params);
  const created = res.rows[0];

  // Emit created event
  stateMachineEvents.emit('execution:created', {
    executionId: id,
    goal,
    userId,
    timestamp: new Date().toISOString()
  });

  return created;
}

/**
 * Get an execution record by ID.
 */
async function getExecution(executionId) {
  const res = await query('SELECT * FROM executions WHERE execution_id = $1', [executionId]);
  if (res.rows.length === 0) {
    throw new Error(`Execution not found: ${executionId}`);
  }
  return res.rows[0];
}

/**
 * Update the lifecycle state of an execution after validating against StateMachine.
 */
async function updateState(executionId, newState, { waitReason = null, completionReason = null, result = null } = {}) {
  const current = await getExecution(executionId);

  // Throws IllegalTransitionError if forbidden
  validateTransition(current.current_state, newState, executionId, {
    waitReason,
    completionReason,
    result
  });

  const updateSql = `
    UPDATE executions
    SET current_state = $1,
        wait_reason = $2,
        completion_reason = COALESCE($3, completion_reason),
        result = COALESCE($4, result),
        updated_at = now()
    WHERE execution_id = $5
    RETURNING *;
  `;

  const res = await query(updateSql, [newState, waitReason, completionReason, result, executionId]);
  return res.rows[0];
}

/**
 * Transition execution to completed state.
 */
async function completeExecution(executionId, { result = null, completionReason = 'natural' } = {}) {
  return await updateState(executionId, STATES.COMPLETED, { completionReason, result });
}

/**
 * Transition execution to failed state.
 */
async function failExecution(executionId, { error = null, completionReason = 'error' } = {}) {
  const errMsg = typeof error === 'string' ? error : (error?.message || null);
  return await updateState(executionId, STATES.FAILED, { completionReason, result: errMsg });
}

/**
 * Check whether any budget ceiling has been breached for the execution per Decision #2.
 */
async function checkBudget(executionId) {
  const current = await getExecution(executionId);

  const iterationsBreached = current.iterations_used >= current.max_iterations;
  const toolCallsBreached = current.tool_calls_used >= current.max_tool_calls;
  const tokensBreached = current.tokens_used >= current.max_tokens;

  const elapsedSeconds = (Date.now() - new Date(current.created_at).getTime()) / 1000;
  const runtimeBreached = elapsedSeconds >= current.max_runtime_seconds;

  const breached = iterationsBreached || toolCallsBreached || tokensBreached || runtimeBreached;

  let reason = null;
  if (breached) {
    reason = 'budget_exceeded';
  }

  return {
    breached,
    reason,
    details: {
      iterations: { used: current.iterations_used, max: current.max_iterations, breached: iterationsBreached },
      toolCalls: { used: current.tool_calls_used, max: current.max_tool_calls, breached: toolCallsBreached },
      tokens: { used: current.tokens_used, max: current.max_tokens, breached: tokensBreached },
      runtimeSeconds: { used: Math.round(elapsedSeconds), max: current.max_runtime_seconds, breached: runtimeBreached }
    }
  };
}

/**
 * Increment usage counters atomically in PostgreSQL.
 */
async function incrementUsage(executionId, { iterations = 0, toolCalls = 0, tokens = 0 } = {}) {
  const updateSql = `
    UPDATE executions
    SET iterations_used = iterations_used + $1,
        tool_calls_used = tool_calls_used + $2,
        tokens_used = tokens_used + $3,
        updated_at = now()
    WHERE execution_id = $4
    RETURNING *;
  `;

  const res = await query(updateSql, [iterations, toolCalls, tokens, executionId]);
  if (res.rows.length === 0) {
    throw new Error(`Execution not found for usage increment: ${executionId}`);
  }
  return res.rows[0];
}

module.exports = {
  createExecution,
  getExecution,
  updateState,
  completeExecution,
  failExecution,
  checkBudget,
  incrementUsage
};
