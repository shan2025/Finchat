/* eslint-disable camelcase */

// Sprint Z · Track A — Mind Map Studio
//
// Deliberately SEPARATE tables from `neural_maps`. The neural map answers
// "what does the system know and do" — a mesh of live system state, derived
// and read-only. A mind map answers "how should I understand this topic" — a
// user-authored tree with an order, collapsed branches, and hand-placed nodes.
// Sharing tables would force one of them to lie about the other: the neural
// map has no parent/child, and a mind map has no activation heatmap.
//
//   mind_maps       one map (a topic, a chat, a document, a graph slice)
//   mind_map_nodes  the hierarchy — parent_id IS the tree, not an edge table
//   mind_map_edges  cross-links ONLY (the "see also" strokes across branches)
//   mind_map_chats  node ↔ the scoped conversation opened about it
//
// The bridge that matters: mind_map_nodes.entity_id points at the living
// memory graph. A node that corresponds to a real entity can activate it
// (MemoryEngine.recordActivation), so studying a topic lights it up on the
// neural map heatmap. No FK — entities are merged and retired by the dream
// cycle, and a mind map must survive its subject being consolidated.

exports.up = async (pgm) => {
  pgm.createTable('mind_maps', {
    map_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true, default: '' },
    topic: { type: 'text', notNull: true, default: '' },
    // where this map came from, so it can be regenerated or traced back
    source_type: { type: 'text', notNull: true, default: 'topic' }, // topic|chat|document|graph|mission
    source_ref: { type: 'text' },   // sessionId | attachmentId | entityId | missionId
    layout: { type: 'text', notNull: true, default: 'radial' },     // radial|tree|freeform
    theme: { type: 'text', notNull: true, default: 'warm' },
    meta: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") }, // provenance: model, tokens, generated_at
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('mind_maps', ['user_id', 'updated_at']);
  pgm.addConstraint('mind_maps', 'mind_maps_source_type_check',
    { check: "source_type IN ('topic', 'chat', 'document', 'graph', 'mission')" });
  pgm.addConstraint('mind_maps', 'mind_maps_layout_check',
    { check: "layout IN ('radial', 'tree', 'freeform')" });

  pgm.createTable('mind_map_nodes', {
    node_id: { type: 'text', primaryKey: true },
    map_id: { type: 'text', notNull: true, references: '"mind_maps"', onDelete: 'CASCADE' },
    // Self-reference: deleting a node takes its whole subtree with it, which is
    // what "delete this branch" means to the user.
    parent_id: { type: 'text', references: '"mind_map_nodes"', onDelete: 'CASCADE' },
    label: { type: 'text', notNull: true, default: '' },
    summary: { type: 'text', notNull: true, default: '' },  // one line, shown on the node
    detail: { type: 'text', notNull: true, default: '' },   // the panel body
    node_type: { type: 'text', notNull: true, default: 'branch' }, // root|branch|leaf|question|task
    color: { type: 'text' },
    icon: { type: 'text' },
    collapsed: { type: 'boolean', notNull: true, default: false },
    x: { type: 'real' },  // NULL until the user drags it — the layout owns position otherwise
    y: { type: 'real' },
    order_index: { type: 'integer', notNull: true, default: 0 },
    // Bridge to the living memory graph. Plain ref, no FK: the dream cycle
    // merges and retires entities, and a map must outlive that.
    entity_id: { type: 'text' },
    source_meta: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('mind_map_nodes', ['map_id']);
  pgm.createIndex('mind_map_nodes', ['map_id', 'parent_id']);
  pgm.createIndex('mind_map_nodes', ['entity_id']);
  pgm.addConstraint('mind_map_nodes', 'mind_map_nodes_type_check',
    { check: "node_type IN ('root', 'branch', 'leaf', 'question', 'task')" });
  // A node cannot be its own parent. Deeper cycles are prevented in the service
  // layer (a DB-level check would need a recursive trigger for little gain).
  pgm.addConstraint('mind_map_nodes', 'mind_map_nodes_no_self_parent',
    { check: 'parent_id IS NULL OR parent_id <> node_id' });

  // Cross-links only. The hierarchy lives in parent_id — putting it here too
  // would give two sources of truth for the same tree.
  pgm.createTable('mind_map_edges', {
    edge_id: { type: 'text', primaryKey: true },
    map_id: { type: 'text', notNull: true, references: '"mind_maps"', onDelete: 'CASCADE' },
    from_node: { type: 'text', notNull: true, references: '"mind_map_nodes"', onDelete: 'CASCADE' },
    to_node: { type: 'text', notNull: true, references: '"mind_map_nodes"', onDelete: 'CASCADE' },
    label: { type: 'text', notNull: true, default: '' },
    style: { type: 'text', notNull: true, default: 'dashed' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('mind_map_edges', ['map_id']);
  pgm.addConstraint('mind_map_edges', 'mind_map_edges_unique_pair',
    { unique: ['map_id', 'from_node', 'to_node'] });

  // One scoped conversation per node ("Ask about this").
  pgm.createTable('mind_map_chats', {
    id: { type: 'serial', primaryKey: true },
    map_id: { type: 'text', notNull: true, references: '"mind_maps"', onDelete: 'CASCADE' },
    node_id: { type: 'text', notNull: true, references: '"mind_map_nodes"', onDelete: 'CASCADE' },
    session_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('mind_map_chats', ['map_id']);
  pgm.addConstraint('mind_map_chats', 'mind_map_chats_node_unique', { unique: ['node_id'] });

  // Match every other table in this database: RLS enabled with NO policies.
  // That denies Supabase's anon/authenticated PostgREST roles outright, while
  // the backend — which connects as the owning role and so bypasses RLS —
  // keeps working. Ownership is enforced in the route layer (requireOwnedMap),
  // exactly as neuralMap.js does it. Without this the new tables would be the
  // only ones in the schema reachable straight from the public API.
  for (const t of ['mind_maps', 'mind_map_nodes', 'mind_map_edges', 'mind_map_chats']) {
    pgm.sql(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  }
};

exports.down = async (pgm) => {
  pgm.dropTable('mind_map_chats');
  pgm.dropTable('mind_map_edges');
  pgm.dropTable('mind_map_nodes');
  pgm.dropTable('mind_maps');
};
