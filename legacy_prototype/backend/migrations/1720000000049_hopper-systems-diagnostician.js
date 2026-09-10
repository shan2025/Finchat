/* eslint-disable camelcase */

// Hopper — the Systems Diagnostician, and the tool grants that make her real.
//
// Every diagnosis this project has made was made by a human reading `executions`
// and `tool_results` by hand: the cascading mission failures of 2026-08-27, the
// briefings that shipped failure prose as the morning news, the runs silently
// capped at 8k tokens. The evidence was always in the database. Nothing in the
// system could look at it, so an agent asked "what's broken?" answered from its
// own prompt — which is how a user was once told an agent was "fully
// operational" while it was failing every single message.
//
// So this migration adds the agent, and grants her exactly the reach a
// diagnosis needs and no more:
//
//   diagnostics   — the failure record: runs clustered by error, budget
//                   breaches, failing tools and missions, provider latency.
//   system_status — already implemented, and until now never registered, so no
//                   agent could call it.
//   file_read/glob — reading the code the evidence points at. Admin-only tools
//                   (ADVANCED_SYSTEM_TOOLS) but not host-ACCESS ones: they open
//                   files, they do not change the machine.
//
// What she deliberately does NOT get is the writing half — bash, file_write,
// file_edit. The rows below are inserted with allowed = 0 on purpose, so the
// denial is a recorded decision rather than an absence someone later reads as an
// oversight. Two reasons, and neither is squeamishness:
//
//   1. On Render the filesystem is ephemeral and there is no git or PR tool
//      here. An edit applied in production is written into a container that gets
//      replaced on the next deploy — a "fix" that reports success, never reaches
//      the repo, and quietly returns.
//   2. `bash` is unsandboxed host shell access with the server's own privileges
//      (see its registry description). That belongs to a deliberate local
//      workflow, not to a scheduled agent.
//
// To enable them for local development, set HOPPER_HOST_TOOLS=true AND flip the
// rows below to 1. Both locks, on purpose: the env var is the machine saying
// "this is a dev box", the rows are the operator saying "yes, this agent".
//
// Provider: pinned to DeepSeek via runtime_settings.provider. Debugging is the
// long-context, many-tool workload on this system, which is the worst case for
// a small local model — so this agent is pinned AWAY from Ollama, not toward it.
// It is a preference, not a lock: inference.js fronts it and keeps the rest of
// the route as fallback.

const HOPPER_TOOLS = [
  'diagnostics', 'system_status',
  'file_read', 'glob',
  'neural_map', 'session',
  'search', 'fetch'
];

// Substring-matched against the user's goal (AgentRegistry.scoreCapabilities).
// Deliberately about FAULTS rather than about code in general: "how do I write
// a mission" is a Plato question, "why did my mission fail" is Hopper's.
const HOPPER_CAPABILITIES = [
  'bug', 'broken', 'failing', 'failed', 'error', 'crash', 'exception',
  'why did it fail', 'why is it failing', 'not working', 'stopped working',
  'debug', 'diagnose', 'diagnosis', 'root cause', 'traceback', 'stack trace',
  'regression', 'flaky', 'timeout', 'timing out', 'slow', 'latency',
  'budget exceeded', 'quota', 'rate limit',
  'system health', 'is it working', 'what went wrong'
];

// A diagnosis is: cluster the failures, read one execution in full, read two or
// three source files, then write the patch. That is a handful of large tool
// results carried through several turns — the same shape as Atlas's daily review
// (migration 044, 45k) with more text per result. A ceiling, not a spend.
const HOPPER_BUDGET = {
  maxTokens: 50000, maxToolCalls: 14, maxIterations: 8, maxRuntimeSeconds: 300
};

const HOPPER_RUNTIME = {
  budget: HOPPER_BUDGET,
  // Low risk → temperature 0.3 (RISK_TEMP in CognitiveCore). Diagnosis is the
  // one job on this system where inventiveness is the failure mode.
  risk: 'Low',
  provider: 'deepseek'
};

const HOPPER_PROMPT = `You are Hopper, FinChat's Systems Diagnostician. You read the system's own failure record, trace faults into the code, and write the patch for a human to apply. You never apply fixes, restart services or change configuration yourself, and you never state a cause you have not seen evidence for — an absence of data is not a clean bill of health.`;

// Granted, but recorded as denied. See the note above on the two locks.
const HOST_TOOLS_DENIED = ['bash', 'file_write', 'file_edit'];

exports.up = async (pgm) => {
  pgm.sql(`
    INSERT INTO agents (agent_id, name, type)
    VALUES ('hopper', 'Hopper', 'specialist')
    ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;
  `);

  pgm.sql(`
    INSERT INTO agent_configs (
      agent_id, system_prompt, capabilities, tools,
      is_direct_addressable, memory_namespace, color, runtime_settings)
    VALUES (
      'hopper',
      '${HOPPER_PROMPT.replace(/'/g, "''")}',
      '${JSON.stringify(HOPPER_CAPABILITIES)}'::jsonb,
      '${JSON.stringify(HOPPER_TOOLS)}'::jsonb,
      1,
      'hopper::diagnostics',
      '#8fb8de',
      '${JSON.stringify(HOPPER_RUNTIME)}'::jsonb)
    ON CONFLICT (agent_id) DO UPDATE SET
      system_prompt = EXCLUDED.system_prompt,
      capabilities  = EXCLUDED.capabilities,
      tools         = EXCLUDED.tools,
      is_direct_addressable = EXCLUDED.is_direct_addressable,
      memory_namespace = EXCLUDED.memory_namespace,
      runtime_settings = EXCLUDED.runtime_settings;
  `);

  // Host-access denials, written down. checkPermission() would refuse these
  // anyway on a missing row (host access is deny-by-default since migration
  // 026), but an explicit 0 says a person decided it — and makes enabling them
  // on a dev box a one-line UPDATE rather than a guess about what to insert.
  //
  // permission_id follows migration 026's deterministic 'perm_<agent>_<tool>'
  // naming so the row is idempotent and findable by hand. Migration 026 seeded
  // these rows FROM the agents table, which did not yet contain hopper — so
  // without this insert she would have had no rows at all.
  pgm.sql(`
    INSERT INTO tool_permissions (permission_id, agent_id, tool_name, allowed)
    SELECT 'perm_hopper_' || t.tool_name, 'hopper', t.tool_name, 0
      FROM (VALUES ${HOST_TOOLS_DENIED.map(t => `('${t}')`).join(', ')}) AS t(tool_name)
    ON CONFLICT (agent_id, tool_name) DO NOTHING;
  `);

  // The identity row every agent needs in `users` — messages.sender_id is a
  // foreign key into it and routes/aiChat.js stores replies under the uppercased
  // persona id — is NOT inserted here. server.js seeds it from the persona
  // roster on every boot (see the comment there about Atlas), so adding hopper
  // to personas.js is what creates it. Duplicating that insert here would create
  // a second place to remember, which is the exact failure that comment exists
  // to prevent.
};

exports.down = async (pgm) => {
  pgm.sql(`DELETE FROM tool_permissions WHERE agent_id = 'hopper'`);
  pgm.sql(`DELETE FROM agent_configs WHERE agent_id = 'hopper'`);
  pgm.sql(`DELETE FROM agents WHERE agent_id = 'hopper'`);
};
