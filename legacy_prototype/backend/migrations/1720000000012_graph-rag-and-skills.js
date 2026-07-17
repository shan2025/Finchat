/* eslint-disable camelcase */

// Sprint 5C — Deep Vector Memory: Graph-RAG + Procedural Chaining
//
// entities        : nodes in the knowledge graph (e.g. "Solana", "TSLA", "Rust")
// entity_edges    : typed relationships between entities (e.g. co_mentioned, prefers, involves)
// skill_recipes   : structured plan templates distilled from successful multi-step executions
//                   — retrievable by embedding similarity so agents can reuse them

exports.up = async (pgm) => {
  // ── entities: canonical nodes ──────────────────────────────
  pgm.createTable('entities', {
    entity_id: { type: 'text', primaryKey: true },
    canonical_name: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true }, // ticker | technology | company | person | topic | preference | project
    aliases: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    mention_count: { type: 'integer', notNull: true, default: 1 },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('entities', ['entity_type']);
  pgm.addConstraint('entities', 'entities_canonical_type_unique',
    { unique: ['canonical_name', 'entity_type'] });

  // ── entity_edges: typed relationships ──────────────────────
  pgm.createTable('entity_edges', {
    edge_id: { type: 'bigserial', primaryKey: true },
    from_entity_id: { type: 'text', notNull: true, references: 'entities(entity_id)', onDelete: 'CASCADE' },
    to_entity_id: { type: 'text', notNull: true, references: 'entities(entity_id)', onDelete: 'CASCADE' },
    edge_type: { type: 'text', notNull: true }, // co_mentioned | prefers | involves | derived_from | uses
    weight: { type: 'integer', notNull: true, default: 1 }, // co-occurrence count
    context_execution_id: { type: 'text' }, // which execution surfaced this edge (most recent)
    user_id: { type: 'text' }, // for preference edges attached to a user
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('entity_edges', ['from_entity_id', 'edge_type']);
  pgm.createIndex('entity_edges', ['to_entity_id', 'edge_type']);
  // For preserving co-occurrence uniqueness per (from,to,type,user):
  // NULLs in user_id are treated as distinct by Postgres — good, keeps user-scoped edges separate.
  pgm.addConstraint('entity_edges', 'entity_edges_unique_triple',
    { unique: ['from_entity_id', 'to_entity_id', 'edge_type', 'user_id'] });

  // ── skill_recipes: reusable multi-step execution templates ─
  pgm.createTable('skill_recipes', {
    recipe_id: { type: 'text', primaryKey: true },
    title: { type: 'text', notNull: true },
    goal_pattern: { type: 'text', notNull: true }, // the original goal it came from
    agent_id: { type: 'text' }, // which agent produced it (or NULL for global)
    steps: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") }, // [{step, action, tool?, input?}]
    embedding: { type: 'vector(768)' }, // for similarity retrieval — matches config/embeddings.js
    times_reused: { type: 'integer', notNull: true, default: 0 },
    success_rate: { type: 'real', notNull: true, default: 1.0 },
    source_execution_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('skill_recipes', ['agent_id']);
};

exports.down = async (pgm) => {
  pgm.dropTable('skill_recipes');
  pgm.dropTable('entity_edges');
  pgm.dropTable('entities');
};
