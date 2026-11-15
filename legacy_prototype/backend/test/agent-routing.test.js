// test/agent-routing.test.js — history-aware agent selection (Plato-selects-on-history).
//
// The blend is the routing policy: 70% capability, 30% task-conditioned history,
// but only once an agent has ≥ 5 completed runs of that task type. Below that it
// must behave exactly as capability-only routing did. These tests pin that
// contract — new agents, sub-threshold agents, blended agents, and ties — so a
// change to the weighting can't silently start routing on thin evidence.
//
// History = 0.5·helpfulness + 0.25·finished + 0.25·efficiency. Helpfulness is
// the Laplace-smoothed thumbs ratio, (up+1)/(rated+2): 0.5 with no ratings, so
// finishing cleanly can no longer pass for being right (changed 2026-11-15).
const test = require('node:test');
const assert = require('node:assert/strict');
const { blendAgentScores, helpfulness } = require('../services/AgentLeaderboard');

const TASK = 'research';
const prof = (cell) => ({ cells: { [TASK]: { rated: 0, ratedUp: 0, ...cell } } });
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const byId = (rows, id) => rows.find(r => r.agentId === id);

test('helpfulness is smoothed: unrated is 50/50, one thumb is not certainty', () => {
  assert.ok(close(helpfulness(0, 0), 0.5));
  assert.ok(close(helpfulness(1, 1), 2 / 3));
  assert.ok(close(helpfulness(0, 1), 1 / 3));
  assert.ok(close(helpfulness(9, 10), 10 / 12));
  assert.ok(helpfulness(100, 100) < 1, 'never exactly 1');
});

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
    profilesByAgent: { nova: prof({ runs: 4, finished: 100, rated: 4, ratedUp: 4, errorRate: 0, avgFuel: 2, avgSecs: 5 }) },
    taskType: TASK
  });
  assert.equal(rows[0].hasHistory, false, '4 runs < 5 → history ignored');
  assert.ok(close(rows[0].finalScore, 1), 'capability only despite a perfect (but thin) record');
});

test('at the threshold it blends 70/30, and an unrated perfect finisher is NOT perfect', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'aurelius', cap: 2 }],
    profilesByAgent: { aurelius: prof({ runs: 5, finished: 100, errorRate: 0, avgFuel: 4, avgSecs: 8 }) },
    taskType: TASK
  });
  const a = rows[0];
  assert.equal(a.hasHistory, true, 'exactly 5 runs crosses the threshold');
  // 0.5·0.5 (unrated) + 0.25·1 (finished) + 0.25·1 (sole-agent efficiency)
  assert.ok(close(a.history.score, 0.75), 'finishing every run is worth 0.75, not 1');
  assert.equal(a.history.helpful, null, 'no ratings → no helpfulness claim');
  assert.ok(close(a.finalScore, 0.7 + 0.3 * 0.75));
});

test('ratings move the history score', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'aurelius', cap: 2 }],
    profilesByAgent: { aurelius: prof({ runs: 10, finished: 100, rated: 10, ratedUp: 10, errorRate: 0, avgFuel: 4, avgSecs: 8 }) },
    taskType: TASK
  });
  const h = rows[0].history;
  assert.equal(h.helpful, 100);
  assert.equal(h.rated, 10);
  assert.ok(close(h.score, 0.5 * (11 / 12) + 0.25 + 0.25, 1e-3));
});

test('weak history pulls a strong-capability agent below pure capability', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'rasha', cap: 4 }],
    profilesByAgent: { rasha: prof({ runs: 20, finished: 50, rated: 8, ratedUp: 0, errorRate: 50, avgFuel: 9, avgSecs: 60 }) },
    taskType: TASK
  });
  const r = rows[0];
  // 0.5·(1/10) + 0.25·0.5 + 0.25·1(sole-agent efficiency) = 0.425
  assert.ok(close(r.history.score, 0.425), `got ${r.history.score}`);
  assert.ok(close(r.finalScore, 0.7 * 1 + 0.3 * 0.425, 1e-3), 'blended below 1');
  assert.ok(r.finalScore < 1);
});

test('capability stays primary: bigger capability beats better history', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'a', cap: 1 }, { agentId: 'b', cap: 3 }],
    profilesByAgent: { a: prof({ runs: 10, finished: 100, rated: 10, ratedUp: 10, errorRate: 0, avgFuel: 1, avgSecs: 1 }) },
    taskType: TASK
  });
  assert.equal(rows[0].agentId, 'b', 'cap 3 (no history) outranks cap 1 (perfect history)');
  assert.ok(rows[0].finalScore > rows[1].finalScore);
});

test('ratings break a capability tie, not finishing alone', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'finisher', cap: 2 }, { agentId: 'helpful', cap: 2 }],
    profilesByAgent: {
      // Finishes every run, but users keep rating its answers down.
      finisher: prof({ runs: 10, finished: 100, rated: 6, ratedUp: 1, errorRate: 0, avgFuel: 3, avgSecs: 5 }),
      // Errors more often, but what it delivers is rated helpful.
      helpful: prof({ runs: 10, finished: 80, rated: 6, ratedUp: 6, errorRate: 20, avgFuel: 3, avgSecs: 5 })
    },
    taskType: TASK
  });
  assert.equal(rows[0].agentId, 'helpful', 'the agent users found helpful wins the tie');
});

test('with no ratings anywhere, finishing and efficiency decide (the old behaviour, honestly labelled)', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'a', cap: 2 }, { agentId: 'b', cap: 2 }],
    profilesByAgent: {
      a: prof({ runs: 10, finished: 90, errorRate: 0, avgFuel: 3, avgSecs: 5 }),
      b: prof({ runs: 10, finished: 40, errorRate: 20, avgFuel: 3, avgSecs: 5 })
    },
    taskType: TASK
  });
  assert.equal(rows[0].agentId, 'a');
  assert.equal(rows[0].history.helpful, null);
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
      cheap: prof({ runs: 10, finished: 80, errorRate: 0, avgFuel: 2, avgSecs: 5 }),
      pricey: prof({ runs: 10, finished: 80, errorRate: 0, avgFuel: 9, avgSecs: 5 })
    },
    taskType: TASK
  });
  assert.ok(byId(rows, 'cheap').history.score > byId(rows, 'pricey').history.score);
  assert.equal(rows[0].agentId, 'cheap');
});

test('a different task type does not borrow another task\'s history', () => {
  const rows = blendAgentScores({
    candidates: [{ agentId: 'nova', cap: 2 }],
    profilesByAgent: { nova: { cells: { markets: { runs: 50, finished: 100, rated: 0, ratedUp: 0, errorRate: 0, avgFuel: 1, avgSecs: 1 } } } },
    taskType: 'research' // nova has no research history
  });
  assert.equal(rows[0].hasHistory, false, 'markets record must not count for a research question');
});
