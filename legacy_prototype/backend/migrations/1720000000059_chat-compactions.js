/* eslint-disable camelcase */

// Compacted summaries of conversations that get linked into other chats.
//
// Linking a chat used to paste its last few thousand characters into every
// turn; anything earlier was simply lost. Now the whole conversation is
// compacted once by the model into a dense summary, and that summary is what
// rides along. It is cached here because it is sent on every turn of every
// chat it is linked into — recomputing it per message would be one extra LLM
// call per send.
//
//   turn_count      how many turns the summary covers; when the source chat
//                   grows past it, only the new turns are folded in
//   ingested_at     when the summary was fed to the knowledge graph (NULL =
//                   not yet / failed), so each version is learned once

exports.up = async (pgm) => {
  pgm.createTable('chat_compactions', {
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    session_id: { type: 'text', notNull: true },
    title: { type: 'text' },
    persona: { type: 'text' },
    turn_count: { type: 'integer', notNull: true, default: 0 },
    summary: { type: 'text', notNull: true },
    model: { type: 'text' },
    ingested_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('chat_compactions', 'chat_compactions_pkey', { primaryKey: ['user_id', 'session_id'] });
  pgm.sql('ALTER TABLE "chat_compactions" ENABLE ROW LEVEL SECURITY');
};

exports.down = async (pgm) => {
  pgm.dropTable('chat_compactions');
};
