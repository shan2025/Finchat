/* eslint-disable camelcase */

// Neural Map — a live, navigable graph of the FinChat system.
//
// The map itself is DERIVED at read time from real state (agent_configs, their
// wired tool manifests, the Sprint 5C entities/entity_edges knowledge graph, and
// the proof chain). Nothing about the derived map is stored here.
//
// These tables store only what the *user* adds on top of it:
//   neural_map_nodes     : nodes the user created by hand
//   neural_map_edges     : connections the user drew by hand
//   neural_map_node_meta : per-user annotations (note, renamed label, pinned
//                          position) against ANY node — derived or custom
//   neural_map_edge_meta : per-user annotations against ANY edge
//
// Node/edge keys are namespaced strings so a single annotation table can cover
// both derived and custom items: "agent:plato", "tool:stocks",
// "entity:<id>", "sys:proofchain", "custom:<uuid>".

exports.up = async (pgm) => {
  // ── user-created nodes ─────────────────────────────────────
  pgm.createTable('neural_map_nodes', {
    node_key: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    label: { type: 'text', notNull: true },
    node_type: { type: 'text', notNull: true, default: 'idea' }, // agent|tool|entity|chain|doc|idea
    note: { type: 'text', notNull: true, default: '' },
    meta: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") }, // [[k,v], ...]
    apis: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('neural_map_nodes', ['user_id']);

  // ── user-drawn connections ─────────────────────────────────
  pgm.createTable('neural_map_edges', {
    edge_key: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    from_key: { type: 'text', notNull: true },
    to_key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('neural_map_edges', ['user_id']);
  pgm.addConstraint('neural_map_edges', 'neural_map_edges_unique_pair',
    { unique: ['user_id', 'from_key', 'to_key'] });

  // ── annotations on any node (derived or custom) ────────────
  pgm.createTable('neural_map_node_meta', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    node_key: { type: 'text', notNull: true },
    note: { type: 'text' },
    label_override: { type: 'text' },
    pos_x: { type: 'real' }, // NULL => let the force layout place it
    pos_y: { type: 'real' },
    hidden: { type: 'integer', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('neural_map_node_meta', 'neural_map_node_meta_unique',
    { unique: ['user_id', 'node_key'] });

  // ── annotations on any edge (derived or custom) ────────────
  pgm.createTable('neural_map_edge_meta', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    edge_key: { type: 'text', notNull: true },
    note: { type: 'text' },
    api: { type: 'text' },
    flow: { type: 'text' },
    payload: { type: 'text' }, // free-text JSON schema / sample payload
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('neural_map_edge_meta', 'neural_map_edge_meta_unique',
    { unique: ['user_id', 'edge_key'] });
};

exports.down = async (pgm) => {
  pgm.dropTable('neural_map_edge_meta');
  pgm.dropTable('neural_map_node_meta');
  pgm.dropTable('neural_map_edges');
  pgm.dropTable('neural_map_nodes');
};
