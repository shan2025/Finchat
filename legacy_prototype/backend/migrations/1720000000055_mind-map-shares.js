/* eslint-disable camelcase */

// Mind maps become shareable by link.
//
// A share is a capability, the way a "anyone with the link" document is: the
// token IS the permission, so it is 256 bits of randomness and nothing else —
// no map id, no user id, nothing a reader could walk to a neighbouring map.
// The token is stored as-is (not hashed) because the owner needs to copy the
// same link again next week; revoking it is how a leaked link is handled.
//
// A share is LIVE, not a snapshot: the reader sees the map as it is now. That
// is what "I sent you my map" means, and it keeps one copy of every document
// instead of one per link.
//
//   include_docs  false → the tree only; every document route answers 404
//   expires_at    NULL  → until revoked
//   revoked_at    set   → dead; kept for the owner's history, never reused
//
// Node conversations are never reachable through a share. They are the
// owner's chat history, not part of the map.

exports.up = async (pgm) => {
  pgm.createTable('mind_map_shares', {
    share_id: { type: 'text', primaryKey: true },
    token: { type: 'text', notNull: true, unique: true },
    map_id: { type: 'text', notNull: true, references: '"mind_maps"', onDelete: 'CASCADE' },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    include_docs: { type: 'boolean', notNull: true, default: true },
    expires_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    view_count: { type: 'integer', notNull: true, default: 0 },
    last_viewed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('mind_map_shares', ['map_id']);

  // Same posture as every other table: RLS on, no policies. The backend owns
  // the role and bypasses it; Supabase's public roles are denied outright.
  pgm.sql('ALTER TABLE "mind_map_shares" ENABLE ROW LEVEL SECURITY');
};

exports.down = async (pgm) => {
  pgm.dropTable('mind_map_shares');
};
