/* eslint-disable camelcase */

// Sprint Z · Track A · A5 — Documents on mind maps
//
// A mind map node can carry the source material it was built from or that the
// learner wants attached to it: "these three papers are what this branch is
// about". The extracted text lives on the row so answering a question about a
// node never has to re-parse a PDF.
//
//   map_id NULL  → staged: uploaded before a map exists (generate-from-documents)
//   node_id NULL → a map-level source, shown on the root node's overview
//   both set     → attached to that specific node
//
// The blob itself stays on disk under backend/uploads (persistUpload), served by
// the existing /uploads static mount; only stored_name is kept here. Deleting a
// map cascades the rows — the file on disk is left alone deliberately, because
// the same upload may be referenced from a chat message's audit trail.

exports.up = async (pgm) => {
  pgm.createTable('mind_map_docs', {
    doc_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    // Nullable so a document can be uploaded and read BEFORE the map it will
    // generate exists. Staged rows are adopted by the map once it is created.
    map_id: { type: 'text', references: '"mind_maps"', onDelete: 'CASCADE' },
    node_id: { type: 'text', references: '"mind_map_nodes"', onDelete: 'CASCADE' },
    filename: { type: 'text', notNull: true },
    mimetype: { type: 'text', notNull: true, default: '' },
    size_bytes: { type: 'bigint', notNull: true, default: 0 },
    // Name under backend/uploads. NULL when the write failed — the extracted
    // text is still useful, so a failed persist must not lose the upload.
    stored_name: { type: 'text' },
    kind: { type: 'text', notNull: true, default: 'document' }, // document|image
    // What the agent actually reads. Capped at extraction time (MAX_EXTRACT_CHARS).
    extracted: { type: 'text', notNull: true, default: '' },
    char_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('mind_map_docs', ['user_id', 'created_at']);
  pgm.createIndex('mind_map_docs', ['map_id']);
  pgm.createIndex('mind_map_docs', ['node_id']);
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_kind_check',
    { check: "kind IN ('document', 'image')" });
  // A node-scoped doc must know which map it belongs to, or the map-level
  // source list and the per-node list disagree about the same row.
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_node_needs_map',
    { check: 'node_id IS NULL OR map_id IS NOT NULL' });

  // Same posture as migration 023: RLS on, no policies. Denies Supabase's
  // anon/authenticated roles outright; the backend connects as the owner and
  // bypasses RLS, with ownership enforced in the route layer.
  pgm.sql('ALTER TABLE "mind_map_docs" ENABLE ROW LEVEL SECURITY');
};

exports.down = async (pgm) => {
  pgm.dropTable('mind_map_docs');
};
