/* eslint-disable camelcase */

// Adds per-agent runtime tuning that ACTUALLY affects behavior:
//   risk    → LLM temperature (Low 0.3 / Medium 0.7 / High 1.0)
//   formal  → tone directive injected into the system prompt
//   brief   → verbosity directive
//   serious → playfulness directive
// Previously these lived only in browser localStorage on the Agents page and did nothing.

const DEFAULTS = {
  plato:    { risk: 'High', formal: 85, brief: 20, serious: 90 },
  aurelius: { risk: 'Low',  formal: 70, brief: 40, serious: 80 },
  rasha:    { risk: 'Low',  formal: 65, brief: 30, serious: 75 },
  nova:     { risk: 'Low',  formal: 80, brief: 15, serious: 95 },
  sentinel: { risk: 'High', formal: 90, brief: 60, serious: 95 },
  memory:   { risk: 'Low',  formal: 60, brief: 50, serious: 60 }
};

exports.up = async (pgm) => {
  pgm.addColumns('agent_configs', {
    runtime_settings: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") }
  });

  for (const [agentId, s] of Object.entries(DEFAULTS)) {
    pgm.sql(`
      UPDATE agent_configs
      SET runtime_settings = '${JSON.stringify(s)}'::jsonb
      WHERE agent_id = '${agentId}';
    `);
  }
};

exports.down = async (pgm) => {
  pgm.dropColumns('agent_configs', ['runtime_settings']);
};
