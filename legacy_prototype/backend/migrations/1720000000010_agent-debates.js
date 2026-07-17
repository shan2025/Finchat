/* eslint-disable camelcase */

// Sprint 5 · Phase 5A — Multi-Agent Debate & Inter-Agent Collaboration
// Adds persistence for peer-delegation debates + a consensus/debate transcript.
// Also corrects the specialist tool manifests: migration 009 was applied to the
// database before its seed was updated to include crypto/paper/resume, and
// node-pg-migrate never re-runs an already-applied migration — so this brings the
// live agent_configs in line with the domain tools those specialists debate with.

exports.up = async (pgm) => {
  // ── debates: one row per orchestrated debate ────────────────────────────
  pgm.createTable('debates', {
    debate_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text' },
    conversation_id: { type: 'text' },
    goal: { type: 'text', notNull: true },
    orchestrator_agent: { type: 'text', notNull: true, default: 'plato' },
    participants: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    conflict_detected: { type: 'boolean', notNull: true, default: false },
    conflict_summary: { type: 'text' },
    rounds_run: { type: 'integer', notNull: true, default: 0 },
    final_consensus: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'running' }, // running | completed | failed
    metadata: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // ── debate_arguments: transcript rows (round 0 = grounded opening position) ─
  pgm.createTable('debate_arguments', {
    argument_id: { type: 'bigserial', primaryKey: true },
    debate_id: {
      type: 'text',
      notNull: true,
      references: 'debates(debate_id)',
      onDelete: 'CASCADE'
    },
    round_number: { type: 'integer', notNull: true }, // 0 = opening, 1..N = rebuttal rounds
    agent_id: { type: 'text', notNull: true },
    position: { type: 'text' },
    execution_id: { type: 'text' }, // links round-0 position to its cognitive execution
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('debate_arguments', ['debate_id', 'round_number']);

  // ── Tool-manifest correction (see header note) ──────────────────────────
  pgm.sql(`UPDATE agent_configs SET tools = '["stocks","search","crypto"]'::jsonb WHERE agent_id = 'aurelius';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","paper"]'::jsonb WHERE agent_id = 'nova';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","resume"]'::jsonb WHERE agent_id = 'rasha';`);
};

exports.down = async (pgm) => {
  pgm.dropTable('debate_arguments');
  pgm.dropTable('debates');
  // Revert tool manifests to the pre-5A state
  pgm.sql(`UPDATE agent_configs SET tools = '["stocks","search"]'::jsonb WHERE agent_id = 'aurelius';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search"]'::jsonb WHERE agent_id = 'nova';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search"]'::jsonb WHERE agent_id = 'rasha';`);
};
