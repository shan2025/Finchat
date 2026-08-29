// services/realtime.js — routes EventBus events to the owning user's sockets.
//
// This used to live inline in server.js as a wall of `io.emit(...)` calls, which
// delivered every event to every connected browser: notification rows carry the
// full mission report in `content`, dream reports carry entity names lifted out
// of a private knowledge graph, and debate events carry the goal text. Any
// logged-in user received all of it.
//
// It lives here so the routing decision — which is a security boundary, not
// plumbing — can be tested without booting the server. See test/realtime.test.js.

/** The private room every socket joins, derived from its JWT-verified identity. */
const userRoom = (userId) => `user:${userId}`;

/**
 * Read the owning user out of an event payload.
 *
 * Emitters are inconsistent: EventBus payloads use `userId`, while rows read
 * back from Postgres (notifications) use `user_id`. Both are accepted; anything
 * else is treated as unowned.
 */
function ownerOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const owner = payload.userId || payload.user_id;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/**
 * The full event map. `type` is folded into the socket payload where the
 * frontend switches on it; `null` means forward the payload unchanged.
 */
const BRIDGES = [
  // source: 'state' = stateMachineEvents, 'bus' = eventBus
  ['state', 'execution:created', 'agent_status_pulse', 'created'],
  ['bus', 'execution:waiting', 'agent_status_pulse', 'waiting'],
  ['bus', 'execution:completed', 'agent_status_pulse', 'completed'],
  ['bus', 'execution:resumed', 'agent_status_pulse', 'resumed'],
  ['bus', 'briefing:completed', 'agent_status_pulse', 'briefing_completed'],

  // Sprint X · Cognitive Memory Engine — the neural map listens for these to
  // make nodes glow while the AI thinks. The graph is per-user (migration 028),
  // so these are per-user too.
  ['bus', 'graph:activation', 'graph_pulse', 'activation'],
  ['bus', 'memory:ingested', 'graph_pulse', 'learned'],
  ['bus', 'memory:dream_completed', 'graph_pulse', 'dream'],

  // Sprint 5 · Phase 5A — Multi-Agent Debate
  ['bus', 'debate:started', 'agent_status_pulse', 'debate_started'],
  ['bus', 'debate:positions_gathered', 'agent_status_pulse', 'debate_positions'],
  ['bus', 'debate:conflict', 'agent_status_pulse', 'debate_conflict'],
  ['bus', 'debate:round', 'agent_status_pulse', 'debate_round'],
  ['bus', 'debate:completed', 'agent_status_pulse', 'debate_completed'],

  // Live notification bell push. `user_id` is set by createNotification on
  // every row it writes.
  ['bus', 'notification:new', 'notification:new', null],

  // Agent Map fine-grained live telemetry — one consolidated pulse carrying
  // its own `type` (start | step | knowledge | tool_start | tool_end |
  // verified | done | error) and `userId`. Emitted by BrainStream at the
  // CognitiveCore phase points; forwarded unchanged to the owning user only.
  ['bus', 'brain:pulse', 'brain:pulse', null]
];

/**
 * Subscribe one event and forward it to its owner's room.
 *
 * An event carrying no owner is DROPPED, not broadcast — broadcasting is
 * exactly the bug this replaces, and without an owner there is no way to tell
 * whose data it is. If a pulse stops appearing in the UI, the fix is to include
 * userId at the emit site, never to widen the delivery here.
 */
function bridge({ io, source, eventName, socketEvent, type, onUnowned }) {
  source.on(eventName, (data = {}) => {
    const owner = ownerOf(data);
    if (!owner) {
      onUnowned(eventName);
      return;
    }
    io.to(userRoom(owner)).emit(socketEvent, type ? { type, ...data } : data);
  });
}

/**
 * Wire every EventBus/StateMachine event to per-user socket delivery.
 *
 * @param {object} deps
 * @param {object} deps.io                 - Socket.io server
 * @param {object} deps.eventBus           - services/cognitive/EventBus
 * @param {object} deps.stateMachineEvents - services/cognitive/StateMachine
 * @param {function} [deps.onUnowned]      - called with the event name when an
 *                                           event is dropped for having no owner
 * @returns {number} how many bridges were attached
 */
function attachEventBridges({ io, eventBus, stateMachineEvents, onUnowned }) {
  const warn = onUnowned || ((eventName) =>
    console.warn(`⚠️ Realtime: "${eventName}" carried no userId — not delivered.`));

  for (const [sourceKey, eventName, socketEvent, type] of BRIDGES) {
    bridge({
      io,
      source: sourceKey === 'state' ? stateMachineEvents : eventBus,
      eventName,
      socketEvent,
      type,
      onUnowned: warn
    });
  }
  return BRIDGES.length;
}

module.exports = { userRoom, ownerOf, bridge, attachEventBridges, BRIDGES };
