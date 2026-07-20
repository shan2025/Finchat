/* eslint-disable camelcase */

// Sprint X — Cognitive Memory Engine · Stage 1
//
// Turns the flat Sprint 5C entity graph into a *living* knowledge graph:
//
//   entities gain    : summary, importance, confidence, activation stats,
//                      owner_agent, merge status (living nodes — Phase 1)
//   entity_edges gain: strength, confidence, reason, source, agent, activation
//                      stats (living edges — Phase 3)
//   node_events      : append-only per-node history — created / mentioned /
//                      activated / updated / merged ("git for knowledge" — Phase 6)
//   entity_links     : provenance — which chats / executions / documents a
//                      node was learned from or used in (Phase 1 profile)
//   graph_insights   : machine-found gaps, contradictions, duplicates and
//                      dream-cycle reports (Phases 2, 7, 8)

exports.up = async (pgm) => {
  // ── living nodes ───────────────────────────────────────────
  pgm.addColumns('entities', {
    summary: { type: 'text', notNull: true, default: '' },
    importance: { type: 'real', notNull: true, default: 5 },        // 0..10
    confidence: { type: 'real', notNull: true, default: 0.7 },      // 0..1
    activation_count: { type: 'integer', notNull: true, default: 0 },
    last_activated_at: { type: 'timestamptz' },
    owner_agent: { type: 'text' },                                  // agent that learns/curates this node most
    status: { type: 'text', notNull: true, default: 'active' },     // active | merged
    merged_into: { type: 'text' }                                   // entity_id this node was merged into
  });
  pgm.createIndex('entities', ['status']);
  pgm.createIndex('entities', ['last_activated_at']);

  // ── living edges ───────────────────────────────────────────
  pgm.addColumns('entity_edges', {
    strength: { type: 'real', notNull: true, default: 0.5 },        // 0..1, decays in dream cycles
    confidence: { type: 'real', notNull: true, default: 0.7 },      // 0..1
    reason: { type: 'text', notNull: true, default: '' },           // why the model believes this link exists
    source: { type: 'text', notNull: true, default: 'execution' },  // chat | execution | document | dream | manual
    agent_id: { type: 'text' },                                     // agent that surfaced the link
    activation_count: { type: 'integer', notNull: true, default: 0 },
    last_activated_at: { type: 'timestamptz' }
  });

  // ── per-node history (timeline) ────────────────────────────
  pgm.createTable('node_events', {
    event_id: { type: 'bigserial', primaryKey: true },
    entity_id: { type: 'text', notNull: true, references: 'entities(entity_id)', onDelete: 'CASCADE' },
    event_type: { type: 'text', notNull: true }, // created | mentioned | activated | updated | merged | contradiction
    detail: { type: 'text', notNull: true, default: '' },
    source_type: { type: 'text' },               // chat | execution | document | dream | retrieval
    source_id: { type: 'text' },                 // session_id / execution_id / document name
    agent_id: { type: 'text' },
    user_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('node_events', ['entity_id', 'created_at']);
  pgm.createIndex('node_events', ['created_at']);
  pgm.createIndex('node_events', ['event_type']);

  // ── provenance links ───────────────────────────────────────
  pgm.createTable('entity_links', {
    link_id: { type: 'bigserial', primaryKey: true },
    entity_id: { type: 'text', notNull: true, references: 'entities(entity_id)', onDelete: 'CASCADE' },
    link_type: { type: 'text', notNull: true }, // chat_session | execution | document | mission | agent
    link_ref: { type: 'text', notNull: true },  // the id/name of the linked thing
    label: { type: 'text', notNull: true, default: '' },
    count: { type: 'integer', notNull: true, default: 1 },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('entity_links', 'entity_links_unique_ref',
    { unique: ['entity_id', 'link_type', 'link_ref'] });
  pgm.createIndex('entity_links', ['entity_id']);

  // ── machine-found insights ─────────────────────────────────
  pgm.createTable('graph_insights', {
    insight_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text' },                   // NULL = global
    kind: { type: 'text', notNull: true },       // gap | contradiction | duplicate | dream_report
    title: { type: 'text', notNull: true },
    detail: { type: 'text', notNull: true, default: '' },
    payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    status: { type: 'text', notNull: true, default: 'open' }, // open | accepted | dismissed
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' }
  });
  pgm.createIndex('graph_insights', ['status', 'kind']);
};

exports.down = async (pgm) => {
  pgm.dropTable('graph_insights');
  pgm.dropTable('entity_links');
  pgm.dropTable('node_events');
  pgm.dropColumns('entity_edges', ['strength', 'confidence', 'reason', 'source', 'agent_id', 'activation_count', 'last_activated_at']);
  pgm.dropColumns('entities', ['summary', 'importance', 'confidence', 'activation_count', 'last_activated_at', 'owner_agent', 'status', 'merged_into']);
};
