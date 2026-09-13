// services/quant/metrics.js — the formulas, and nothing else.
//
// Pure functions over arrays of closing prices. No network, no database, no
// clock. That is the whole point of this file: every number Atlas quotes about
// risk comes out of here, and a risk figure that is subtly wrong is worse than
// none, because it is believed. Being pure is what lets each one be tested
// against a value worked out by hand (test/quant-metrics.test.js).
//
// Two conventions are fixed here so nothing downstream has to guess:
//
//   RETURNS are simple period returns, r_t = p_t / p_{t-1} - 1, on DAILY closes.
//   ANNUALISATION uses periods-per-year: 365 for crypto, which trades every day,
//   and 252 for equities, which do not. Using 252 for a coin understates its
//   volatility by ~17%; using 365 for a stock overstates it by the same.
//
// What these are NOT: forecasts. Every one of them describes the past. Sharpe,
// drawdown and VaR say how an asset has behaved, and the only honest use is to
// compare how assets have behaved — "which one has paid the most per unit of
// risk taken" — never "which one will". The analytics tool and Atlas's prompt
// both carry that framing; this file just makes sure the arithmetic is right.

const PERIODS = { crypto: 365, stock: 252, equity: 252 };

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function periodsPerYear(kind) {
  return PERIODS[String(kind || '').toLowerCase()] || 365;
}

// ── Basic statistics ─────────────────────────────────────────────

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). The population form understates risk on short series. */
function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * Quantile by linear interpolation between order statistics — the "type 7"
 * definition that numpy and R use by default, so a number here can be checked
 * against either.
 */
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

// ── Returns ──────────────────────────────────────────────────────

/** Simple daily returns from a close series. */
function returns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    if (isNum(prices[i]) && isNum(prices[i - 1]) && prices[i - 1] !== 0) {
      out.push(prices[i] / prices[i - 1] - 1);
    }
  }
  return out;
}

function totalReturn(prices) {
  if (prices.length < 2 || !prices[0]) return null;
  return prices[prices.length - 1] / prices[0] - 1;
}

/**
 * Compound annual growth rate. Refuses to annualise a very short series: a
 * 3-day +10% "annualises" to five figures, and that number would be quoted.
 */
function cagr(prices, kind, { minPeriods = 30 } = {}) {
  const n = prices.length - 1;
  if (n < minPeriods || !prices[0] || prices[prices.length - 1] <= 0) return null;
  return (prices[prices.length - 1] / prices[0]) ** (periodsPerYear(kind) / n) - 1;
}

// ── Risk ─────────────────────────────────────────────────────────

function volatility(prices, kind) {
  const r = returns(prices);
  const sd = stdev(r);
  if (sd == null) return null;
  return { daily: sd, annual: sd * Math.sqrt(periodsPerYear(kind)) };
}

/**
 * Sharpe ratio: excess annual return per unit of annual volatility.
 *   (mean_daily * P - rf) / (sd_daily * sqrt(P))
 * rf is an ANNUAL rate and defaults to 0 — stated in every output rather than
 * silently assumed, because the right risk-free rate depends on the currency and
 * the date, and quoting one from memory would be a made-up number.
 */
function sharpe(prices, kind, riskFreeRate = 0) {
  const r = returns(prices);
  const sd = stdev(r);
  if (sd == null || sd === 0) return null;
  const P = periodsPerYear(kind);
  return (mean(r) * P - riskFreeRate) / (sd * Math.sqrt(P));
}

/**
 * Sortino ratio: like Sharpe, but only DOWNSIDE deviation counts as risk.
 * An asset that jumps up unpredictably is not risky in the way that matters to
 * someone holding it, and Sharpe penalises that; Sortino does not.
 *   downside deviation = sqrt( mean( min(0, r - rf_daily)^2 ) ) over ALL periods
 */
