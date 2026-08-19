// test/agent-routing.test.js — history-aware agent selection (Plato-selects-on-history).
//
// The blend is the routing policy: 70% capability, 30% task-conditioned history,
// but only once an agent has ≥ 5 completed runs of that task type. Below that it
// must behave exactly as capability-only routing did. These tests pin that
// contract — new agents, sub-threshold agents, blended agents, and ties — so a
// change to the weighting can't silently start routing on thin evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { blendAgentScores } = require('../services/AgentLeaderboard');

const TASK = 'research';
const prof = (cell) => ({ cells: { [TASK]: cell } });
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const byId = (rows, id) => rows.find(r => r.agentId === id);

test('new agent (no profile) routes on capability only', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'nova', cap: 3 }, { agentId: 'aurelius', cap: 1 }],
    profilesByAgent: {}, taskType: TASK
  });
  const nova = byId(rows, 'nova'), aur = byId(rows, 'aurelius');
  assert.equal(nova.hasHistory, false);
  assert.equal(nova.history, null);
  assert.ok(close(nova.finalScore, 1), 'top capability → finalScore 1');
  assert.ok(close(aur.finalScore, 1 / 3, 1e-3), 'lower capability → capNorm only');
  assert.equal(rows[0].agentId, 'nova'); // capability order preserved
});

test('agent below the 5-run threshold routes on capability only', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'nova', cap: 2 }],
    profilesByAgent: { nova: prof({ runs: 4, accuracy: 100, errorRate: 0, avgFuel: 2, avgSecs: 5 }) },
    taskType: TASK
  });
  assert.equal(rows[0].hasHistory, false, '4 runs < 5 → history ignored');
  assert.ok(close(rows[0].finalScore, 1), 'capability only despite a perfect (but thin) record');
});

test('agent at/above the threshold blends 70/30', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'aurelius', cap: 2 }],
    profilesByAgent: { aurelius: prof({ runs: 5, accuracy: 100, errorRate: 0, avgFuel: 4, avgSecs: 8 }) },
    taskType: TASK
  });
  const a = rows[0];
  assert.equal(a.hasHistory, true, 'exactly 5 runs crosses the threshold');
  assert.ok(close(a.history.score, 1), 'perfect record → histNorm 1');
  assert.ok(close(a.finalScore, 1), '0.7·1 + 0.3·1 = 1');
});

test('weak history pulls a strong-capability agent below pure capability', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'rasha', cap: 4 }],
    profilesByAgent: { rasha: prof({ runs: 20, accuracy: 0, errorRate: 50, avgFuel: 9, avgSecs: 60 }) },
    taskType: TASK
  });
  const r = rows[0];
  // histNorm = 0.5·0 + 0.25·0.5 + 0.25·1(sole-agent efficiency) = 0.375
  assert.ok(close(r.history.score, 0.375), 'reliability + efficiency only');
  assert.ok(close(r.finalScore, 0.7 * 1 + 0.3 * 0.375), 'blended below 1');
  assert.ok(r.finalScore < 1);
});

test('capability stays primary: bigger capability beats better history', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'a', cap: 1 }, { agentId: 'b', cap: 3 }],
    profilesByAgent: { a: prof({ runs: 10, accuracy: 100, errorRate: 0, avgFuel: 1, avgSecs: 1 }) },
    taskType: TASK
  });
  assert.equal(rows[0].agentId, 'b', 'cap 3 (no history) outranks cap 1 (perfect history)');
  assert.ok(rows[0].finalScore > rows[1].finalScore);
});

test('history breaks a capability near-tie', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'a', cap: 2 }, { agentId: 'b', cap: 2 }],
    profilesByAgent: {
      a: prof({ runs: 10, accuracy: 90, errorRate: 0, avgFuel: 3, avgSecs: 5 }),
      b: prof({ runs: 10, accuracy: 40, errorRate: 20, avgFuel: 3, avgSecs: 5 })
    },
    taskType: TASK
  });
  assert.equal(rows[0].agentId, 'a', 'equal capability → the more accurate agent wins');
  assert.ok(rows[0].finalScore > rows[1].finalScore);
});

test('exact tie is deterministic (by agentId)', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'zeta', cap: 2 }, { agentId: 'alpha', cap: 2 }],
    profilesByAgent: {}, taskType: TASK
  });
  assert.deepEqual(rows.map(r => r.agentId), ['alpha', 'zeta']);
});

test('with no history at all, order matches capability order (behavior preserved)', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'a', cap: 1 }, { agentId: 'b', cap: 3 }, { agentId: 'c', cap: 2 }],
    profilesByAgent: {}, taskType: TASK
  });
  assert.deepEqual(rows.map(r => r.agentId), ['b', 'c', 'a']);
});

test('efficiency is comparative: cheaper agent scores higher, all else equal', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'cheap', cap: 2 }, { agentId: 'pricey', cap: 2 }],
    profilesByAgent: {
      cheap: prof({ runs: 10, accuracy: 80, errorRate: 0, avgFuel: 2, avgSecs: 5 }),
      pricey: prof({ runs: 10, accuracy: 80, errorRate: 0, avgFuel: 9, avgSecs: 5 })
    },
    taskType: TASK
  });
  assert.ok(byId(rows, 'cheap').history.score > byId(rows, 'pricey').history.score);
  assert.equal(rows[0].agentId, 'cheap');
});

test('a different task type does not borrow another task\'s history', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'nova', cap: 2 }],
    profilesByAgent: { nova: { cells: { markets: { runs: 50, accuracy: 100, errorRate: 0, avgFuel: 1, avgSecs: 1 } } } },
    taskType: 'research' // nova has no research history
  });
  assert.equal(rows[0].hasHistory, false, 'markets record must not count for a research question');
});
