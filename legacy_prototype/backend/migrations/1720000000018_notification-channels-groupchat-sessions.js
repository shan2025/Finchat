/* eslint-disable camelcase */

// Sprint 8 — Notification channels, agent group chat, session metadata.
// - notifications.link: deep-link the bell items to the page they concern
// - notification_preferences: per-user channel toggles + destinations
//   (in-app, email, WhatsApp, Telegram, SMS, mobile/web push)
// - notification_deliveries: audit log of every external dispatch attempt
// - ai_session_meta: custom titles + soft-delete for 1:1 chat sessions
// - group_chats / group_chat_members / group_chat_messages: the multi-agent
//   discussion rooms (user + N agents, agents can reply to each other)

exports.up = async (pgm) => {
  pgm.addColumn('notifications', {
    link: { type: 'text' } // relative frontend URL, e.g. finchat_dashboard.html?execution=x
  });

  pgm.createTable('notification_preferences', {
    user_id: { type: 'text', primaryKey: true, references: '"users"', onDelete: 'CASCADE' },
    channel_inapp: { type: 'boolean', notNull: true, default: true },
    channel_email: { type: 'boolean', notNull: true, default: false },
    email_to: { type: 'text' },
    channel_whatsapp: { type: 'boolean', notNull: true, default: false },
    whatsapp_to: { type: 'text' },          // E.164 phone
    channel_telegram: { type: 'boolean', notNull: true, default: false },
    telegram_chat_id: { type: 'text' },
    channel_sms: { type: 'boolean', notNull: true, default: false },
    sms_to: { type: 'text' },               // E.164 phone
    channel_push: { type: 'boolean', notNull: true, default: false },
    push_subscription: { type: 'jsonb' },   // Web Push subscription JSON
    muted_types: { type: 'jsonb', notNull: true, default: '[]' }, // e.g. ["debate"]
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('notification_deliveries', {
    delivery_id: { type: 'text', primaryKey: true },
    notification_id: { type: 'text' },
    user_id: { type: 'text', notNull: true },
    channel: { type: 'text', notNull: true },  // email|whatsapp|telegram|sms|push
    destination: { type: 'text' },
    status: { type: 'text', notNull: true },   // sent|failed|skipped|unconfigured
    detail: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('notification_deliveries', ['user_id', 'created_at']);

  pgm.createTable('ai_session_meta', {
    session_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    title: { type: 'text' },
    deleted: { type: 'boolean', notNull: true, default: false },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('ai_session_meta', ['user_id']);

  pgm.createTable('group_chats', {
    group_id: { type: 'text', primaryKey: true },
    owner_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('group_chats', ['owner_id']);

  pgm.createTable('group_chat_members', {
    id: { type: 'serial', primaryKey: true },
    group_id: { type: 'text', notNull: true, references: '"group_chats"', onDelete: 'CASCADE' },
    member_type: { type: 'text', notNull: true }, // 'agent' | 'user'
    member_id: { type: 'text', notNull: true },   // agent_id (aurelius…) or user_id
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('group_chat_members', 'group_chat_members_unique',
    { unique: ['group_id', 'member_id'] });

  pgm.createTable('group_chat_messages', {
    message_id: { type: 'text', primaryKey: true },
    group_id: { type: 'text', notNull: true, references: '"group_chats"', onDelete: 'CASCADE' },
    sender_type: { type: 'text', notNull: true }, // 'user' | 'agent' | 'system'
    sender_id: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    meta: { type: 'jsonb', notNull: true, default: '{}' }, // provider/model/executionId/taskFor…
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('group_chat_messages', ['group_id', 'created_at']);
};

exports.down = async (pgm) => {
  pgm.dropTable('group_chat_messages');
  pgm.dropTable('group_chat_members');
  pgm.dropTable('group_chats');
  pgm.dropTable('ai_session_meta');
  pgm.dropTable('notification_deliveries');
  pgm.dropTable('notification_preferences');
  pgm.dropColumn('notifications', 'link');
};
