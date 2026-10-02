/* eslint-disable camelcase */

// Public Telegram subscribers and the general daily edition.
//
// Until now the bot only learned a chat id while someone was linking from
// Settings; anybody who found the bot and pressed Start was never recorded, and
// the newsletter (migration 060) is built from ONE user's own reports, so there
// was nothing to send them anyway. services/telegramBot.js now reads every
// message the bot receives, and services/newsletter/public.js builds one
// general market edition a day for everyone who subscribed.
//
// 1. telegram_subscribers — one row per chat that pressed Start. active=false
//    after /stop or when Telegram says the bot was blocked; /start again
//    reactivates. last_sent_day is CLAIMED before a send (UPDATE ... RETURNING),
//    so overlapping cron ticks cannot send the same chat two PDFs.
//
// 2. telegram_link_starts — "/start <code>" messages from the Settings link
//    flow. The bot poller consumes every update now, so the code it saw has to
//    be handed to routes/settings.js through the DB rather than re-read from
//    Telegram (any process may have been the one that read it).
//
// 3. public_newsletters — one row per IST day: the edited markdown (re-rendered
//    on demand, no LLM), the Telegram file_id after the first upload so every
//    later send reuses it, and sent/failed counters.

exports.up = async (pgm) => {
  pgm.createTable('telegram_subscribers', {
    chat_id: { type: 'text', primaryKey: true },
    chat_type: { type: 'text' },                 // private | group | supergroup | channel
    username: { type: 'text' },
    first_name: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    subscribed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    unsubscribed_at: { type: 'timestamptz' },
    last_sent_day: { type: 'date' },
    last_error: { type: 'text' }
  });
  pgm.createIndex('telegram_subscribers', ['active', 'last_sent_day']);
  pgm.sql('ALTER TABLE "telegram_subscribers" ENABLE ROW LEVEL SECURITY');

  pgm.createTable('telegram_link_starts', {
    code: { type: 'text', primaryKey: true },
    chat_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.sql('ALTER TABLE "telegram_link_starts" ENABLE ROW LEVEL SECURITY');

  pgm.createTable('public_newsletters', {
    day: { type: 'date', primaryKey: true },
    status: { type: 'text', notNull: true, default: 'building' }, // building | ready | empty | failed
    detail: { type: 'text' },
    title: { type: 'text' },
    markdown: { type: 'text' },
    source_count: { type: 'integer', notNull: true, default: 0 },
    pages: { type: 'integer' },
    file_id: { type: 'text' },
    sent_count: { type: 'integer', notNull: true, default: 0 },
    failed_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.sql('ALTER TABLE "public_newsletters" ENABLE ROW LEVEL SECURITY');
};

exports.down = async (pgm) => {
  pgm.dropTable('public_newsletters');
  pgm.dropTable('telegram_link_starts');
  pgm.dropTable('telegram_subscribers');
};
