/* eslint-disable camelcase */

// The daily Telegram newsletter.
//
// Telegram gets very little in real time now — services/telegramEditor.js
// holds anything under 4/5, which in practice is ~80% of reports. The
// newsletter is where the held material goes: once a day the day's briefings
// and mission reports are edited into one issue, rendered in the app's card
// style as a PDF, and sent to each linked Telegram chat.
//
// One row per user per (IST) day. The row is claimed BEFORE the work starts
// (INSERT ... ON CONFLICT DO NOTHING), so overlapping cron ticks cannot send
// the same issue twice; a failed attempt stays as status='failed' with the
// reason, and the Settings "send now" path may overwrite it.

exports.up = async (pgm) => {
  pgm.createTable('newsletters', {
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    day: { type: 'date', notNull: true },
    status: { type: 'text', notNull: true, default: 'building' }, // building | sent | failed | empty
    detail: { type: 'text' },
    title: { type: 'text' },
    markdown: { type: 'text' },
    source_count: { type: 'integer', notNull: true, default: 0 },
    pages: { type: 'integer' },
    bytes: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' }
  });
  pgm.addConstraint('newsletters', 'newsletters_pkey', { primaryKey: ['user_id', 'day'] });
  pgm.sql('ALTER TABLE "newsletters" ENABLE ROW LEVEL SECURITY');
};

exports.down = async (pgm) => {
  pgm.dropTable('newsletters');
};
