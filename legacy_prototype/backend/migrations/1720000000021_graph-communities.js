/* eslint-disable camelcase */

// Sprint X · Stage 4b — Community detection
//
// Turns the knowledge-graph hairball into legible, named neighborhoods.
// Label propagation over the living entity_edges (weighted by strength) groups
// related concepts; each group becomes a row here with a short name, a color,
// and — filled in later by the dream cluster-summarizer (Stage 2) — a paragraph.
//
//   graph_communities : one named neighborhood ("DeFi", "ML tooling")
//   entities.community_id : which neighborhood a node currently belongs to
//
// Communities are re-derived each dream cycle. IDs are content-addressed (a hash
// of sorted member ids), so an unchanged cluster keeps its id — and therefore
// its summary — across runs.

exports.up = async (pgm) => {
  pgm.createTable('graph_communities', {
    community_id: { type: 'text', primaryKey: true },   // com_<hash of members>
    user_id: { type: 'text' },                          // NULL = global
    label: { type: 'text', notNull: true, default: '' },        // short name ("DeFi")
    summary: { type: 'text', notNull: true, default: '' },      // Stage 2 paragraph
    color: { type: 'text', notNull: true, default: '#8b6f47' }, // territory color on the map
    size: { type: 'integer', notNull: true, default: 0 },
    top_nodes: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") }, // representative node names
    algo: { type: 'text', notNull: true, default: 'label_propagation' },
    summarized_at: { type: 'timestamptz' },             // when Stage 2 last narrated it
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addColumns('entities', {
    community_id: { type: 'text' }   // plain ref (no FK: communities are rebuilt each cycle)
  });
  pgm.createIndex('entities', ['community_id']);
};

exports.down = async (pgm) => {
  pgm.dropColumns('entities', ['community_id']);
  pgm.dropTable('graph_communities');
};
