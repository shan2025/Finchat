// tools/AnalyticsTool.js — the quantitative read on an asset or a portfolio.
//
// Atlas already had prices, a portfolio valuation and a rules-based signal.
// What he lacked was the vocabulary a professional risk desk actually uses:
// volatility, Sharpe and Sortino, drawdown, Value at Risk, correlation, and
// how much of a portfolio's risk each position really contributes. This tool
// computes them from daily closing prices, using services/quant/metrics.js,
// where every formula is tested against a hand-worked value.
//
// THE LINE THIS TOOL HOLDS. Every number here describes what has happened.
// None of it predicts what will. That is not modesty — it is what the maths
// is. A Sharpe ratio says an asset has paid well for its risk over a window;
// it says nothing about the next window. So:
//   • `compare` ranks by risk-adjusted return OVER A PAST WINDOW, and says so.
//   • `horizon` reports what holding for N days has historically returned —
//     the evidence behind a holding period — rather than recommending one.
//   • Interpretations ("readings") describe a condition by its textbook
//     definition. They never instruct.
// It never sizes a position and never tells the user to buy or sell.
const m = require('../services/quant/metrics');
const history = require('../services/quant/history');

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +(x * 100).toFixed(d));
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

const DISCLAIMER = 'Computed from historical daily closes. Describes past behaviour only — not a forecast and not financial advice.';

function parseInput(input) {
  if (input && typeof input === 'object') return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) { try { return JSON.parse(s); } catch (e) { /* fall through */ } }
  return s ? { action: 'asset', symbol: s } : {};
}

// ── Plain-language readings ──────────────────────────────────────
// Deterministic, so the same numbers always produce the same sentence, and
// worded as definitions rather than calls. "Below its 200-day average — the
// common definition of a long-term downtrend" is a fact about a chart.
// "Sell before it falls further" would be advice, and would be wrong as often
// as the definition fails, which is often.
function readingsFor(p) {
  const out = [];
  const t = p.trend || {};
  const r = p.risk || {};

  if (t.rsi14 != null) {
    if (t.rsi14 >= 70) out.push(`RSI ${t.rsi14}: above 70, the conventional "overbought" line — it describes strong recent buying, and on its own is not a reversal signal.`);
    else if (t.rsi14 <= 30) out.push(`RSI ${t.rsi14}: below 30, the conventional "oversold" line — it describes heavy recent selling, and on its own is not a rebound signal.`);
  }
  if (t.priceVsSma200Pct != null) {
    out.push(t.priceVsSma200Pct < 0
      ? `${Math.abs(t.priceVsSma200Pct)}% below its 200-day average — the common definition of a long-term downtrend.`
      : `${t.priceVsSma200Pct}% above its 200-day average — the common definition of a long-term uptrend.`);
  }
  if (t.sma50 != null && t.sma200 != null) {
    out.push(t.sma50 < t.sma200
      ? '50-day average is below the 200-day ("death cross" configuration).'
      : '50-day average is above the 200-day ("golden cross" configuration).');
  }
  if (t.macd && t.macd.histogram != null) {
    out.push(t.macd.histogram < 0
      ? 'MACD is below its signal line — short-term momentum has been weakening.'
      : 'MACD is above its signal line — short-term momentum has been strengthening.');
  }
  if (t.bollingerPercentB != null) {
    if (t.bollingerPercentB < 0) out.push('Closed below its lower Bollinger band — an unusually large move relative to the last 20 days.');
    else if (t.bollingerPercentB > 1) out.push('Closed above its upper Bollinger band — an unusually large move relative to the last 20 days.');
  }
  if (r.currentDrawdownPct != null && r.currentDrawdownPct <= -20) {
    out.push(`${Math.abs(r.currentDrawdownPct)}% below its highest close in the window.`);
  }
  if (r.sharpe != null && r.sharpe < 0) {
    out.push('Negative Sharpe: over this window it has not compensated for its volatility — a riskless asset would have done better.');
  }
  if (r.volatilityAnnualPct != null && r.volatilityAnnualPct >= 80) {
    const daily = num(r.volatilityAnnualPct / Math.sqrt(m.periodsPerYear(p.kind)), 1);
    out.push(`Very volatile: ${r.volatilityAnnualPct}% annualised, a typical daily swing of about ±${daily}%.`);
  }
  if (r.var95Pct != null) {
    out.push(`On the worst 5% of days in this window it lost at least ${r.var95Pct}% (1-day historical VaR 95%).`);
  }
  return out;
}

