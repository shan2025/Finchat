/* eslint-disable camelcase */

exports.up = (pgm) => {
  // goals table (Decision #1: replaces tasks and subtasks)
  pgm.createTable('goals', {
    goal_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"' },
    description: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'active' }, // active | completed | cancelled
    recurrence: { type: 'jsonb' }, // null for one-shot; {"cron": "...", "until": "..."} for recurring
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('goals');
};
