/* eslint-disable camelcase */

// Gmail for Rasha — read-only, and only the mail a job board sent.
//
// The existing Google integration is sign-in ONLY: googleAuth.js verifies an ID
// token's signature. There is no authorization-code flow and no refresh token,
// so nothing in the system can call a Google API on the user's behalf. This adds
// the storage for that.
//
// One row per user. The refresh token is a long-lived key to a mailbox, so it is
// stored sealed (AES-256-GCM, services/secretBox.js) rather than in plaintext —
// the column is useless to anyone who reads the table without the key.
//
// `scope` is recorded as granted, not as requested: Google may return fewer
// scopes than were asked for if the user unticks one on the consent screen, and
// the tool checks what is actually held before calling the API.

exports.up = async (pgm) => {
  pgm.createTable('google_oauth_tokens', {
    user_id: { type: 'text', primaryKey: true, references: '"users"', onDelete: 'CASCADE' },
    // Which mailbox this grant is for. Shown on the Settings page so a user who
    // has several Google accounts can see which one they connected.
    google_email: { type: 'text' },
    refresh_token_enc: { type: 'text', notNull: true },
    // Access tokens live an hour. Cached so a burst of tool calls inside one
    // mission run does not mint a new one per call.
    access_token_enc: { type: 'text' },
    access_expires_at: { type: 'timestamptz' },
    scope: { type: 'text', notNull: true, default: '' },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Surfaced on the Settings page: "last read 2 hours ago" is how a user
    // notices an integration doing something they did not expect.
    last_used_at: { type: 'timestamptz' }
  });

  // Same posture as every other user-data table here: RLS on, no policies, so
  // Supabase's anon/authenticated roles are denied outright and only the backend
  // (which connects as the owner) can read it.
  pgm.sql('ALTER TABLE "google_oauth_tokens" ENABLE ROW LEVEL SECURITY');

  // Rasha alone gets the tool. Idempotent append — see migration 037.
  pgm.sql(`
    UPDATE agent_configs
       SET tools = tools || '["gmail"]'::jsonb
     WHERE agent_id = 'rasha'
       AND NOT (tools @> '["gmail"]'::jsonb);
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    UPDATE agent_configs
       SET tools = COALESCE(
             (SELECT jsonb_agg(x) FROM jsonb_array_elements(tools) x WHERE x <> '"gmail"'::jsonb),
             '[]'::jsonb)
     WHERE agent_id = 'rasha';
  `);
  pgm.dropTable('google_oauth_tokens');
};
