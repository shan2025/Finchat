/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable('governance_evaluations', {
    eval_id: { type: 'text', primaryKey: true },
    execution_id: { type: 'text', references: '"executions"' },
    evaluated_agent: { type: 'text', notNull: true },
    evaluator: { type: 'text', notNull: true, default: 'plato' },
    accuracy_score: { type: 'integer', notNull: true },
    relevance_score: { type: 'integer', notNull: true },
    efficiency_score: { type: 'integer', notNull: true },
    overall_score: { type: 'numeric(3,1)' },
    feedback: { type: 'text', notNull: true },
    tokens_spent: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('governance_evaluations');
};
