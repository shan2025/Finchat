/* eslint-disable camelcase */

// Give every agent its own working budget.
//
// CognitiveCore reads `agent_configs.runtime_settings.budget` and applies it
// underneath any caller-supplied budget (briefing.js's 40k, a mission's
// max_tokens_per_run) but above the framework default. Before this, the chat
// path passed no budget at all, so every specialist ran on the bare
// ExecutionManager default.
//
// That default was 5,000 tokens, and one reasoning turn measures ~2,614 (1,947
// prompt + 667 completion over 397 live calls — the prompt is re-sent and
// re-charged every iteration). Two turns therefore breached before the agent
// could write anything. Measured over the 14 days to 2026-08-18:
//
//   rasha     budget_exceeded at 5,266 tokens against a 5,000 ceiling
//   aurelius  budget_exceeded at 11,620; its SUCCESSFUL runs averaged 5,835,
//             surviving only on CognitiveCore's reserved wrap-up turn
//   plato/nova  never hit this — their callers had always passed 15k-40k
//
// The figures below are sized on that measured per-turn cost, not guessed:
// research-heavy agents get room for a plan plus several tool results plus a
// synthesis pass; the conversational ones get enough for a normal exchange.
// maxIterations still bounds the loop independently (and CognitiveCore's
// LOOP_SAFETY_NET caps it at 8 regardless), so these raise the cost of a
// pathological run, not of a normal one.

const BUDGETS = {
  // Orchestrator: fans out across tools and then synthesises. The heaviest.
  plato: { maxTokens: 25000, maxIterations: 6, maxToolCalls: 8, maxRuntimeSeconds: 180 },
  // Research/digest agent — multi-source, needs room to gather then write.
  nova: { maxTokens: 25000, maxIterations: 6, maxToolCalls: 8, maxRuntimeSeconds: 180 },
  // Finance/crypto: several market lookups then analysis.
  aurelius: { maxTokens: 20000, maxIterations: 5, maxToolCalls: 6, maxRuntimeSeconds: 150 },
  // Careers/jobs: search-led, moderate synthesis.
  rasha: { maxTokens: 20000, maxIterations: 5, maxToolCalls: 6, maxRuntimeSeconds: 150 },
  // Memory agent holds no tools — recall and answer.
  memory: { maxTokens: 12000, maxIterations: 4, maxToolCalls: 2, maxRuntimeSeconds: 90 },
  // Middleware: short governance verdicts, never a research run.
  sentinel: { maxTokens: 8000, maxIterations: 3, maxToolCalls: 2, maxRuntimeSeconds: 60 }
};

exports.up = async (pgm) => {
  // Merge rather than replace: runtime_settings already carries risk, the
  // persona trait sliders (brief/formal/serious) and any per-agent model pin.
  // `||` on jsonb is a shallow merge, so writing the whole object back would
  // discard those — every agent would lose its tuning to gain a budget.
  for (const [agentId, budget] of Object.entries(BUDGETS)) {
    pgm.sql(`
      UPDATE agent_configs
      SET runtime_settings = COALESCE(runtime_settings, '{}'::jsonb)
                             || jsonb_build_object('budget', '${JSON.stringify(budget)}'::jsonb)
      WHERE agent_id = '${agentId}'
    `);
  }
};

exports.down = async (pgm) => {
  // Drop only the key this migration added; the rest of runtime_settings is not
  // ours to touch.
  pgm.sql(`UPDATE agent_configs SET runtime_settings = runtime_settings - 'budget'`);
};
