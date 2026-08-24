/* eslint-disable camelcase */

// Give Rasha and Plato the per-agent budget everyone else already has.
//
// Migration 030 introduced `runtime_settings.budget` so a specialist could
// carry its own ceilings instead of running on the framework default. Aurelius
// (20k), Nova (25k), memory and sentinel all got one. Rasha and Plato never
// did, so both still run at the 15,000 default — and measured over the last 7
// days Rasha breached 5 of 20 chat turns while every agent WITH a budget
// breached none.
//
// 15,000 is not a tight budget for her, it is an impossible one. Measured on
// her real prompt: the turn-1 prompt is ~3,240 tokens and the turn-2 prompt
// (with one jobs result and a little history) is ~4,600. Any answer that uses a
// tool needs at least two turns, and a reasoning model bills its thinking as
// completion on top — the breaching run spent 15,133 on ONE tool call and two
// iterations. There was no version of that turn that fit.
//
// 30,000 buys roughly four turns at that size, which covers search → read →
// answer with room to write the answer. It is a ceiling, not a spend: her
// average run over the same week was 12,227.

const BUDGETS = {
  // Job listings are verbose — eight of them with titles, companies and URLs is
  // several thousand tokens that then get re-sent on every subsequent turn.
  rasha: { maxTokens: 30000, maxToolCalls: 8, maxIterations: 6, maxRuntimeSeconds: 180 },
  // The orchestrator is the fallback for every goal no specialist matched, and
  // it is exempt from tool scoping, so it carries the whole catalogue.
  plato: { maxTokens: 30000, maxToolCalls: 8, maxIterations: 8, maxRuntimeSeconds: 180 }
};

exports.up = async (pgm) => {
  for (const [agentId, budget] of Object.entries(BUDGETS)) {
    // Only fill the gap. An operator who has since tuned one of these from the
    // Agents page owns that number, and a migration must not overwrite it.
    pgm.sql(`
      UPDATE agent_configs
         SET runtime_settings = jsonb_set(
               COALESCE(runtime_settings, '{}'::jsonb),
               '{budget}',
               '${JSON.stringify(budget)}'::jsonb,
               true)
       WHERE agent_id = '${agentId}'
         AND NOT (COALESCE(runtime_settings, '{}'::jsonb) ? 'budget');
    `);
  }
};

exports.down = async (pgm) => {
  for (const agentId of Object.keys(BUDGETS)) {
    pgm.sql(`
      UPDATE agent_configs
         SET runtime_settings = runtime_settings - 'budget'
       WHERE agent_id = '${agentId}';
    `);
  }
};
