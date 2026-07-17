/* eslint-disable camelcase */

// Multiple maps per user + ML neural-network maps.
//
// Until now there was exactly one Neural Map per user: the graph derived from
// live system state. This adds a "new map" flow (like starting a new chat),
// where each map is one of two kinds:
//
//   knowledge : a node/edge graph. The built-in 'system' map is the derived one;
//               user-created knowledge maps start blank and hold only their own
//               nodes/edges.
//   network   : a real feed-forward neural network the user configures and
//               trains (architecture + hyperparameters live in `config`,
//               learned weights and evaluation metrics in `weights`/`metrics`).
//
// Existing rows belong to the built-in map, so map_id defaults to the 'system'
// sentinel rather than NULL — the annotation tables upsert on
// (user_id, map_id, node_key), and Postgres treats NULLs as distinct, which
// would silently break ON CONFLICT for the derived map.

const SYSTEM_MAP = 'system';

exports.up = async (pgm) => {
  pgm.createTable('neural_maps', {
    map_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true, default: 'knowledge' }, // knowledge | network
    config: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    weights: { type: 'jsonb' },  // trained parameters, so a network survives reload
    metrics: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('neural_maps', ['user_id']);
  pgm.addConstraint('neural_maps', 'neural_maps_kind_check',
    { check: "kind IN ('knowledge', 'network')" });

  // ── scope every existing artefact to a map ────────────────
  for (const t of ['neural_map_nodes', 'neural_map_edges', 'neural_map_node_meta', 'neural_map_edge_meta']) {
    pgm.addColumns(t, {
      map_id: { type: 'text', notNull: true, default: SYSTEM_MAP }
    });
    pgm.createIndex(t, ['user_id', 'map_id']);
  }

  // Re-key the uniqueness on (user_id, map_id, …) so the same node can be
  // annotated differently in two different maps.
  pgm.dropConstraint('neural_map_node_meta', 'neural_map_node_meta_unique');
  pgm.addConstraint('neural_map_node_meta', 'neural_map_node_meta_unique',
    { unique: ['user_id', 'map_id', 'node_key'] });

  pgm.dropConstraint('neural_map_edge_meta', 'neural_map_edge_meta_unique');
  pgm.addConstraint('neural_map_edge_meta', 'neural_map_edge_meta_unique',
    { unique: ['user_id', 'map_id', 'edge_key'] });

  pgm.dropConstraint('neural_map_edges', 'neural_map_edges_unique_pair');
  pgm.addConstraint('neural_map_edges', 'neural_map_edges_unique_pair',
    { unique: ['user_id', 'map_id', 'from_key', 'to_key'] });
};

exports.down = async (pgm) => {
  pgm.dropConstraint('neural_map_edges', 'neural_map_edges_unique_pair');
  pgm.addConstraint('neural_map_edges', 'neural_map_edges_unique_pair',
    { unique: ['user_id', 'from_key', 'to_key'] });

  pgm.dropConstraint('neural_map_edge_meta', 'neural_map_edge_meta_unique');
  pgm.addConstraint('neural_map_edge_meta', 'neural_map_edge_meta_unique',
    { unique: ['user_id', 'edge_key'] });

  pgm.dropConstraint('neural_map_node_meta', 'neural_map_node_meta_unique');
  pgm.addConstraint('neural_map_node_meta', 'neural_map_node_meta_unique',
    { unique: ['user_id', 'node_key'] });

  for (const t of ['neural_map_nodes', 'neural_map_edges', 'neural_map_node_meta', 'neural_map_edge_meta']) {
    pgm.dropColumns(t, ['map_id']);
  }
  pgm.dropTable('neural_maps');
};