// ── One asset ────────────────────────────────────────────────────

async function profile({ symbol, kind = 'crypto', exchange = null, days = 365, riskFreeRate = 0 }) {
  if (history.isStablecoin(symbol)) {
    return {
      symbol: String(symbol).toUpperCase(),
      stablecoin: true,
      note: 'A stablecoin is designed to hold a fixed value, so volatility and return statistics do not describe it. The risk that matters is losing the peg — the alert monitor watches for that.'
    };
  }

  const h = await history.closes({ symbol, kind, exchange, days });
  const P = h.prices;
  const last = P[P.length - 1];

  const vol = m.volatility(P, h.kind);
  const dd = m.drawdown(P);
  const v = m.valueAtRisk(P);
  const sma200 = m.sma(P, 200);
  const sma50 = m.sma(P, 50);
  const mac = m.macd(P);
  const bb = m.bollinger(P);

  const result = {
    symbol: h.symbol,
    kind: h.kind,
    basis: { source: h.source, days: h.days, from: h.dates[0], to: h.dates[h.dates.length - 1], currency: h.currency },
    lastClose: num(last, last < 10 ? 6 : 2),
    returns: {
      totalPct: pct(m.totalReturn(P)),
      annualisedPct: pct(m.cagr(P, h.kind))
    },
    risk: {
      volatilityAnnualPct: pct(vol && vol.annual),
      sharpe: num(m.sharpe(P, h.kind, riskFreeRate)),
      sortino: num(m.sortino(P, h.kind, riskFreeRate)),
      calmar: num(m.calmar(P, h.kind)),
      maxDrawdownPct: pct(dd && dd.max),
      currentDrawdownPct: pct(dd && dd.current),
      var95Pct: pct(v && v.var),
      expectedShortfall95Pct: pct(v && v.expectedShortfall)
    },
    trend: {
      sma20: num(m.sma(P, 20), last < 10 ? 6 : 2),
      sma50: num(sma50, last < 10 ? 6 : 2),
      sma200: num(sma200, last < 10 ? 6 : 2),
      priceVsSma50Pct: sma50 ? pct(last / sma50 - 1) : null,
      priceVsSma200Pct: sma200 ? pct(last / sma200 - 1) : null,
      rsi14: num(m.rsi(P), 1),
      macd: mac ? { line: num(mac.macd, 6), signal: num(mac.signal, 6), histogram: num(mac.histogram, 6) } : null,
      bollingerPercentB: bb ? num(bb.percentB) : null
    },
    riskFreeRateAssumed: riskFreeRate
  };
  result.readings = readingsFor(result);
  return result;
}

// ── A whole portfolio ────────────────────────────────────────────

/**
 * Align several close series on their shared dates, so correlation compares
 * the same days. Crypto trades on weekends and equities do not; zipping by index
 * would silently compare a Monday against a Saturday.
 */
function alignedReturns(seriesList) {
  const common = seriesList
    .map((s) => new Set(s.dates))
    .reduce((acc, set) => new Set([...acc].filter((d) => set.has(d))));
  const dates = [...common].sort();
  return seriesList.map((s) => {
    const byDate = new Map(s.dates.map((d, i) => [d, s.prices[i]]));
    return m.returns(dates.map((d) => byDate.get(d)));
  });
}

