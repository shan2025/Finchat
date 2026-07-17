// services/cognitive/EventBus.js — Centralized in-memory event system for the Cognitive Core
const { EventEmitter } = require('events');

/**
 * Singleton EventBus for all cognitive events.
 * Sprint 1: in-memory EventEmitter. Sprint 4+: Redis Pub/Sub.
 *
 * Events:
 *   execution:created, execution:state_changed, execution:completed, execution:failed,
 *   execution:delegated, tool:invoked, tool:completed, memory:stored, reflection:completed
 */
const eventBus = new EventEmitter();
eventBus.setMaxListeners(50); // Allow many subscribers without warnings

// Optional: log all events in dev for debugging
if (process.env.NODE_ENV === 'development' || process.env.DEBUG_EVENTS === 'true') {
  const originalEmit = eventBus.emit.bind(eventBus);
  eventBus.emit = (event, ...args) => {
    console.log(`📡 EventBus: ${event}`, args[0]?.executionId || '');
    return originalEmit(event, ...args);
  };
}

module.exports = { eventBus };
