// test/state-machine.test.js — execution lifecycle transitions.
//
// The state machine is what stops the model from declaring a task complete. It
// is pure and exhaustively enumerable, so these tests check the whole matrix
// rather than a few happy paths.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES, WAIT_REASONS, ALLOWED_TRANSITIONS,
  canTransition, validateTransition, IllegalTransitionError, stateMachineEvents,
} = require('../services/cognitive/StateMachine');

const ALL = Object.values(STATES);
const TERMINAL = [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED];

test('every state is covered by the transition map', () => {
  for (const s of ALL) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s]), `no entry for "${s}"`);
  }
});

test('the transition map only ever points at real states', () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(ALL.includes(to), `"${from}" -> unknown state "${to}"`);
    }
  }
});

test('terminal states are dead ends', () => {
  for (const t of TERMINAL) {
    assert.deepEqual(ALLOWED_TRANSITIONS[t], [], `"${t}" should be terminal`);
    for (const to of ALL) {
      assert.equal(canTransition(t, to), false, `"${t}" -> "${to}" must be refused`);
    }
  }
});

test('no state may transition to itself', () => {
  for (const s of ALL) {
    assert.equal(canTransition(s, s), false, `"${s}" -> "${s}" must be refused`);
  }
});

test('every non-terminal state can always fail and cancel', () => {
  // Otherwise an execution could get wedged with no way to abort it.
  for (const s of ALL.filter(x => !TERMINAL.includes(x))) {
    assert.equal(canTransition(s, STATES.FAILED), true, `"${s}" must be able to fail`);
    assert.equal(canTransition(s, STATES.CANCELLED), true, `"${s}" must be able to cancel`);
  }
});

test('only running may complete', () => {
  for (const s of ALL) {
    assert.equal(
      canTransition(s, STATES.COMPLETED), s === STATES.RUNNING,
      `"${s}" -> completed`);
  }
});

test('the documented happy path is walkable', () => {
  const path = [STATES.CREATED, STATES.READY, STATES.RUNNING, STATES.COMPLETED];
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test('a waiting execution can be resumed', () => {
  // Human approval parks in WAITING; both resume routes must stay open.
  assert.equal(canTransition(STATES.RUNNING, STATES.WAITING), true);
  assert.equal(canTransition(STATES.WAITING, STATES.READY), true);
  assert.equal(canTransition(STATES.WAITING, STATES.RUNNING), true);
});

test('unknown states are refused, not assumed valid', () => {
  assert.equal(canTransition('bogus', STATES.READY), false);
  assert.equal(canTransition(STATES.READY, 'bogus'), false);
  assert.equal(canTransition(undefined, undefined), false);
});

test('validateTransition throws IllegalTransitionError with context', () => {
  assert.throws(
    () => validateTransition(STATES.COMPLETED, STATES.RUNNING, 'exec-1'),
    (err) => {
      assert.ok(err instanceof IllegalTransitionError);
      assert.equal(err.fromState, STATES.COMPLETED);
      assert.equal(err.toState, STATES.RUNNING);
      assert.equal(err.executionId, 'exec-1');
      return true;
    });
});

test('a legal transition emits execution:state_changed once, with metadata', () => {
  const seen = [];
  const onChange = (e) => seen.push(e);
  stateMachineEvents.on('execution:state_changed', onChange);
  try {
    validateTransition(STATES.RUNNING, STATES.WAITING, 'exec-2',
      { waitReason: WAIT_REASONS.HUMAN_APPROVAL });
  } finally {
    stateMachineEvents.off('execution:state_changed', onChange);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].executionId, 'exec-2');
  assert.equal(seen[0].fromState, STATES.RUNNING);
  assert.equal(seen[0].toState, STATES.WAITING);
  assert.equal(seen[0].waitReason, WAIT_REASONS.HUMAN_APPROVAL);
  assert.ok(seen[0].timestamp, 'timestamp is needed for the execution trace');
});

test('an illegal transition emits nothing', () => {
  const seen = [];
  const onChange = (e) => seen.push(e);
  stateMachineEvents.on('execution:state_changed', onChange);
  try {
    assert.throws(() => validateTransition(STATES.FAILED, STATES.RUNNING, 'exec-3'));
  } finally {
    stateMachineEvents.off('execution:state_changed', onChange);
  }
  assert.equal(seen.length, 0, 'a refused transition must not announce a state change');
});

test('no event is emitted without an executionId', () => {
  const seen = [];
  const onChange = (e) => seen.push(e);
  stateMachineEvents.on('execution:state_changed', onChange);
  try {
    validateTransition(STATES.CREATED, STATES.READY);
  } finally {
    stateMachineEvents.off('execution:state_changed', onChange);
  }
  assert.equal(seen.length, 0);
});

test('wait reasons match the documented set', () => {
  assert.deepEqual(
    Object.values(WAIT_REASONS).sort(),
    ['human_approval', 'scheduled_trigger', 'tool_response']);
});