async function portfolioAnalysis({ userId, days = 90, minWeightPct = 1, riskFreeRate = 0 }) {
  const portfolio = require('./PortfolioTool');
  const val = await portfolio.execute({ action: 'value' }, { userId });
  if (!val.holdings || !val.holdings.length) {
    return { action: 'portfolio', error: 'The portfolio is empty, so there is nothing to analyse.' };
  }

  // Dust is excluded: a ₹0.03 position contributes nothing to risk and would
  // otherwise cost a history request and a row in every table below.
  const material = val.holdings.filter((h) => (h.weightPct || 0) >= minWeightPct);
  const skipped = val.holdings.length - material.length;

  const loaded = [];
  const failed = [];
  for (const h of material) {
    if (history.isStablecoin(h.symbol)) {
      loaded.push({ holding: h, stable: true });
      continue;
    }
    try {
      const series = await history.closes({ symbol: h.symbol, kind: h.kind, exchange: h.exchange, days });
      loaded.push({ holding: h, series });
    } catch (err) {
      failed.push({ symbol: h.symbol, error: err.message });
    }
  }

  const risky = loaded.filter((x) => !x.stable);
  const perAsset = risky.map(({ holding, series }) => {
    const P = series.prices;
    const vol = m.volatility(P, series.kind);
    const dd = m.drawdown(P);
    return {
      symbol: holding.symbol,
      weightPct: holding.weightPct,
      volatilityAnnualPct: pct(vol && vol.annual),
      sharpe: num(m.sharpe(P, series.kind, riskFreeRate)),
      maxDrawdownPct: pct(dd && dd.max),
      currentDrawdownPct: pct(dd && dd.current),
      totalReturnPct: pct(m.totalReturn(P))
    };
  });

  // Covariance-based portfolio risk. Stablecoins enter as zero-return series:
  // they genuinely damp portfolio volatility, and leaving them out would
  // overstate risk for anyone holding cash-like positions. Stated in the output.
  let portfolioRisk = null;
  let riskContribution = [];
  let correlations = [];
  if (risky.length) {
    const aligned = alignedReturns(risky.map((x) => x.series));
    const len = Math.min(...aligned.map((a) => a.length));
    const sets = [
      ...aligned.map((a) => a.slice(-len)),
      ...loaded.filter((x) => x.stable).map(() => new Array(len).fill(0))
    ];
    const members = [...risky, ...loaded.filter((x) => x.stable)];
    const totalW = members.reduce((a, x) => a + (x.holding.weightPct || 0), 0);
    const w = members.map((x) => (x.holding.weightPct || 0) / totalW);

    // The aligned calendar is the INTERSECTION of trading days, so a single
    // equity turns every series into a trading-day series. Annualising that
    // with sqrt(365) would overstate the portfolio's volatility by ~20%.
    const calendar = risky.every((x) => x.series.kind === 'crypto') ? 'crypto' : 'stock';

    if (len >= 10) {
      const pv = m.portfolioVolatility(w, sets, calendar);
      // Risk contribution: RC_i = w_i * (Σw)_i / (w'Σw). Sums to 1.
      // This is the number that corrects intuition: a position that is 40% of
      // the value can easily be 70% of the risk.
      const cov = sets.map((a) => sets.map((b) => m.covariance(a, b) || 0));
      const sigmaW = cov.map((row) => row.reduce((acc, c, j) => acc + c * w[j], 0));
      const variance = w.reduce((acc, wi, i) => acc + wi * sigmaW[i], 0);

      portfolioRisk = {
        volatilityAnnualPct: pct(pv && pv.annual),
        basisDays: len,
        sumOfStandaloneVolPct: pct(
          risky.reduce((acc, x, i) => acc + w[i] * (m.stdev(sets[i]) || 0), 0) * Math.sqrt(m.periodsPerYear(calendar))),
        note: 'Covariance-based (sqrt of w\'Σw). The gap to the weighted sum of individual volatilities is what diversification is actually buying you.'
      };
      if (variance > 0) {
        riskContribution = members.map((x, i) => ({
          symbol: x.holding.symbol,
          weightPct: x.holding.weightPct,
          riskSharePct: pct((w[i] * sigmaW[i]) / variance)
        })).sort((a, b) => (b.riskSharePct || 0) - (a.riskSharePct || 0));
      }
      for (let i = 0; i < risky.length; i++) {
        for (let j = i + 1; j < risky.length; j++) {
          correlations.push({
            pair: `${risky[i].holding.symbol}/${risky[j].holding.symbol}`,
            correlation: num(m.correlation(sets[i], sets[j]))
          });
        }
      }
    }
  }

  const conc = m.concentration(material.map((h) => h.weightPct || 0));
  const readings = [];
  if (conc) {
    readings.push(`Effective number of positions: ${num(conc.effectivePositions, 1)} across ${material.length} material holdings (HHI ${num(conc.hhi, 3)}). The lower this is relative to the count, the more one position dominates.`);
  }
  const top = riskContribution[0];
  if (top && top.weightPct != null && top.riskSharePct != null && top.riskSharePct - top.weightPct >= 15) {
    readings.push(`${top.symbol} is ${top.weightPct}% of the value but ${top.riskSharePct}% of the risk.`);
  }
  const high = correlations.filter((c) => c.correlation != null && c.correlation >= 0.8);
  if (high.length) {
    readings.push(`Highly correlated pairs (≥0.8), which tend to fall together and diversify each other little: ${high.map((c) => c.pair).join(', ')}.`);
  }

  return {
    action: 'portfolio',
    totalValueInr: val.totalValueInr,
    windowDays: days,
    perAsset,
    portfolioRisk,
    riskContribution,
    correlations,
    concentration: conc ? { hhi: num(conc.hhi, 3), effectivePositions: num(conc.effectivePositions, 1) } : null,
    readings,
    excluded: {
      dustBelowWeightPct: minWeightPct,
      count: skipped,
      historyUnavailable: failed.length ? failed : undefined
    },
    riskFreeRateAssumed: riskFreeRate,
    disclaimer: DISCLAIMER
  };
}