function sortino(prices, kind, riskFreeRate = 0) {
  const r = returns(prices);
  if (r.length < 2) return null;
  const P = periodsPerYear(kind);
  const rfDaily = riskFreeRate / P;
  const dd = Math.sqrt(r.reduce((a, x) => a + Math.min(0, x - rfDaily) ** 2, 0) / r.length);
  if (dd === 0) return null; // never had a down day in the window — undefined, not infinite
  return (mean(r) * P - riskFreeRate) / (dd * Math.sqrt(P));
}

/**
 * Drawdowns. `max` is the worst peak-to-trough fall in the window; `current` is
 * how far today sits below the highest close seen. The current figure is the one
 * a monitor watches — it is what a trailing stop measures.
 */
function drawdown(prices) {
  if (prices.length < 2) return null;
  let peak = prices[0];
  let peakIdx = 0;
  let max = 0;
  let maxPeakIdx = 0;
  let maxTroughIdx = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > peak) { peak = prices[i]; peakIdx = i; }
    const dd = prices[i] / peak - 1;
    if (dd < max) { max = dd; maxPeakIdx = peakIdx; maxTroughIdx = i; }
  }
  const highest = Math.max(...prices);
  return {
    max,                                   // e.g. -0.42 = fell 42% from a peak
    current: prices[prices.length - 1] / highest - 1,
    peakIndex: prices.lastIndexOf(highest),
    maxPeakIndex: maxPeakIdx,
    maxTroughIndex: maxTroughIdx
  };
}

/** Calmar ratio: annual growth per unit of worst drawdown. */
function calmar(prices, kind) {
  const g = cagr(prices, kind);
  const d = drawdown(prices);
  if (g == null || !d || d.max === 0) return null;
  return g / Math.abs(d.max);
}

/**
 * Historical 1-day Value at Risk and Expected Shortfall at `level` (default 95%).
 * Reported as POSITIVE loss fractions: var95 = 0.06 means "on the worst 5% of
 * days in this window, the loss was at least 6%". Historical, not parametric —
 * crypto returns are too fat-tailed for a normal-distribution VaR to be honest.
 */
function valueAtRisk(prices, level = 0.95) {
  const r = returns(prices);
  if (r.length < 20) return null; // fewer than 20 days has no meaningful 5% tail
  const cut = quantile(r, 1 - level);
  const tail = r.filter((x) => x <= cut);
  return {
    level,
    var: -cut,
    expectedShortfall: tail.length ? -mean(tail) : null,
    observations: r.length
  };
}

// ── Technical indicators ─────────────────────────────────────────

function sma(prices, k) {
  if (prices.length < k) return null;
  return mean(prices.slice(-k));
}

/** Full EMA series, seeded with the SMA of the first k values. */
function emaSeries(prices, k) {
  if (prices.length < k) return [];
  const alpha = 2 / (k + 1);
  const out = new Array(k - 1).fill(null);
  let e = mean(prices.slice(0, k));
  out.push(e);
  for (let i = k; i < prices.length; i++) {
    e = alpha * prices[i] + (1 - alpha) * e;
    out.push(e);
  }
  return out;
}

function ema(prices, k) {
  const s = emaSeries(prices, k);
  return s.length ? s[s.length - 1] : null;
}

/**
 * RSI with Wilder's smoothing (the original 1978 definition, and what charting
 * platforms show). A plain moving average of gains and losses gives a visibly
 * different number, and users will compare this against their exchange's chart.
 */
function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** MACD(12,26,9): line = EMA12 - EMA26, signal = EMA9 of the line. */
function macd(prices, fast = 12, slow = 26, signalK = 9) {
  if (prices.length < slow + signalK) return null;
  const f = emaSeries(prices, fast);
  const s = emaSeries(prices, slow);
  const line = [];
  for (let i = 0; i < prices.length; i++) {
    if (f[i] != null && s[i] != null) line.push(f[i] - s[i]);
  }
  const sig = emaSeries(line, signalK);
  const m = line[line.length - 1];
  const g = sig[sig.length - 1];
  return { macd: m, signal: g, histogram: m - g };
}

/**
 * Bollinger Bands(20, 2). Uses the POPULATION standard deviation of the window,
 * which is Bollinger's own definition — unlike volatility above, where the
 * sample form is correct. %B locates the price inside the band: 0 = lower band,
 * 1 = upper band, below 0 = broke out underneath.
 */
