/* eslint-disable camelcase */

// Give users a real handle.
//
// The signup form collected only "Full Name", which has no uniqueness of any
// kind — so there was nothing an "already taken" message could truthfully be
// about, and two people legitimately named the same thing must both be able to
// register. A separate `username` carries the uniqueness; `name` stays
// free-form and non-unique.
//
// Nullable on purpose. POST /api/auth/wallet creates accounts with no email and
// no signup form, and Postgres treats NULLs as distinct in a unique index, so
// those rows neither collide nor block the constraint. The register route
// always supplies one.

exports.up = async (pgm) => {
  pgm.addColumn('users', {
    username: { type: 'text' }
  });

  // Backfill from the email local-part, falling back to the display name, so
  // the 27 existing accounts come out the far side with usable handles rather
  // than a column of NULLs that the profile UI would have to special-case.
  //
  // The shaping mirrors the format rules the register route enforces:
  // [a-z0-9_], letter-initial, 3–20 chars. Truncating the base to 17 leaves
  // room for the collision suffix without breaching the 20-char ceiling.
  pgm.sql(`
    WITH candidate AS (
      SELECT user_id,
             COALESCE(
               NULLIF(regexp_replace(lower(split_part(COALESCE(email, ''), '@', 1)), '[^a-z0-9_]', '', 'g'), ''),
               NULLIF(regexp_replace(lower(COALESCE(name, '')),                      '[^a-z0-9_]', '', 'g'), ''),
               'user'
             ) AS raw
      FROM users
      WHERE username IS NULL
    ),
    shaped AS (
      SELECT user_id,
             -- rpad truncates when the input is already longer, so it is only
             -- safe to reach for once the length is known to be short
             CASE WHEN length(t) < 3 THEN rpad(t, 3, '0') ELSE t END AS base
      FROM (
        SELECT user_id,
               left(CASE WHEN raw ~ '^[a-z]' THEN raw ELSE 'u' || raw END, 17) AS t
        FROM candidate
      ) s
    ),
    numbered AS (
      SELECT user_id, base,
             ROW_NUMBER() OVER (PARTITION BY base ORDER BY user_id) AS rn
      FROM shaped
    )
    UPDATE users u
    SET username = CASE WHEN n.rn = 1 THEN n.base ELSE n.base || n.rn::text END
    FROM numbered n
    WHERE n.user_id = u.user_id
  `);

  // Case-insensitive: "Shan" and "shan" are the same handle. The register and
  // availability routes lowercase before storing, so this is belt-and-braces
  // against anything that writes the column directly.
  pgm.sql('CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username))');
};

exports.down = async (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS users_username_lower_key');
  pgm.dropColumn('users', 'username');
};
