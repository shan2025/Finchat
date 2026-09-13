// test/quant-metrics.test.js — every risk formula against a value worked by hand.
//
// These numbers go to someone deciding what to do with their savings. A formula
// that is subtly wrong is worse than no formula, because it is believed — so
// each test below uses inputs small enough to compute on paper, and the expected
// value is written out rather than produced by calling the module on itself.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../services/quant/metrics');

const close = (actual, expected, tol = 1e-9, msg) => {
  assert.ok(actual != null, `${msg || 'value'} was null`);
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg || 'value'}: expected ${expected}, got ${actual}`);
};

/** Prices from a list of simple returns, starting at 100. */
const pricesFrom = (rets) => rets.reduce((p, r) => [...p, p[p.length - 1] * (1 + r)], [100]);

describe('conventions', () => {
  test('crypto annualises over 365 days, equities over 252', () => {
    // Using 252 for a coin understates its volatility by ~17%.
    assert.equal(m.periodsPerYear('crypto'), 365);
    assert.equal(m.periodsPerYear('stock'), 252);
    assert.equal(m.periodsPerYear(undefined), 365);
  });
});

describe('basic statistics', () => {
  test('sample standard deviation divides by n-1', () => {
    // [0.1, -0.1]: mean 0, squared deviations 0.02, /(2-1) -> sqrt(0.02)
    close(m.stdev([0.1, -0.1]), Math.sqrt(0.02));
  });

  test('quantile matches numpy/R type-7 interpolation', () => {
    close(m.quantile([1, 2, 3, 4], 0.5), 2.5);   // numpy.median -> 2.5
    close(m.quantile([1, 2, 3, 4, 5], 0.25), 2);  // numpy.quantile(.., .25) -> 2.0
    close(m.quantile([10, 20], 0.9), 19);         // 10 + 0.9 * 10
  });
});

describe('returns', () => {
  test('simple daily returns', () => {
    const r = m.returns([100, 110, 99]);
    close(r[0], 0.1);
    close(r[1], -0.1);
  });

  test('total return', () => {
    close(m.totalReturn([100, 110, 99]), -0.01);
  });

  test('CAGR refuses to annualise a short window', () => {
    // A 3-day +10% "annualises" to five figures — and that number would be quoted.
    assert.equal(m.cagr([100, 105, 110], 'crypto'), null);
  });

  test('CAGR of a doubling over exactly one crypto year is 100%', () => {
    const prices = Array.from({ length: 366 }, (_, i) => 1 + i / 365); // 1 -> 2 over 365 periods
    close(m.cagr(prices, 'crypto'), 1.0, 1e-12);
  });
});

describe('risk', () => {
  // Twenty returns alternating +2% / 0%: mean 0.01, every deviation 0.01,
  // sum of squares 20 * 0.0001 = 0.002, sample variance 0.002 / 19.
  const alt = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.02 : 0));
  const altPrices = pricesFrom(alt);
  const sdDaily = Math.sqrt(0.002 / 19);

  test('annualised volatility', () => {
    const v = m.volatility(altPrices, 'crypto');
    close(v.daily, sdDaily, 1e-12);
    close(v.annual, sdDaily * Math.sqrt(365), 1e-10);
  });

  test('Sharpe ratio with a zero risk-free rate', () => {
    close(m.sharpe(altPrices, 'crypto'), (0.01 * 365) / (sdDaily * Math.sqrt(365)), 1e-8);
  });

  test('Sharpe subtracts an annual risk-free rate', () => {
    close(m.sharpe(altPrices, 'crypto', 0.05), (0.01 * 365 - 0.05) / (sdDaily * Math.sqrt(365)), 1e-8);
  });

  test('Sortino is undefined, not infinite, when there was never a down day', () => {
    assert.equal(m.sortino(altPrices, 'crypto'), null);
  });

  test('Sortino counts only downside deviation', () => {
    // returns [+0.10, -0.10]: mean 0 -> numerator 0 regardless of the denominator.
    close(m.sortino(pricesFrom([0.1, -0.1]), 'crypto'), 0, 1e-12);
  });

  test('drawdown: worst fall and distance below the peak', () => {
    // Peak 120, trough 90 -> 90/120 - 1 = -25%; now 110 -> 110/120 - 1.
    const d = m.drawdown([100, 120, 90, 110]);
    close(d.max, -0.25);
    close(d.current, 110 / 120 - 1);
    assert.equal(d.maxPeakIndex, 1);
    assert.equal(d.maxTroughIndex, 2);
  });

  test('historical VaR and expected shortfall', () => {
    // 20 returns sorted: [-0.20, -0.10, then 18 x +0.01].
    // Type-7 5% quantile: h = 19 * 0.05 = 0.95 -> -0.20 + 0.95 * (0.10) = -0.105.
    // VaR = 0.105; the tail at or below -0.105 is just -0.20, so ES = 0.20.
    const rets = [-0.2, -0.1, ...Array(18).fill(0.01)];
    const v = m.valueAtRisk(pricesFrom(rets), 0.95);
    close(v.var, 0.105, 1e-9);
    close(v.expectedShortfall, 0.2, 1e-9);
    assert.equal(v.observations, 20);
  });

  test('VaR refuses a sample too short to have a 5% tail', () => {
    assert.equal(m.valueAtRisk([100, 101, 102, 103]), null);
  });
});

describe('technical indicators', () => {
  test('SMA', () => {
    close(m.sma([1, 2, 3, 4, 5], 3), 4);
  });

  test('EMA is seeded with the SMA', () => {
    // alpha = 2/(3+1) = 0.5; seed mean(1,2,3) = 2; then 0.5*4+0.5*2 = 3; 0.5*5+0.5*3 = 4.
    close(m.ema([1, 2, 3, 4, 5], 3), 4);
  });

  test('RSI uses Wilder smoothing', () => {
    // period 2 on [10, 11, 10, 11]:
    //   seed: gains [1], losses [1] -> avgGain 0.5, avgLoss 0.5
    //   next +1: avgGain (0.5*1 + 1)/2 = 0.75, avgLoss (0.5*1 + 0)/2 = 0.25
    //   RS = 3 -> RSI = 100 - 100/4 = 75
    close(m.rsi([10, 11, 10, 11], 2), 75);
  });

  test('RSI bounds', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    assert.equal(m.rsi(up), 100);
    close(m.rsi(down), 0);
  });

  test('Bollinger bands use the population deviation', () => {
    // The textbook set [2,4,4,4,5,5,7,9]: mean 5, population sd exactly 2.
    const b = m.bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    close(b.middle, 5);
    close(b.upper, 9);
    close(b.lower, 1);
    close(b.percentB, 1); // last price 9 sits exactly on the upper band
  });

  test('MACD declines a series too short to seed both averages', () => {
    assert.equal(m.macd(Array.from({ length: 20 }, (_, i) => i + 1)), null);
  });
});

describe('relationships between assets', () => {
  test('correlation of perfectly linear series', () => {
    close(m.correlation([1, 2, 3], [2, 4, 6]), 1);
    close(m.correlation([1, 2, 3], [3, 2, 1]), -1);
  });

  test('beta of an asset that moves twice as far as its benchmark', () => {
    const bench = [0.01, -0.02, 0.03, -0.01];
    close(m.beta(bench.map((x) => x * 2), bench), 2);
  });

  test('perfect correlation gives no diversification', () => {
    const r = [0.02, -0.01, 0.03, -0.02, 0.01];
    const single = m.stdev(r);
    close(m.portfolioVolatility([0.5, 0.5], [r, r], 'crypto').daily, single, 1e-12);
  });

  test('perfect negative correlation at equal weight cancels out', () => {
    const r = [0.02, -0.01, 0.03, -0.02, 0.01];
    close(m.portfolioVolatility([0.5, 0.5], [r, r.map((x) => -x)], 'crypto').daily, 0, 1e-9);
  });

  test('concentration and effective number of positions', () => {
    const even = m.concentration([0.5, 0.5]);
    close(even.hhi, 0.5);
    close(even.effectivePositions, 2);
    // Twelve holdings with one at 90% behave like ~1.2 positions, not twelve.
    close(m.concentration([0.9, 0.1]).hhi, 0.82);
  });
});

describe('holding-period outcomes', () => {
  test('rolling windows over a steadily rising series', () => {
    // p_i = i + 1 for i in 0..29, h = 5: window i returns (i+6)/(i+1) - 1 = 5/(i+1).
    // 25 windows, all positive; best at i=0 (5.0), worst at i=24 (0.2).
    const prices = Array.from({ length: 30 }, (_, i) => i + 1);
    const o = m.horizonOutcomes(prices, 5);
    assert.equal(o.windows, 25);
    close(o.shareProfitable, 1);
    close(o.best, 5);
    close(o.worst, 0.2);
    assert.equal(o.overlapping, true,
      'overlapping windows are not independent samples — the output must say so');
  });

  test('refuses a horizon the history cannot cover', () => {
    assert.equal(m.horizonOutcomes([1, 2, 3], 5), null);
  });
});
