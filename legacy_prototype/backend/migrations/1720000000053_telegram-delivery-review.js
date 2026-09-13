/* eslint-disable camelcase */

// Record what Telegram was actually sent, and why.
//
// Every mission report and briefing used to go to Telegram word for word. In
// the week to 13 Sep 2026 that was 63 reports and ~402,000 characters split
// into ~130 message bubbles — the 6-hourly crypto brief alone was 23 of them,
// and 16 reports announced that their own data was "unavailable". Nothing
// looked at a report before it went out, and the delivery log could only say
// "sent", so there was no way to see afterwards what had landed on the phone.
//
// Telegram now gets a short card written by services/telegramEditor.js, which
// also decides whether the report is worth sending at all. These two columns
// make that decision auditable:
//
//   payload    — the exact text that went out (or would have, for a held one)
//   importance — the 1–5 score the decision was made on
//
// status gains the value 'held' (no CHECK constraint on the column, so no DDL
// is needed for that); `detail` carries the reviewer's one-line reason.

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE notification_deliveries
      ADD COLUMN IF NOT EXISTS payload text,
      ADD COLUMN IF NOT EXISTS importance smallint
  `);
  // The reviewer compares each report with the last card sent on the same
  // topic, so it can hold one that says nothing new.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS notification_deliveries_user_channel_created_idx
      ON notification_deliveries (user_id, channel, created_at DESC)
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS notification_deliveries_user_channel_created_idx');
  pgm.sql(`
    ALTER TABLE notification_deliveries
      DROP COLUMN IF EXISTS importance,
      DROP COLUMN IF EXISTS payload
  `);
};