// ── Several assets side by side ──────────────────────────────────

const RANKABLE = new Set(['sortino', 'sharpe', 'calmar', 'maxDrawdown', 'volatility', 'totalReturn']);

async function compare({ symbols = [], kind = 'crypto', days = 365, rankBy = 'sortino', riskFreeRate = 0 }) {
  const list = [...new Set((Array.isArray(symbols) ? symbols : String(symbols).split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  if (list.length < 2) return { action: 'compare', error: 'Give at least two symbols to compare.' };
  const by = RANKABLE.has(rankBy) ? rankBy : 'sortino';

  const rows = [];
  for (const symbol of list) {
    if (history.isStablecoin(symbol)) {
      rows.push({ symbol, stablecoin: true, note: 'Pegged asset — excluded from return rankings.' });
      continue;
    }
    try {
      const h = await history.closes({ symbol, kind, days });
      const P = h.prices;
      const vol = m.volatility(P, h.kind);
      const dd = m.drawdown(P);
      rows.push({
        symbol,
        days: h.days,
        totalReturn: pct(m.totalReturn(P)),
        volatility: pct(vol && vol.annual),
        sharpe: num(m.sharpe(P, h.kind, riskFreeRate)),
        sortino: num(m.sortino(P, h.kind, riskFreeRate)),
        calmar: num(m.calmar(P, h.kind)),
        maxDrawdown: pct(dd && dd.max)
      });
    } catch (err) {
      rows.push({ symbol, error: err.message });
    }
  }

  // Higher is better for ratios and returns; for drawdown (a negative number)
  // and volatility, lower magnitude is better.
  const lowerIsBetter = by === 'volatility';
  const rankable = rows.filter((r) => r[by] != null);
  rankable.sort((a, b) => (lowerIsBetter ? a[by] - b[by] : b[by] - a[by]));
  rankable.forEach((r, i) => { r.rank = i + 1; });

  return {
    action: 'compare',
    windowDays: days,
    rankedBy: by,
    ranking: rankable,
    unranked: rows.filter((r) => r[by] == null),
    framing: `Ranked by ${by} over the past ${days} days: which of these has paid the most per unit of risk IN THAT WINDOW. It is not a prediction of which will do best next, and a different window can reverse the order — say both when you report it.`,
    riskFreeRateAssumed: riskFreeRate,
    disclaimer: DISCLAIMER
  };
}

// ── What a holding period has meant historically ─────────────────

async function horizon({ symbol, kind = 'crypto', exchange = null, horizons = [7, 30, 90, 180, 365], days = 1095 }) {
  if (history.isStablecoin(symbol)) {
    return { action: 'horizon', symbol, stablecoin: true, note: 'A stablecoin is designed not to move, so holding-period returns do not describe it.' };
  }
  const h = await history.closes({ symbol, kind, exchange, days });
  const outcomes = (Array.isArray(horizons) ? horizons : [horizons])
    .map((n) => Math.round(Number(n)))
    .filter((n) => n >= 1)
    .map((n) => {
      const o = m.horizonOutcomes(h.prices, n);
      if (!o) return { horizonDays: n, note: `Not enough history (${h.days} days) to observe ${n}-day windows.` };
      return {
        horizonDays: n,
        windows: o.windows,
        profitableSharePct: pct(o.shareProfitable, 1),
        medianPct: pct(o.median, 1),
        p10Pct: pct(o.p10, 1),
        p90Pct: pct(o.p90, 1),
        worstPct: pct(o.worst, 1),
        bestPct: pct(o.best, 1)
      };
    });

  return {
    action: 'horizon',
    symbol: h.symbol,
    basis: { source: h.source, days: h.days, from: h.dates[0], to: h.dates[h.dates.length - 1] },
    outcomes,
    framing: 'For every N-day window in the history, what holding for N days actually returned. This is the evidence behind a holding period, not a recommendation of one. Windows overlap, so they are not independent — a large count is not a large amount of evidence, and one bull or bear run can dominate every horizon. Past windows say nothing about the next one.',
    disclaimer: DISCLAIMER
  };
}

// ── Entry point ──────────────────────────────────────────────────

async function execute(input, context = {}) {
  const o = parseInput(input);
  const action = String(o.action || (o.symbols ? 'compare' : o.symbol ? 'asset' : 'portfolio')).toLowerCase();
  const rf = Number.isFinite(Number(o.riskFreeRate)) ? Number(o.riskFreeRate) : 0;

  try {
    if (action === 'asset') {
      if (!o.symbol) return { error: 'Give a symbol, e.g. {"action":"asset","symbol":"BTC"}.' };
      const p = await profile({ symbol: o.symbol, kind: o.kind || 'crypto', exchange: o.exchange, days: o.days || 365, riskFreeRate: rf });
      return { action: 'asset', ...p, disclaimer: DISCLAIMER };
    }
    if (action === 'portfolio') {
      if (!context.userId || context.userId === 'system') throw new Error('Portfolio analytics needs a signed-in user.');
      return await portfolioAnalysis({ userId: context.userId, days: o.days || 90, minWeightPct: o.minWeightPct ?? 1, riskFreeRate: rf });
    }
    if (action === 'compare') {
      return await compare({ symbols: o.symbols, kind: o.kind || 'crypto', days: o.days || 365, rankBy: o.rankBy, riskFreeRate: rf });
    }
    if (action === 'horizon') {
      if (!o.symbol) return { error: 'Give a symbol, e.g. {"action":"horizon","symbol":"ETH"}.' };
      return await horizon({ symbol: o.symbol, kind: o.kind || 'crypto', exchange: o.exchange, horizons: o.horizons, days: o.days || 1095 });
    }
    return { error: `Unknown analytics action "${action}". Use asset, portfolio, compare or horizon.` };
  } catch (err) {
    return { action, error: err.message, disclaimer: DISCLAIMER };
  }
}

module.exports = { execute, readingsFor, alignedReturns };
