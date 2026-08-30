/* eslint-disable camelcase */

// Chat attachments that survive a reload — and a redeploy.
//
// Uploads were written to backend/uploads/ and served by `express.static` with
// no auth at all, so a sent screenshot was only ever visible in the browser tab
// that sent it: reopening the conversation showed a grey file card, because the
// message row keeps a file NAME and nothing else. Handing the client a
// /uploads/<name> URL would have fixed the display by making every user's
// uploads fetchable by anyone who could guess a filename, which is not a fix.
//
// The bytes live HERE rather than on disk because Render's filesystem is
// ephemeral: it is wiped on every deploy and every cold start, so a
// disk-backed history would quietly lose its images on the next push. Multer
// already caps an upload at 10MB, and the column is only written for images —
// documents are extracted to text and the bytes discarded, so this table stores
// what a person needs to SEE, not everything they ever uploaded.
//
// Served by GET /api/ai-chat/attachment/:id, which requires a session and
// matches user_id. Same RLS posture as every other user-data table: on, no
// policies, so Supabase's anon/authenticated roles are denied outright and only
// the backend (connecting as owner) reads it.

exports.up = async (pgm) => {
  pgm.createTable('chat_attachments', {
    attachment_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    // Filled in by /send once the message it belongs to exists. An upload the
    // user never sent stays unlinked and is reapable.
    session_id: { type: 'text' },
    message_id: { type: 'uuid' },
    original_name: { type: 'text', notNull: true },
    mime: { type: 'text', notNull: true },
    size_bytes: { type: 'integer', notNull: true },
    // 'image' | 'document' | 'file' — mirrors extractFromUpload's `kind`.
    kind: { type: 'text', notNull: true, default: 'file' },
    // Images only; null for documents (their text is already in the message).
    data: { type: 'bytea' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // The history route looks these up one message at a time.
  pgm.createIndex('chat_attachments', 'message_id');
  pgm.createIndex('chat_attachments', ['user_id', 'created_at']);

  pgm.sql('ALTER TABLE "chat_attachments" ENABLE ROW LEVEL SECURITY');
};

exports.down = async (pgm) => {
  pgm.dropTable('chat_attachments');
};
