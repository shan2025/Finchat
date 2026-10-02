/* eslint-disable camelcase */

// Temporal knowledge graph + hybrid (lexical + vector) recall.
//
// entity_edges gain a validity interval. An edge is a fact ("the user prefers
// short answers", "the user holds TSLA"); when a later exchange says it is no
// longer true the edge is closed (valid_to) rather than deleted or left
// standing beside its contradiction. Recall reads only open edges; the closed
// ones are the fact's history.
//
//   valid_from          when the fact became true (stated date, else first learned)
//   valid_to            when it stopped being true; NULL = still true
//   invalidated_at      when the system learned it had stopped (system time)
//   invalidation_reason the model's one-line reason, shown in the node history
//
// The (from, to, type, user) uniqueness moves to OPEN edges only, so a fact
// that was closed and later becomes true again gets a new interval instead of
// silently reopening the old one.
//
// entities.embedding / memories.embedding hold vectors for hybrid recall:
// anchors and procedural notes are found by meaning as well as by shared words.
// Same 768-d space as config/embeddings.js. No ANN index yet: every query is
// filtered to one user's rows, where an exact scan is both accurate and cheap,
// and a post-filtered HNSW scan can return fewer rows than asked for.
//
// DEPLOY ORDER: run this before pushing the code that uses it. The new code's
// ON CONFLICT names the partial index; the old code's ON CONFLICT cannot match
// it, so co-mention edges from executions are skipped (logged, not fatal) in
// the window between migrating and deploying.

exports.up = async (pgm) => {
  pgm.addColumns('entity_edges', {
    valid_from: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    valid_to: { type: 'timestamptz' },
    invalidated_at: { type: 'timestamptz' },
    invalidation_reason: { type: 'text' }
  });
  // Existing facts have been true since they were first learned.
  pgm.sql(`UPDATE entity_edges SET valid_from = created_at`);

  pgm.dropConstraint('entity_edges', 'entity_edges_unique_triple', { ifExists: true });
  pgm.createIndex('entity_edges', ['from_entity_id', 'to_entity_id', 'edge_type', 'user_id'], {
    name: 'entity_edges_open_unique',
    unique: true,
    where: 'valid_to IS NULL'
  });
  pgm.createIndex('entity_edges', ['user_id', 'edge_type'], {
    name: 'entity_edges_open_by_user',
    where: 'valid_to IS NULL'
  });

  pgm.addColumns('entities', { embedding: { type: 'vector(768)' } });
  pgm.addColumns('memories', { embedding: { type: 'vector(768)' } });
};

exports.down = async (pgm) => {
  pgm.dropColumns('memories', ['embedding']);
  pgm.dropColumns('entities', ['embedding']);
  pgm.dropIndex('entity_edges', [], { name: 'entity_edges_open_by_user' });
  pgm.dropIndex('entity_edges', [], { name: 'entity_edges_open_unique' });
  // History rows would collide with their reopened successors under the old
  // full constraint; they cannot be represented without the interval columns.
  pgm.sql(`DELETE FROM entity_edges WHERE valid_to IS NOT NULL`);
  pgm.addConstraint('entity_edges', 'entity_edges_unique_triple',
    { unique: ['from_entity_id', 'to_entity_id', 'edge_type', 'user_id'] });
  pgm.dropColumns('entity_edges', ['valid_from', 'valid_to', 'invalidated_at', 'invalidation_reason']);
};
