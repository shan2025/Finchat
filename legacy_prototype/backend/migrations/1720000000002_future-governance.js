/* eslint-disable camelcase */

exports.up = (pgm) => {
  // documents table
  pgm.createTable('documents', {
    document_id: { type: 'text', primaryKey: true },
    title: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    owner_id: { type: 'text', notNull: true, references: '"users"' },
    is_public: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // workflows table
  pgm.createTable('workflows', {
    workflow_id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    definition: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_by: { type: 'text', notNull: true, references: '"users"' },
    is_active: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // automations table
  pgm.createTable('automations', {
    automation_id: { type: 'text', primaryKey: true },
    workflow_id: { type: 'text', notNull: true, references: '"workflows"', onDelete: 'CASCADE' },
    trigger_type: { type: 'text', notNull: true },
    trigger_config: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    is_active: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // notifications table
  pgm.createTable('notifications', {
    notification_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    is_read: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // audit_logs table
  pgm.createTable('audit_logs', {
    log_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', references: '"users"' },
    action: { type: 'text', notNull: true },
    target_type: { type: 'text', notNull: true },
    target_id: { type: 'text' },
    details: { type: 'jsonb', default: pgm.func("'{}'::jsonb") },
    ip_address: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('audit_logs');
  pgm.dropTable('notifications');
  pgm.dropTable('automations');
  pgm.dropTable('workflows');
  pgm.dropTable('documents');
};
