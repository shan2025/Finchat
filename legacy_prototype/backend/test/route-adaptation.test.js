// test/route-adaptation.test.js — competitive route adaptation. scoreLegs blends
// historical route yield (proven legs only) with a live-coverage penalty that
// pushes lanes toward complementary ground, and preserves unchanged behaviour
// for legs without enough history. These tests pin that contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreLegs } = require('../services/cognitive/RouteStats');

const legs = (...ds) => ds.map(d => ({ district: d }));
const by = (rows) => Object.fromEntries(rows.map(r => [r.district, r]));

test('a leg below the run threshold is neutral — never suppressed, never trusted', () => {
  const rows = by(scoreLegs({
    legs: legs('research', 'markets'),
    districtStats: { research: { runs: 2, verifiedRate: 0.9, avgCostMs: 100 } }, // below minRuns
    minRuns: 5
  }));
  assert.equal(rows.research.proven, false);
  assert.equal(rows.research.yield, null);
  assert.equal(rows.research.score, 0.5, 'unproven legs sit at the neutral baseline');
  assert.equal(rows.markets.score, 0.5);
});

test('a proven high-yield leg outranks an unproven one', () => {
  const scored = scoreLegs({
    legs: legs('research', 'web'),
    districtStats: { research: { runs: 20, verifiedRate: 0.9, avgCostMs: 500 } },
    minRuns: 5
  });
  assert.equal(scored[0].district, 'research');
  assert.ok(scored[0].score > 0.5);
  assert.equal(scored[0].proven, true);
});

test('yield dominates cost: a slow-but-verified leg beats a cheap unproven one', () => {
  const scored = scoreLegs({
    legs: legs('research', 'web'),
    districtStats: {
      research: { runs: 20, verifiedRate: 1.0, avgCostMs: 9000 }, // proven, slowest
      web: { runs: 1, verifiedRate: 1.0, avgCostMs: 10 }          // unproven, cheap
    },
    minRuns: 5
  });
  assert.equal(scored[0].district, 'research');
});

test('a rival-covered leg is deprioritised below an uncovered one of equal yield', () => {
  const scored = scoreLegs({
    legs: legs('markets', 'news'),
    districtStats: {
      markets: { runs: 20, verifiedRate: 0.8, avgCostMs: 500 },
      news: { runs: 20, verifiedRate: 0.8, avgCostMs: 500 }
    },
    coveredDistricts: ['markets'],
    minRuns: 5
  });
  assert.equal(scored[0].district, 'news', 'the uncovered leg leads');
  const m = scored.find(r => r.district === 'markets');
  assert.equal(m.covered, true);
  assert.ok(m.score < scored[0].score);
});

test('when every leg is covered, ranking is preserved and nothing is dropped', () => {
  const scored = scoreLegs({
    legs: legs('markets', 'news'),
    districtStats: {
      markets: { runs: 20, verifiedRate: 0.9, avgCostMs: 500 },
      news: { runs: 20, verifiedRate: 0.5, avgCostMs: 500 }
    },
    coveredDistricts: ['markets', 'news'],
    minRuns: 5
  });
  assert.equal(scored.length, 2);
  assert.equal(scored[0].district, 'markets', 'higher yield still leads even when both covered');
  assert.ok(scored.every(r => r.covered));
});

test('exploration surfaces the best unproven, uncovered leg above a proven mediocre one', () => {
  // markets proven, verifiedRate 0.4 → 0.7·0.4 + 0.3·1 = 0.58 (just above neutral).
  const stats = { markets: { runs: 20, verifiedRate: 0.4, avgCostMs: 500 } };
  const withoutExplore = scoreLegs({ legs: legs('markets', 'research'), districtStats: stats, minRuns: 5, shouldExplore: false });
  assert.equal(withoutExplore[0].district, 'markets', 'no exploration: the mediocre proven leg still leads neutral');

  const withExplore = scoreLegs({ legs: legs('markets', 'research'), districtStats: stats, minRuns: 5, shouldExplore: true });
  const research = withExplore.find(r => r.district === 'research');
  assert.equal(research.explored, true);
  assert.equal(withExplore[0].district, 'research', 'exploration lifts the unproven leg to the top');
});

test('exploration never lifts a rival-covered leg', () => {
  const scored = scoreLegs({
    legs: legs('markets', 'research'),
    districtStats: {},
    coveredDistricts: ['research'], // research is held by a rival
    shouldExplore: true
  });
  const research = scored.find(r => r.district === 'research');
  assert.equal(research.explored, false, 'a covered leg is never an exploration candidate');
});

test('empty stats degrade cleanly to all-neutral', () => {
  const scored = scoreLegs({ legs: legs('a', 'b', 'c'), districtStats: {} });
  assert.equal(scored.length, 3);
  assert.ok(scored.every(r => r.score === 0.5 && !r.proven));
});
