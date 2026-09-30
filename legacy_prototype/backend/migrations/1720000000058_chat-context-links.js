/* eslint-disable camelcase */

// A conversation can carry other conversations as context.
//
// The user picks earlier chats (Ctrl+K picker in the composer, or "Branch"
// on a Recent row) and the agent reads their transcripts before answering.
// The link belongs to the conversation, not the browser tab: it is stored
// here so every later turn — and a reopen from Recents on another device —
// keeps the same context, rather than only the first message seeing it.
//
// A plain text[] of session ids: they are not FKs because a session is not a
// row anywhere (ai_conversations holds its turns). Ownership is re-checked on
// every read, so an id that later points at nothing just drops out.

exports.up = async (pgm) => {
  pgm.addColumns('ai_session_meta', {
    context_sessions: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('ai_session_meta', ['context_sessions']);
};
