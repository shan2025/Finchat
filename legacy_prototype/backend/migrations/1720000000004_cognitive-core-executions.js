/* eslint-disable camelcase */

exports.up = (pgm) => {
  // executions table (Decision #2: budgets + usage directly on table; Decision #3: lifecycle state; Decision #4: wait_reason)
  pgm.createTable('executions', {
    execution_id: { type: 'text', primaryKey: true },
    goal_id: { type: 'text', references: '"goals"' },
    user_id: { type: 'text', notNull: true },
    conversation_id: { type: 'text' },
    goal: { type: 'text', notNull: true },
    current_plan: { type: 'jsonb' },
    assigned_agent: { type: 'text' },
    current_state: { type: 'text', notNull: true, default: 'created' }, // created|ready|running|waiting|completed|failed|cancelled
    wait_reason: { type: 'text' }, // tool_response|human_approval|scheduled_trigger
    working_memory_key: { type: 'text' },
    tool_history: { type: 'jsonb' },
    reflection: { type: 'text' },
    result: { type: 'text' },
    metrics: { type: 'jsonb' },
    parent_execution_id: { type: 'text', references: '"executions"' },
    max_iterations: { type: 'integer', notNull: true, default: 8 },
    max_tool_calls: { type: 'integer', notNull: true, default: 5 },
    max_tokens: { type: 'integer', notNull: true, default: 5000 },
    max_runtime_seconds: { type: 'integer', notNull: true, default: 60 },
    iterations_used: { type: 'integer', notNull: true, default: 0 },
    tool_calls_used: { type: 'integer', notNull: true, default: 0 },
    tokens_used: { type: 'integer', notNull: true, default: 0 },
    completion_reason: { type: 'text' }, // natural|budget_exceeded|error|cancelled
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // execution_logs table (Decision #3: phase-level timing and logging per row)
  pgm.createTable('execution_logs', {
    log_id: { type: 'bigserial', primaryKey: true },
    execution_id: { type: 'text', notNull: true, references: '"executions"' },
    phase: { type: 'text', notNull: true }, // thinking|planning|using_tool|reflecting
    step_number: { type: 'integer', notNull: true },
    content: { type: 'jsonb' },
    started_at: { type: 'timestamptz', notNull: true },
    ended_at: { type: 'timestamptz' },
    duration_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('execution_logs');
  pgm.dropTable('executions');
};
