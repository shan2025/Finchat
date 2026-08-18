// repositories/ExecutionRepository.js — all SQL for the `executions` table.
//
// This is the first repository, and the template for the rest. The problem it
// solves: `query()` is called directly from ~every service, so the schema has no
// boundary — a column rename means grepping the whole codebase, and nothing that
// touches the DB can be unit-tested without a live Supabase connection.
//
// Two rules make this work:
//   1. No SQL for `executions` lives anywhere else. If you need a new access
//      pattern, add a method here rather than reaching for query() again.
//   2. The `query` function is injected, so tests pass a fake and assert on the
//      statements and parameters without a database.
//
// Callers get the shared default instance (`executionRepository`); tests build
// their own with `createExecutionRepository({ query: fake })`.

const COLUMNS = `
  execution_id, goal_id, user_id, conversation_id, goal,
  assigned_agent, current_state, max_iterations, max_tool_calls,
  max_tokens, max_runtime_seconds, iterations_used, tool_calls_used, tokens_used
`;

/**
 * @param {object}   [deps]
 * @param {Function} [deps.query] - (sql, params) => Promise<{rows: object[]}>
 */
function createExecutionRepository({ query } = {}) {
  // Resolved lazily so requiring this module never opens a pool — that would
  // make it impossible to import in a unit test.
  const run = (sql, params) => {
    const q = query || require('../database').query;
    return q(sql, params);
  };

  return {
    async insert(row) {
      const res = await run(
        `INSERT INTO executions (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0)
         RETURNING *;`,
        [
          row.executionId, row.goalId, row.userId, row.conversationId, row.goal,
          row.assignedAgent, row.state, row.maxIterations, row.maxToolCalls,
          row.maxTokens, row.maxRuntimeSeconds,
        ]);
      return res.rows[0];
    },

    /** @returns {object|null} null when absent — the caller decides if that is an error. */
    async findById(executionId) {
      const res = await run(
        'SELECT * FROM executions WHERE execution_id = $1', [executionId]);
      return res.rows[0] || null;
    },

    async updateState(executionId, newState, { waitReason = null, completionReason = null, result = null } = {}) {
      const res = await run(
        `UPDATE executions
            SET current_state = $1,
                wait_reason = $2,
                completion_reason = COALESCE($3, completion_reason),
                result = COALESCE($4, result),
                updated_at = now()
          WHERE execution_id = $5
          RETURNING *;`,
        [newState, waitReason, completionReason, result, executionId]);
      return res.rows[0] || null;
    },

    /** Incremented in SQL, not read-modify-write, so concurrent turns cannot lose a count. */
    // `tokens` stays the TOTAL — it is what the providers meter and what the
    // budget is enforced against. promptTokens/completionTokens are the same
    // spend broken down, recorded so it is possible to see how much of a run's
    // cost was re-reading its own context rather than producing anything. They
    // default to 0, so a caller that only knows the total still works.
    async incrementUsage(executionId, {
      iterations = 0, toolCalls = 0, tokens = 0, promptTokens = 0, completionTokens = 0,
      contextCharsSaved = 0
    } = {}) {
      const res = await run(
        `UPDATE executions
            SET iterations_used = iterations_used + $1,
                tool_calls_used = tool_calls_used + $2,
                tokens_used = tokens_used + $3,
                prompt_tokens_used = prompt_tokens_used + $4,
                completion_tokens_used = completion_tokens_used + $5,
                context_chars_saved = context_chars_saved + $6,
                updated_at = now()
          WHERE execution_id = $7
          RETURNING *;`,
        [iterations, toolCalls, tokens, promptTokens, completionTokens, contextCharsSaved, executionId]);
      return res.rows[0] || null;
    },

    /**
     * Fail executions left non-terminal by a crash. Rows waiting on a human are
     * exempt — a person is allowed to take as long as they take.
     */
    async sweepStale({ maxActiveMinutes = 30, maxWaitingHours = 6 } = {}) {
      const res = await run(
        `UPDATE executions
            SET current_state = 'failed',
                completion_reason = 'timeout',
                result = 'Swept as stale: no activity for over the allowed window (likely a crashed or orphaned run)',
                updated_at = now()
          WHERE (
                  current_state IN ('created', 'ready', 'running')
              AND updated_at < now() - ($1 * interval '1 minute')
            ) OR (
                  current_state = 'waiting'
              AND COALESCE(wait_reason, '') <> 'human_approval'
              AND updated_at < now() - ($2 * interval '1 hour')
            )
          RETURNING execution_id, assigned_agent, goal;`,
        [maxActiveMinutes, maxWaitingHours]);
      return res.rows;
    },

    /**
     * Completed executions, for episodic recall. Lives here rather than in
     * MemoryRepository because it reads the `executions` table, and table
     * ownership is what keeps the boundary meaningful.
     *
     * Both filters are optional; placeholders are numbered as clauses are
     * appended so LIMIT always takes the next free index.
     */
    async findCompletedEpisodes({ userId, agentId, limit = 5 } = {}) {
      let sql = `
        SELECT e.execution_id, e.goal, e.result, e.assigned_agent,
               e.completion_reason, e.created_at
          FROM executions e
         WHERE e.current_state = 'completed'`;
      const params = [];
      let i = 1;

      if (userId) { sql += ` AND e.user_id = $${i++}`; params.push(userId); }
      if (agentId) { sql += ` AND e.assigned_agent = $${i++}`; params.push(agentId); }

      sql += ` ORDER BY e.created_at DESC LIMIT $${i}`;
      params.push(limit);

      const res = await run(sql, params);
      return res.rows;
    },
  };
}

module.exports = {
  createExecutionRepository,
  executionRepository: createExecutionRepository(),
};
