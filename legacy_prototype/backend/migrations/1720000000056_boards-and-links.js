/* eslint-disable camelcase */

// Boards, and links as attachments.
//
// 1. LINKS. A node could only carry an upload or a typed note. Most of what a
//    user wants on a node already lives somewhere else — a Google Doc, a Drive
//    folder, a YouTube walkthrough, an image URL — and copying it in would be
//    wrong twice over (stale copy, and egress on every open). A link is a
//    mind_map_docs row with kind = 'link': `url` is the thing, `provider` says
//    how to show it (gdoc|gdrive|youtube|image|video|web). No bytes, no text.
//
// 2. BOARDS. A Kanban board is its own artifact, not a view of a mind map:
//    board columns are stages or groups the user names freely, and cards carry
//    dates, priority and tags that a study tree has no use for. What they DO
//    share is everything around the content — share links, files, links — so
//    board tables mirror the mind map ones rather than inventing new shapes.
//
//      boards             one board
//      board_columns      ordered columns
//      board_cards        ordered cards in a column
//      board_attachments  files, notes and links on a card (or the board)
//      board_shares       "anyone with the link" — same contract as 055
//
// RLS on, no policies, for every new table: the backend owns the role and
// bypasses it, Supabase's public roles are denied outright.

exports.up = async (pgm) => {
  // ── links on mind map nodes ──────────────────────────────────
  pgm.addColumns('mind_map_docs', {
    url: { type: 'text' },
    provider: { type: 'text' }
  });
  pgm.dropConstraint('mind_map_docs', 'mind_map_docs_kind_check');
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_kind_check',
    { check: "kind IN ('document', 'image', 'text', 'link')" });
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_link_has_url',
    { check: "kind <> 'link' OR url IS NOT NULL" });

  // ── boards ───────────────────────────────────────────────────
  pgm.createTable('boards', {
    board_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true, default: '' },
    description: { type: 'text', notNull: true, default: '' },
    // Where a board built from a mind map came from. Plain ref, no FK: the
    // board must outlive the map it was made from.
    source_map_id: { type: 'text' },
    // The tag vocabulary — [{label, color}] — so a tag keeps its colour on
    // every card and the picker can offer what the board already uses.
    tag_palette: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('boards', ['user_id', 'updated_at']);

  pgm.createTable('board_columns', {
    column_id: { type: 'text', primaryKey: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true, default: '' },
    color: { type: 'text' },
    order_index: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('board_columns', ['board_id', 'order_index']);

  pgm.createTable('board_cards', {
    card_id: { type: 'text', primaryKey: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    column_id: { type: 'text', notNull: true, references: '"board_columns"', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true, default: '' },
    summary: { type: 'text', notNull: true, default: '' },
    detail: { type: 'text', notNull: true, default: '' },
    tags: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") }, // [{label,color}]
    priority: { type: 'text' },
    start_date: { type: 'date' },
    end_date: { type: 'date' },
    color: { type: 'text' },
    order_index: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('board_cards', ['board_id']);
  pgm.createIndex('board_cards', ['column_id', 'order_index']);
  pgm.addConstraint('board_cards', 'board_cards_priority_check',
    { check: "priority IS NULL OR priority IN ('high', 'medium', 'low')" });
  pgm.addConstraint('board_cards', 'board_cards_dates_check',
    { check: 'start_date IS NULL OR end_date IS NULL OR end_date >= start_date' });

  // Same shape as mind_map_docs on purpose: the file-serving and link code is
  // shared, and only the parent columns differ.
  pgm.createTable('board_attachments', {
    attachment_id: { type: 'text', primaryKey: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    card_id: { type: 'text', references: '"board_cards"', onDelete: 'CASCADE' }, // NULL = board-level
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true, default: 'document' },
    filename: { type: 'text', notNull: true, default: '' },
    mimetype: { type: 'text', notNull: true, default: '' },
    size_bytes: { type: 'bigint', notNull: true, default: 0 },
    url: { type: 'text' },
    provider: { type: 'text' },
    extracted: { type: 'text', notNull: true, default: '' },
    char_count: { type: 'integer', notNull: true, default: 0 },
    data: { type: 'bytea' },
    order_index: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('board_attachments', ['board_id']);
  pgm.createIndex('board_attachments', ['card_id']);
  pgm.addConstraint('board_attachments', 'board_attachments_kind_check',
    { check: "kind IN ('document', 'image', 'text', 'link')" });
  pgm.addConstraint('board_attachments', 'board_attachments_link_has_url',
    { check: "kind <> 'link' OR url IS NOT NULL" });

  pgm.createTable('board_shares', {
    share_id: { type: 'text', primaryKey: true },
    token: { type: 'text', notNull: true, unique: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    include_docs: { type: 'boolean', notNull: true, default: true },
    expires_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    view_count: { type: 'integer', notNull: true, default: 0 },
    last_viewed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('board_shares', ['board_id']);

  for (const t of ['boards', 'board_columns', 'board_cards', 'board_attachments', 'board_shares']) {
    pgm.sql(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  }

  // ── agents that can look up Drive links and fill boards ──────
  // Plato fields "put the Duxbe POS spec on the POS card" in chat, so he gets
  // both; Rasha's resumes and cover letters tend to live in Drive. Drive is
  // names and links only (tools/DriveTool.js); boards is the user's own boards
  // (tools/BoardsTool.js).
  pgm.sql(`UPDATE agent_configs SET tools = tools || '["drive"]'::jsonb
            WHERE agent_id IN ('plato', 'rasha') AND NOT (tools ? 'drive')`);
  pgm.sql(`UPDATE agent_configs SET tools = tools || '["boards"]'::jsonb
            WHERE agent_id = 'plato' AND NOT (tools ? 'boards')`);
};

exports.down = async (pgm) => {
  pgm.sql(`UPDATE agent_configs
              SET tools = COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements(tools) t
                                     WHERE t NOT IN ('"drive"'::jsonb, '"boards"'::jsonb)), '[]'::jsonb)
            WHERE tools ? 'drive' OR tools ? 'boards'`);
  pgm.dropTable('board_shares');
  pgm.dropTable('board_attachments');
  pgm.dropTable('board_cards');
  pgm.dropTable('board_columns');
  pgm.dropTable('boards');

  // Links have no file and no text; there is nothing to fold them into.
  pgm.sql("DELETE FROM mind_map_docs WHERE kind = 'link'");
  pgm.dropConstraint('mind_map_docs', 'mind_map_docs_link_has_url');
  pgm.dropConstraint('mind_map_docs', 'mind_map_docs_kind_check');
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_kind_check',
    { check: "kind IN ('document', 'image', 'text')" });
  pgm.dropColumns('mind_map_docs', ['url', 'provider']);
};
