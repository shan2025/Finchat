/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable('agent_token_budgets', {
    budget_id: { type: 'text', primaryKey: true },
    agent_id: { type: 'text', notNull: true, references: '"agents"', onDelete: 'CASCADE' },
    allocated: { type: 'integer', notNull: true, default: 500 },
    spent: { type: 'integer', notNull: true, default: 0 },
    cycle_start: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    cycle_end: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('agent_token_budgets');
};
