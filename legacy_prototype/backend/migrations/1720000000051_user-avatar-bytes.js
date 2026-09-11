/* eslint-disable camelcase */

// A profile photo you can actually set.
//
// `users.avatar_url` has existed since the first schema, and Google sign-in
// fills it with the picture from the identity token — but nothing in the app
// ever wrote it for anyone else, so a password-account user had initials on
// their card and no control anywhere to change that. POST /profile/avatar was
// already there, taking a URL string; what was missing was somewhere to put an
// uploaded FILE.
//
// The bytes live here rather than on disk for the reason migration 043 gave for
// chat images: Render's filesystem is ephemeral, so a disk-backed avatar
// disappears on the next deploy.
//
// They also live in their own table rather than in a data: URL inside
// `users.avatar_url`, which would have needed no migration at all. Every page
// load calls /api/auth/me, and that route does `SELECT *` on this row — so an
// inlined photo would cross the Postgres→backend hop on every page view of
// every session, which is precisely the hop that put this project 258% over its
// egress allowance in September. Out here, `avatar_url` stays a ~60-character
// path, /api/auth/me stays small, and the image is fetched once and then served
// from the browser's cache (the path carries a ?v= stamp, so a new photo busts
// that cache and an unchanged one never re-reads the row).
//
// Same RLS posture as the other user-data tables: enabled with no policies, so
// Supabase's anon and authenticated roles are denied outright and only the
// backend, connecting as the owner, can read it.

exports.up = async (pgm) => {
  pgm.createTable('user_avatars', {
    // One photo per person: re-uploading replaces it, so there is no id to leak
    // and no orphan rows to reap.
    user_id: { type: 'text', primaryKey: true, references: '"users"', onDelete: 'CASCADE' },
    mime: { type: 'text', notNull: true },
    size_bytes: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.sql('ALTER TABLE "user_avatars" ENABLE ROW LEVEL SECURITY');

  // Move the photos that are already inlined in the users row.
  //
  // An earlier uploader (the settings panel inside the chat page) posted the
  // picked file as a base64 data: URL with no resizing at all, so one account
  // is carrying 3.3MB of base64 in `users.avatar_url` — re-read, in full, by
  // every /api/auth/me call, which is every page load of every page it makes.
  // Decoding it into bytes here is both the format change and the fix.
  pgm.sql(`
    INSERT INTO user_avatars (user_id, mime, size_bytes, data, updated_at)
    SELECT user_id,
           substring(avatar_url from 6 for position(';' in avatar_url) - 6),
           octet_length(decode(substring(avatar_url from position(',' in avatar_url) + 1), 'base64')),
           decode(substring(avatar_url from position(',' in avatar_url) + 1), 'base64'),
           NOW()
      FROM users
     WHERE avatar_url LIKE 'data:image/%;base64,%'
    ON CONFLICT (user_id) DO NOTHING
  `);

  // Point the row at the serving route instead. The ?v= stamp matches what
  // routes/auth.js writes, so the two agree on what busts a browser cache.
  pgm.sql(`
    UPDATE users u
       SET avatar_url = '/api/auth/avatar/' || u.user_id
                        || '?v=' || (extract(epoch from a.updated_at) * 1000)::bigint
      FROM user_avatars a
     WHERE a.user_id = u.user_id
       AND u.avatar_url LIKE 'data:%'
  `);
};

exports.down = async (pgm) => {
  // Put the bytes back where they were, so a rollback does not take anyone's
  // photo with it.
  pgm.sql(`
    UPDATE users u
       SET avatar_url = 'data:' || a.mime || ';base64,'
                        || replace(encode(a.data, 'base64'), E'\\n', '')
      FROM user_avatars a
     WHERE a.user_id = u.user_id
       AND u.avatar_url LIKE '/api/auth/avatar/%'
  `);
  pgm.dropTable('user_avatars');
};
