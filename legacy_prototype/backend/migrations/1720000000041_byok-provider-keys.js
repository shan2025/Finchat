/* eslint-disable camelcase */

// BYOK — bring your own AI. FinChat becomes a harness: the tools, knowledge,
// agents, missions and learning are ours; the user brings the fuel (an API key
// for the provider of their choice). This is the storage plus the referral
// plumbing that decides who may spend the shared pool and who must BYOK.
//
// Three access tiers, DERIVED rather than stored, so there is no fourth column
// to keep in sync with reality (see services/UserKeys.js):
//   • byok     — has at least one active key → runs on their OWN key, no cap.
//   • referred — joined via someone's referral code → may use the SHARED pool
//                (our system keys) up to a generous daily cap.
//   • free     — default → a small lifetime trial on the shared pool, then must
//                connect their own key.
//
// A provider key is a live credential that spends money / quota. It is stored
// SEALED (AES-256-GCM, services/secretBox.js) exactly like the Google refresh
// token in migration 040 — the column is useless to anyone who reads the table
// without the key. `key_last4` is the only part ever shown to the client.

exports.up = async (pgm) => {
  pgm.createTable('user_provider_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    // groq | gemini | deepseek | mistral | cerebras | openrouter
    provider: { type: 'text', notNull: true },
    key_enc: { type: 'text', notNull: true },
    // Display only — "sk-••••a1b2" is what the Settings page renders.
    key_last4: { type: 'text', notNull: true },
    label: { type: 'text' },
    is_active: { type: 'boolean', notNull: true, default: true },
    // Result of the last live validation. Surfaced as a green/red dot.
    last_ok_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // One key per provider per user — reconnecting replaces rather than piling up.
  pgm.addConstraint('user_provider_keys', 'user_provider_keys_user_provider_uniq',
    { unique: ['user_id', 'provider'] });

  // Same posture as every other user-data table: RLS on, no policies, so
  // Supabase's anon/authenticated roles are denied and only the backend (which
  // connects as the owner) can read it.
  pgm.sql('ALTER TABLE "user_provider_keys" ENABLE ROW LEVEL SECURITY');

  // Referral plumbing on users. `referral_code` is every user's own shareable
  // code; `referred_by` records whose code they signed up with (which is what
  // lifts them from `free` to `referred`).
  pgm.addColumns('users', {
    referral_code: { type: 'text' },
    referred_by: { type: 'text', references: '"users"', onDelete: 'SET NULL' }
  });

  // Backfill a stable code for everyone who already exists.
  pgm.sql(`
    UPDATE users
       SET referral_code = upper(substr(md5(random()::text || user_id || clock_timestamp()::text), 1, 8))
     WHERE referral_code IS NULL;
  `);

  // Codes must be unique to be a lookup key. Partial so nulls (should be none
  // after the backfill, but new rows are filled by the app) don't collide.
  pgm.sql('CREATE UNIQUE INDEX users_referral_code_uniq ON users (referral_code) WHERE referral_code IS NOT NULL');
};

exports.down = async (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS users_referral_code_uniq');
  pgm.dropColumns('users', ['referral_code', 'referred_by']);
  pgm.dropTable('user_provider_keys');
};
