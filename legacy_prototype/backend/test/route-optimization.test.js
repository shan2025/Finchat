// test/route-optimization.test.js — learned route optimization. The weight model
// is a smoothed, windowed verified-RATE (not a path-dependent EMA), chosen so the
// nightly full rebuild is idempotent and order-independent. These tests pin the
// pure math and the transition term's bounded influence on routing.
const test = require('node:test');
const assert = require('node:assert/strict');
const RO = require('../services/cognitive/RouteOptimizer');
const { scoreLegs } = require('../services/cognitive/RouteStats');

test('transitionsOf collapses same-district repeats and keeps real moves', () => {
  assert.deepEqual(RO.transitionsOf(['markets', 'markets', 'news', 'news', 'web']),
    [['markets', 'news'], ['news', 'web']]);
  assert.deepEqual(RO.transitionsOf(['solo']), []);
  assert.deepEqual(RO.transitionsOf([]), []);
});

test('aggregateTransitions counts, and one run reinforces an edge at most once', () => {
  const agg = RO.aggregateTransitions([
    { districts: ['markets', 'news', 'markets', 'news'], verified: true }, // markets->news twice in one run
    { districts: ['markets', 'news'], verified: false }
  ]);
  assert.equal(agg.markets.news.traversals, 2, 'two runs, not three — volume within a run is capped');
  assert.equal(agg.markets.news.verified, 1);
});

test('edgeWeight is a smoothed verified-rate', () => {
  assert.equal(RO.edgeWeight({ traversals: 1, verified: 1 }), 1 / 4);   // not a falsely-confident 1.0
  assert.equal(RO.edgeWeight({ traversals: 0, verified: 0 }), 0);
  const w = RO.edgeWeight({ traversals: 10, verified: 10 });
  assert.ok(w > 0.7 && w < 1, 'high-volume all-verified approaches but never reaches 1');
});

test('buildWeightMap gates edges below the traversal threshold', () => {
  const agg = {
    markets: { news: { traversals: 8, verified: 6 }, web: { traversals: 2, verified: 2 } }
  };
  const w = RO.buildWeightMap(agg, { minTraversals: 5 });
  assert.ok(w.markets.news > 0, 'proven edge kept');
  assert.equal(w.markets.web, undefined, 'sub-threshold edge dropped');
});

test('transitionBoost looks up an edge, or 0 when absent', () => {
  const w = { markets: { news: 0.6 } };
  assert.equal(RO.transitionBoost('markets', 'news', w), 0.6);
  assert.equal(RO.transitionBoost('markets', 'web', w), 0);
  assert.equal(RO.transitionBoost(null, 'news', w), 0);
  assert.equal(RO.transitionBoost('markets', 'news', null), 0);
});

test('rebuild is order-independent: shuffling runs yields identical weights', () => {
  const runs = [
    { districts: ['markets', 'news'], verified: true },
    { districts: ['markets', 'news'], verified: false },
    { districts: ['news', 'web'], verified: true },
    { districts: ['markets', 'news'], verified: true }
  ];
  const a = RO.buildWeightMap(RO.aggregateTransitions(runs), { minTraversals: 1 });
  const b = RO.buildWeightMap(RO.aggregateTransitions([...runs].reverse()), { minTraversals: 1 });
  assert.deepEqual(a, b);
});

test('rich-get-richer is capped: rate not volume, with shrinking per-run impact', () => {
  const w10 = RO.edgeWeight({ traversals: 10, verified: 10 });
  const w100 = RO.edgeWeight({ traversals: 100, verified: 100 });
  assert.ok(w100 > w10 && w100 < 1, 'more volume nudges up but never saturates to certainty');
  // One more verified traversal moves a heavy edge far less than a light one.
  const lightStep = RO.edgeWeight({ traversals: 6, verified: 6 }) - RO.edgeWeight({ traversals: 5, verified: 5 });
  const heavyStep = RO.edgeWeight({ traversals: 51, verified: 51 }) - RO.edgeWeight({ traversals: 50, verified: 50 });
  assert.ok(heavyStep < lightStep, 'per-run impact shrinks as an edge accumulates evidence');
});

// ── The transition term in scoreLegs (bounded corrective) ────────────────────
test('a learned transition lifts a candidate leg, without overriding a strong yield', () => {
  const stats = {
    news: { runs: 20, verifiedRate: 0.5, avgCostMs: 500 },
    web: { runs: 20, verifiedRate: 0.5, avgCostMs: 500 }
  };
  const base = scoreLegs({ legs: [{ district: 'news' }, { district: 'web' }], districtStats: stats });
  assert.equal(base[0].score, base[1].score, 'equal yield → tie without a learned edge');

  const lifted = scoreLegs({
    legs: [{ district: 'news' }, { district: 'web' }], districtStats: stats,
    lastDistrict: 'markets', transitionWeights: { markets: { web: 0.8 } }
  });
  assert.equal(lifted[0].district, 'web', 'the learned move breaks the tie toward web');
  assert.ok(lifted.find(l => l.district === 'web').transitionBoost > 0);

  // Bounded: a strong-yield uncovered leg still beats a learned move into a weak one.
  const strong = scoreLegs({
    legs: [{ district: 'news' }, { district: 'web' }],
    districtStats: { news: { runs: 20, verifiedRate: 1.0, avgCostMs: 500 }, web: { runs: 20, verifiedRate: 0.1, avgCostMs: 500 } },
    lastDistrict: 'markets', transitionWeights: { markets: { web: 1.0 } }
  });
  assert.equal(strong[0].district, 'news', 'yield stays primary; the transition only nudges');
});

test('the transition term does not rescue a rival-covered leg', () => {
  const scored = scoreLegs({
    legs: [{ district: 'news' }, { district: 'web' }],
    districtStats: { news: { runs: 20, verifiedRate: 0.6, avgCostMs: 500 }, web: { runs: 20, verifiedRate: 0.6, avgCostMs: 500 } },
    coveredDistricts: ['web'],
    lastDistrict: 'markets', transitionWeights: { markets: { web: 0.8 } }
  });
  assert.equal(scored[0].district, 'news', 'a rival-held district stays deprioritised despite the learned edge');
});
