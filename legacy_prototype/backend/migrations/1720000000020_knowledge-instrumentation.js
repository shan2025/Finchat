/* eslint-disable camelcase */

// Sprint Y — Knowledge Center & Reports · instrumentation
//
// The memory STORES already exist (Redis working memory, `memories`
// episodic/semantic/procedural, `knowledge`+`knowledge_embeddings` vector RAG,
// `skill_recipes`, `reflections`, and the Sprint X living graph). This migration
// adds only what's missing to make memory legible:
//
//   inference_metrics : one row per model call — tokens, latency, feature, agent.
//                       Powers the "Inference & Context Reuse" panel (the honest
//                       KV/cost view — Groq exposes token counts, not cache hits).
//   report_snapshots  : generated, shareable narratives over the live vitals.

exports.up = (pgm) => {
  // ── inference metrics (high-write, best-effort) ────────────
  pgm.createTable('inference_metrics', {
    metric_id: { type: 'bigserial', primaryKey: true },
    provider: { type: 'text', notNull: true },        // groq | ollama
    model: { type: 'text', notNull: true, default: '' },
    feature: { type: 'text', notNull: true, default: 'chat' }, // chat | extraction | gap | report | embedding | ...
    prompt_tokens: { type: 'integer', notNull: true, default: 0 },
    completion_tokens: { type: 'integer', notNull: true, default: 0 },
    latency_ms: { type: 'integer', notNull: true, default: 0 },
    agent_id: { type: 'text' },
    user_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('inference_metrics', ['created_at']);
  pgm.createIndex('inference_metrics', ['feature']);

  // ── report snapshots ───────────────────────────────────────
  pgm.createTable('report_snapshots', {
    report_id: { type: 'text', primaryKey: true },
    kind: { type: 'text', notNull: true },   // growth | agent_learning | dream_digest | gaps | user_profile
    title: { type: 'text', notNull: true, default: '' },
    user_id: { type: 'text' },               // NULL = system-wide
    period_start: { type: 'timestamptz' },
    period_end: { type: 'timestamptz' },
    summary: { type: 'text', notNull: true, default: '' },  // LLM-written narrative
    payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") }, // the numbers behind it
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('report_snapshots', ['kind', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('report_snapshots');
  pgm.dropTable('inference_metrics');
};
