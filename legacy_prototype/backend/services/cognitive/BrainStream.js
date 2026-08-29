// services/cognitive/BrainStream.js — fine-grained live telemetry for the Brain
// Model. This is NOT a parallel tracking system: it adds no tables and stores
// nothing. It emits one consolidated `brain:pulse` event on the EXISTING
// EventBus at the points CognitiveCore already logs phases, reusing the exact
// map taxonomy from ExecutionTrace so a tool/entity lands on the same building
// live as it does on the persisted replay. realtime.js routes brain:pulse to
// the owning user's socket room; the persisted rows remain the source of truth.
const { eventBus } = require('./EventBus');
const { toolLocation, entityLocation, agentMeta } = require('./ExecutionTrace');

// Every pulse must carry userId — realtime.js drops ownerless events, so a
// pulse without it would reach nobody. We skip rather than emit a noisy drop.
function pulse(type, data) {
  if (!data || !data.userId || !data.executionId) return;
  try { eventBus.emit('brain:pulse', { type, ts: Date.now(), ...data }); }
  catch (_) { /* telemetry must never break a run */ }
}

module.exports = {
  // Run opened: the routed agent leaves the Question Hub.
  start: ({ executionId, userId, question, agentId, fuelCap, createdAt, raceId }) => {
    const m = agentMeta(agentId);
    pulse('start', {
      executionId, userId, question, raceId: raceId || null, createdAt: createdAt || new Date().toISOString(),
      agent: { id: agentId, name: m.name, role: m.role, color: m.color, avatar: m.avatar, fuelCap: fuelCap || 15 }
    });
  },
  // A reasoning turn — a leg with a reason, no new building.
  step: ({ executionId, userId, reason, atMs, tokensUsed }) =>
    pulse('step', { executionId, userId, reason, atMs, tokensUsed, fuel: (tokensUsed || 0) / 1000 }),
  // Knowledge-graph nodes recalled to answer — buildings light up.
  knowledge: ({ executionId, userId, atMs, entities }) =>
    pulse('knowledge', {
      executionId, userId, atMs,
      buildings: (entities || []).filter(e => e && (e.entityId || e.entity_id))
        .map(e => entityLocation(e.type, e.entityId || e.entity_id, e.name))
    }),
  // Tool dispatched — agent heads for that building. `why` is the agent's own
  // stated reason for going (plan step description, or the turn's thought); the
  // input is what it asked for once it arrived. Both travel, so the live map can
  // answer "why did it go there" without waiting for the persisted trace.
  toolStart: ({ executionId, userId, tool, input, why, atMs }) =>
    pulse('tool_start', { executionId, userId, tool, input, why: why || null, atMs, building: toolLocation(tool) }),
  // Tool returned (or failed) — arrival, with the road lit or flagged as fog.
  toolEnd: ({ executionId, userId, tool, input, why, error, durationMs, atMs, tokensUsed }) =>
    pulse('tool_end', {
      executionId, userId, tool, input, why: why || null, error: error || null, durationMs, atMs,
      tokensUsed, fuel: (tokensUsed || 0) / 1000, building: toolLocation(tool)
    }),
  // Verification pass (ReflectionEngine) finished.
  verified: ({ executionId, userId, summary }) =>
    pulse('verified', { executionId, userId, summary: summary || null }),
  // Run finished — the answer is ready; the client then loads the full trace.
  done: ({ executionId, userId, completionReason, tokensUsed, atMs }) =>
    pulse('done', { executionId, userId, completionReason, tokensUsed, fuel: (tokensUsed || 0) / 1000, atMs }),
  // Fatal error mid-run.
  error: ({ executionId, userId, message, atMs }) =>
    pulse('error', { executionId, userId, message, atMs })
};
