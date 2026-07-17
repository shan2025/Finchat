// services/cognitive/StateMachine.js — Cognitive Core Lifecycle State Machine
const { EventEmitter } = require('events');

const stateMachineEvents = new EventEmitter();

/**
 * Valid lifecycle states per Decision #3
 */
const STATES = {
  CREATED: 'created',
  READY: 'ready',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Valid wait reasons per Decision #4
 */
const WAIT_REASONS = {
  TOOL_RESPONSE: 'tool_response',
  HUMAN_APPROVAL: 'human_approval',
  SCHEDULED_TRIGGER: 'scheduled_trigger'
};

/**
 * Allowed transition map per Decision #3
 */
const ALLOWED_TRANSITIONS = {
  [STATES.CREATED]: [STATES.READY, STATES.FAILED, STATES.CANCELLED],
  [STATES.READY]: [STATES.RUNNING, STATES.FAILED, STATES.CANCELLED],
  [STATES.RUNNING]: [STATES.WAITING, STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED],
  [STATES.WAITING]: [STATES.READY, STATES.RUNNING, STATES.FAILED, STATES.CANCELLED],
  [STATES.COMPLETED]: [], // Terminal state
  [STATES.FAILED]: [],    // Terminal state
  [STATES.CANCELLED]: []  // Terminal state
};

class IllegalTransitionError extends Error {
  constructor(fromState, toState, executionId = null) {
    const msg = `Illegal state transition from "${fromState}" to "${toState}"` + (executionId ? ` for execution "${executionId}"` : '');
    super(msg);
    this.name = 'IllegalTransitionError';
    this.fromState = fromState;
    this.toState = toState;
    this.executionId = executionId;
  }
}

/**
 * Check if a state transition is allowed according to the transition map.
 * @param {string} fromState - Current lifecycle state
 * @param {string} toState - Proposed next lifecycle state
 * @returns {boolean}
 */
function canTransition(fromState, toState) {
  if (!ALLOWED_TRANSITIONS[fromState]) {
    return false;
  }
  return ALLOWED_TRANSITIONS[fromState].includes(toState);
}

/**
 * Validate and assert that a transition is legal. Throws IllegalTransitionError if forbidden.
 * @param {string} fromState - Current lifecycle state
 * @param {string} toState - Proposed next lifecycle state
 * @param {string} [executionId] - Optional execution ID for error reporting and event emission
 * @param {object} [metadata] - Optional metadata (waitReason, completionReason, result) to attach to event
 * @throws {IllegalTransitionError}
 */
function validateTransition(fromState, toState, executionId = null, metadata = {}) {
  if (!canTransition(fromState, toState)) {
    throw new IllegalTransitionError(fromState, toState, executionId);
  }

  // If transition is valid and executionId provided, emit state change event
  if (executionId) {
    stateMachineEvents.emit('execution:state_changed', {
      executionId,
      fromState,
      toState,
      timestamp: new Date().toISOString(),
      ...metadata
    });
  }

  return true;
}

module.exports = {
  STATES,
  WAIT_REASONS,
  ALLOWED_TRANSITIONS,
  IllegalTransitionError,
  canTransition,
  validateTransition,
  stateMachineEvents
};