function bollinger(prices, k = 20, mult = 2) {
  if (prices.length < k) return null;
  const w = prices.slice(-k);
  const mid = mean(w);
  const sd = Math.sqrt(w.reduce((a, x) => a + (x - mid) ** 2, 0) / k);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const p = prices[prices.length - 1];
  return { middle: mid, upper, lower, percentB: upper === lower ? null : (p - lower) / (upper - lower) };
}

// ── Relationships between assets ─────────────────────────────────

/** Pearson correlation of two equal-length return series. */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Sample covariance of two equal-length return series. */
function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - 1);
}

/** Beta against a benchmark: how much the asset moves per 1% of benchmark move. */
function beta(assetReturns, benchReturns) {
  const c = covariance(assetReturns, benchReturns);
  const v = covariance(benchReturns, benchReturns);
  if (c == null || !v) return null;
  return c / v;
}

/**
 * Portfolio volatility from weights and a covariance matrix: sqrt(w' Σ w).
 *
 * This is the number that makes diversification real. Two assets with 60%
 * volatility each, perfectly correlated, give a 60% portfolio; uncorrelated,
 * ~42%. Summing each position's own volatility by weight ignores exactly the
 * thing a portfolio is for.
 *
 * @param {number[]} weights       sum to 1
 * @param {number[][]} returnSets  aligned daily return series, one per asset
 */
function portfolioVolatility(weights, returnSets, kind) {
  const n = weights.length;
  if (n !== returnSets.length || n === 0) return null;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = covariance(returnSets[i], returnSets[j]);
      if (c == null) return null;
      variance += weights[i] * weights[j] * c;
    }
  }
  if (variance < 0) return null; // numerical noise on degenerate input
  const daily = Math.sqrt(variance);
  return { daily, annual: daily * Math.sqrt(periodsPerYear(kind)) };
}

/**
 * Concentration. HHI = sum of squared weights; its reciprocal is the "effective
 * number of positions". Twelve holdings where one is 90% of the value is, in
 * risk terms, closer to one holding than twelve — and this says so in a number.
 */
function concentration(weights) {
  const w = weights.filter(isNum);
  const total = w.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const hhi = w.reduce((a, x) => a + (x / total) ** 2, 0);
  return { hhi, effectivePositions: 1 / hhi };
}

// ── The honest version of "how long should I hold it" ────────────

/**
 * Rolling-horizon history: across every h-day window in the series, what did
 * holding for h days actually return?
 *
 * This is the evidence behind a holding period, instead of a prediction about
 * one. "Held for 180 days, ADA finished up in 38% of windows over the last four
 * years, median -12%, worst -71%" tells a person what the horizon has meant in
 * practice — and says nothing about what it will mean next time, which is the
 * part no formula can know.
 */
function horizonOutcomes(prices, h) {
  if (!Number.isInteger(h) || h < 1 || prices.length <= h) return null;
  const r = [];
  for (let i = 0; i + h < prices.length; i++) {
    if (prices[i] > 0) r.push(prices[i + h] / prices[i] - 1);
  }
  if (r.length < 10) return null; // too few windows to describe a distribution
  return {
    horizonDays: h,
    windows: r.length,
    shareProfitable: r.filter((x) => x > 0).length / r.length,
    median: quantile(r, 0.5),
    p10: quantile(r, 0.1),
    p90: quantile(r, 0.9),
    worst: Math.min(...r),
    best: Math.max(...r),
    // Overlapping windows share most of their days, so they are NOT independent
    // samples. Stated so a large window count is not mistaken for confidence.
    overlapping: true
  };
}

module.exports = {
  PERIODS, periodsPerYear,
  mean, stdev, quantile,
  returns, totalReturn, cagr,
  volatility, sharpe, sortino, drawdown, calmar, valueAtRisk,
  sma, ema, emaSeries, rsi, macd, bollinger,
  correlation, covariance, beta, portfolioVolatility, concentration,
  horizonOutcomes
};
