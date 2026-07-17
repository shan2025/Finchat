/* eslint-disable camelcase */

exports.up = (pgm) => {
  // tool_permissions table
  pgm.createTable('tool_permissions', {
    permission_id: { type: 'text', primaryKey: true },
    agent_id: { type: 'text', notNull: true, references: '"agents"', onDelete: 'CASCADE' },
    tool_name: { type: 'text', notNull: true },
    allowed: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // tool_calls table
  pgm.createTable('tool_calls', {
    call_id: { type: 'text', primaryKey: true },
    execution_id: { type: 'text', notNull: true, references: '"executions"' },
    agent_id: { type: 'text', notNull: true, references: '"agents"' },
    tool_name: { type: 'text', notNull: true },
    arguments: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    status: { type: 'text', notNull: true, default: 'pending' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // tool_results table
  pgm.createTable('tool_results', {
    result_id: { type: 'text', primaryKey: true },
    call_id: { type: 'text', notNull: true, references: '"tool_calls"', onDelete: 'CASCADE' },
    output: { type: 'jsonb' },
    error: { type: 'text' },
    cached: { type: 'integer', notNull: true, default: 0 },
    duration_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tool_results');
  pgm.dropTable('tool_calls');
  pgm.dropTable('tool_permissions');
};
