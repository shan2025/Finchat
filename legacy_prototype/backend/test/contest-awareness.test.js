// test/contest-awareness.test.js — live multi-agent race state + the structured
// contest note each lane sees. The note is a DECISION input (evidence vs. fuel),
// deliberately not a "beat X" order, and must stay silent until there is real
// competition to reason about. These tests pin that contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const RaceState = require('../services/cognitive/RaceState');

const fresh = (id) => RaceState.clear(id);

test('a single lane has no contest note', () => {
  const R = 'c1'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.update(R, 'e1', { evidence: 2, fuel: 3000 });
  assert.equal(RaceState.contestNote(R, 'e1'), null);
});

test('a lane whose rivals have produced nothing yet gets no note', () => {
  const R = 'c2'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.register(R, 'e2', 'aurelius');
  RaceState.update(R, 'e1', { evidence: 2, fuel: 2000 }); // only nova has moved
  assert.equal(RaceState.contestNote(R, 'e1'), null, 'nova sees aurelius has nothing to compare');
  assert.ok(RaceState.contestNote(R, 'e2'), 'aurelius sees nova already has evidence');
});

test('a lane behind the leader is shown the gap and its budget', () => {
  const R = 'c3'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.register(R, 'e2', 'aurelius');
  RaceState.update(R, 'e1', { evidence: 3, fuel: 4000 });
  RaceState.update(R, 'e2', { evidence: 1, fuel: 2000 });
  const note = RaceState.contestNote(R, 'e2', { budgetRemainingTokens: 9000 });
  assert.match(note, /position 2 of 2/);
  assert.match(note, /Nova: 3 sources/);
  assert.match(note, /Gap to leader: 2 sources behind/);
  assert.match(note, /remaining fuel budget: 9\.0k/);
  assert.match(note, /Decide economically/);
  assert.match(note, /Do NOT gather sources just to outnumber/i);
  assert.doesNotMatch(note, /beat (nova|aurelius|rasha)/i, 'must not frame it as "beat <rival>"');
});

test('the leader is told it leads, not told to attack', () => {
  const R = 'c4'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.register(R, 'e2', 'aurelius');
  RaceState.update(R, 'e1', { evidence: 3, fuel: 4000 });
  RaceState.update(R, 'e2', { evidence: 1, fuel: 2000 });
  const note = RaceState.contestNote(R, 'e1');
  assert.match(note, /You lead on evidence/);
});

test('a finished rival is marked answered', () => {
  const R = 'c5'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.register(R, 'e2', 'aurelius');
  RaceState.update(R, 'e1', { evidence: 2, fuel: 5000, done: true });
  RaceState.update(R, 'e2', { evidence: 1, fuel: 2000 });
  const note = RaceState.contestNote(R, 'e2');
  assert.match(note, /Nova: 2 sources, 5\.0k fuel \[answered\]/);
});

test('level on sources falls back to a fuel comparison', () => {
  const R = 'c6'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.register(R, 'e2', 'aurelius');
  RaceState.update(R, 'e1', { evidence: 2, fuel: 2000 }); // leader — cheaper
  RaceState.update(R, 'e2', { evidence: 2, fuel: 5000 });
  const note = RaceState.contestNote(R, 'e2');
  assert.match(note, /level on sources, 3\.0k more fuel spent/);
});

test('standings rank by evidence, then by least fuel', () => {
  const R = 'c7'; fresh(R);
  RaceState.register(R, 'e1', 'nova');
  RaceState.register(R, 'e2', 'aurelius');
  RaceState.register(R, 'e3', 'rasha');
  RaceState.update(R, 'e1', { evidence: 1, fuel: 1000 });
  RaceState.update(R, 'e2', { evidence: 3, fuel: 5000 });
  RaceState.update(R, 'e3', { evidence: 3, fuel: 2000 });
  const s = RaceState.standings(R);
  assert.deepEqual(s.map(l => l.agentId), ['rasha', 'aurelius', 'nova']);
  assert.deepEqual(s.map(l => l.position), [1, 2, 3]);
});

test('an unknown race yields no standings and no note', () => {
  assert.deepEqual(RaceState.standings('nope'), []);
  assert.equal(RaceState.contestNote('nope', 'x'), null);
});
