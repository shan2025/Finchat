// tools/SignalTool.js — Deterministic BULL/BEAR/NEUTRAL signal for a crypto OR stock.
//
// Phase 2 of the Aurelius investment-intelligence build, extended to equities.
// Where the crypto/stock/news tools return raw data, this tool SCORES it: it
// fuses price momentum, trend vs a moving average, (for crypto) cross-venue
// agreement, and news-catalyst sentiment into an explainable signal so Aurelius
// reasons from a computed read rather than eyeballing numbers. Every factor's
// contribution is returned so the "why" stays auditable.
//
// NOT financial advice — an educational, rules-based summary of current data. It
// never sizes a position or tells the user to trade.
const crypto = require('./CryptoTool');
const stocks = require('./StockTool');
const news = require('./NewsTool');

// Known crypto tickers/names — used only to auto-detect asset class when the
// caller doesn't pass `kind`. The session tool always passes kind explicitly.
const CRYPTO_SET = new Set(['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'SOL', 'SOLANA', 'ADA', 'CARDANO', 'DOT', 'AVAX', 'MATIC', 'POL', 'LINK', 'UNI', 'ATOM', 'XRP', 'RIPPLE', 'DOGE', 'DOGECOIN', 'SHIB', 'LTC', 'BNB', 'ARB', 'OP', 'NEAR', 'APT', 'SUI', 'FIL', 'AAVE', 'MKR', 'CRV', 'PEPE', 'WIF', 'RENDER', 'FET', 'TAO', 'INJ']);

const BULLISH_WORDS = ['surge', 'soar', 'rally', 'jump', 'jumps', 'spike', 'breakout', 'record high', 'all-time high', 'ath', 'inflow', 'accumulat', 'buy', 'buys', 'bullish', 'gains', 'climbs', 'rebound', 'squeeze', 'approval', 'approved', 'adopt', 'partnership', 'upgrade', 'beat', 'beats', 'raises guidance', 'outperform'];
const BEARISH_WORDS = ['plunge', 'crash', 'drop', 'drops', 'slump', 'sell-off', 'selloff', 'tumble', 'dump', 'liquidat', 'outflow', 'bearish', 'hack', 'exploit', 'stolen', 'ban', 'banned', 'lawsuit', 'fraud', 'bankrupt', 'collapse', 'default', 'decimated', 'fear', 'warns', 'warning', 'miss', 'misses', 'downgrade', 'cuts guidance', 'layoff', 'layoffs', 'probe'];
const UNCERTAINTY_CATS = ['macro', 'geopolitics', 'regulation'];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function countPolarity(text) {
  const h = String(text || '').toLowerCase();
  let pos = 0, neg = 0;
  for (const w of BULLISH_WORDS) if (h.includes(w)) pos++;
  for (const w of BEARISH_WORDS) if (h.includes(w)) neg++;
  return { pos, neg };
}

function parseInput(input) {
  if (input && typeof input === 'object') {
    return { symbol: String(input.symbol || input.ticker || input.coin || '').trim(), kind: input.kind || null };
  }
  const s = String(input || '').trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); return { symbol: String(o.symbol || o.ticker || o.coin || '').trim(), kind: o.kind || null }; } catch {} }
  return { symbol: s, kind: null };
}

function detectKind(symbol, kind) {
  if (kind === 'crypto' || kind === 'stock') return kind;
  return CRYPTO_SET.has(symbol.trim().toUpperCase()) ? 'crypto' : 'stock';
}

/**
 * Shared scoring core. Consumes a normalised bundle and returns the signal plus
 * per-factor contributions, so crypto and stocks are scored the same way.
 * @param {object} d
 * @param {number|null} d.price          current price
 * @param {number} d.change24h           % change vs previous session/24h
 * @param {Array<{price:number}>} d.series  daily close history (oldest→newest)
 * @param {number|null} d.changeWindowPct  % change over the whole window
 * @param {Array} d.newsResults          news tool results[]
 * @param {number|null} d.spreadPct      cross-venue spread (crypto only)
 */
function computeSignal(d) {
  const factors = [];
  let score = 0;
  let price = d.price;

  // 1. Trend vs the window's moving average
  if (Array.isArray(d.series) && d.series.length >= 5) {
    const prices = d.series.map((p) => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    price = price ?? prices[prices.length - 1];
    const vsAvg = ((price - avg) / avg) * 100;
    const c = clamp(Math.round(vsAvg * 1.5), -25, 25);
    score += c;
    factors.push({ factor: 'trend_vs_avg', detail: `${vsAvg >= 0 ? '+' : ''}${vsAvg.toFixed(1)}% vs ${prices.length}d average`, contribution: c });
  }

  // 2. Momentum over the window
  if (typeof d.changeWindowPct === 'number') {
    const c = clamp(Math.round(d.changeWindowPct * 0.6), -25, 25);
    score += c;
    factors.push({ factor: 'momentum_window', detail: `${d.changeWindowPct >= 0 ? '+' : ''}${d.changeWindowPct}% over the window`, contribution: c });
  }

  // 3. Latest session move
  if (d.change24h) {
    const c = clamp(Math.round(d.change24h * 2), -15, 15);
    score += c;
    factors.push({ factor: 'change_recent', detail: `${d.change24h >= 0 ? '+' : ''}${d.change24h}% latest session`, contribution: c });
  }

  // 4. News-catalyst sentiment
  let uncertainty = 0;
  if (Array.isArray(d.newsResults) && d.newsResults.length) {
    let pos = 0, neg = 0;
    for (const r of d.newsResults) {
      const p = countPolarity(`${r.title} ${r.summary || ''}`);
      pos += p.pos; neg += p.neg;
      for (const cat of r.catalysts || []) if (UNCERTAINTY_CATS.includes(cat)) uncertainty++;
    }
    const c = clamp((pos - neg) * 3, -25, 25);
    score += c;
    factors.push({ factor: 'news_sentiment', detail: `${pos} bullish vs ${neg} bearish signals across ${d.newsResults.length} headlines`, contribution: c });
  }

  // 5. Cross-venue disagreement (crypto only — a caution flag)
  if (typeof d.spreadPct === 'number' && d.spreadPct > 1) {
    const c = -clamp(Math.round(d.spreadPct), 0, 10);
    score += c;
    factors.push({ factor: 'venue_spread', detail: `${d.spreadPct}% price gap across venues`, contribution: c });
  }

  score = clamp(Math.round(score), -100, 100);
  let signal = 'NEUTRAL';
  if (score >= 20) signal = 'BULLISH';
  else if (score <= -20) signal = 'BEARISH';

  const agreeing = factors.filter((f) => Math.sign(f.contribution) === Math.sign(score) && f.contribution !== 0).length;
  const confScore = Math.abs(score) + agreeing * 8 + factors.length * 4 - uncertainty * 5;
  const confidence = confScore >= 55 ? 'high' : confScore >= 30 ? 'medium' : 'low';

  return { signal, confidence, score, price, factors };
}

// Only trust headlines that actually matched the asset. NewsTool falls back to
// general headlines when nothing matched (matched === 0) — counting those would
// misattribute unrelated geopolitics to a specific stock and skew sentiment.
function relevantNews(nws) {
  return (nws && nws.matched > 0 && Array.isArray(nws.results)) ? nws.results : [];
}

// Turn "Tesla, Inc." / "NVIDIA Corporation" into a search term ("Tesla",
// "NVIDIA") — company names match RSS headlines far better than tickers.
function companyTerm(name, fallbackTicker) {
  if (!name) return fallbackTicker;
  const cleaned = String(name)
    .replace(/,?\s+(inc|inc\.|incorporated|corp|corp\.|corporation|company|co|co\.|ltd|ltd\.|plc|holdings|group|sa|nv|ag)\b.*$/i, '')
    .trim();
  return cleaned || fallbackTicker;
}

async function gatherCrypto(symbol) {
  const [cmp, hist, nws] = await Promise.all([
    crypto.execute({ symbol, compare: true }).catch((e) => ({ error: e.message })),
    crypto.execute({ symbol, days: 30 }).catch((e) => ({ error: e.message })),
    news.execute({ query: symbol }).catch((e) => ({ error: e.message }))
  ]);
  if (cmp?.error && hist?.error) return { error: `Could not price "${symbol}" (${cmp.error}).` };
  const chg24 = cmp?.sources?.find((s) => s.change24h)?.change24h ?? cmp?.sources?.[0]?.change24h ?? 0;
  const relevant = relevantNews(nws);
  return {
    name: cmp?.name || hist?.name || symbol,
    symbol: (cmp?.symbol || hist?.symbol || symbol).toUpperCase(),
    data: {
      price: cmp?.consensusUsd ?? hist?.endPriceUsd ?? null,
      change24h: chg24,
      series: (hist?.series || []).map((p) => ({ price: p.priceUsd })),
      changeWindowPct: hist?.changePct ?? null,
      windowDays: hist?.rangeDays ?? null,
      newsResults: relevant,
      spreadPct: cmp?.spreadPct ?? null
    },
    catalystBreakdown: relevant.length ? (nws?.catalystBreakdown || {}) : {},
    topHeadlines: relevant.slice(0, 4).map((r) => ({ title: r.title, url: r.url, catalysts: r.catalysts }))
  };
}

async function gatherStock(symbol) {
  // Fetch the quote first so we can search news by company name, not ticker.
  const cur = await stocks.execute(symbol).catch((e) => ({ error: e.message }));
  const name = cur?.name && cur.name !== symbol ? cur.name : null;
  const term = companyTerm(name, symbol);

  const [hist, nws] = await Promise.all([
    stocks.execute({ ticker: symbol, days: 30 }).catch((e) => ({ error: e.message })),
    // No category filter — company news shows up across markets, tech and world
    // feeds (a Tesla recall or an Nvidia export curb is not tagged "markets").
    news.execute({ query: term }).catch((e) => ({ error: e.message }))
  ]);
  if (cur?.error && hist?.error) return { error: `Could not price "${symbol}" (${cur?.error || hist?.error}).` };
  const relevant = relevantNews(nws);
  return {
    name: cur?.name || hist?.name || symbol,
    symbol: (cur?.ticker || hist?.ticker || symbol).toUpperCase(),
    currency: cur?.currency || hist?.currency || 'USD',
    data: {
      price: cur?.price ?? hist?.endPrice ?? null,
      change24h: cur?.changePercent ?? 0,
      series: (hist?.series || []).map((p) => ({ price: p.price })),
      changeWindowPct: hist?.changePct ?? null,
      windowDays: hist?.rangeDays ?? null,
      newsResults: relevant,
      spreadPct: null
    },
    catalystBreakdown: relevant.length ? (nws?.catalystBreakdown || {}) : {},
    topHeadlines: relevant.slice(0, 4).map((r) => ({ title: r.title, url: r.url, catalysts: r.catalysts }))
  };
}

async function execute(input) {
  const { symbol, kind: kindIn } = parseInput(input);
  if (!symbol) return { error: 'No symbol provided for signal analysis.', symbol: null };
  const kind = detectKind(symbol, kindIn);

  const bundle = kind === 'crypto' ? await gatherCrypto(symbol) : await gatherStock(symbol);
  if (bundle.error) return { error: bundle.error, symbol, kind };

  const scored = computeSignal(bundle.data);

  return {
    symbol: bundle.symbol,
    name: bundle.name,
    kind,
    currency: bundle.currency || 'USD',
    signal: scored.signal,
    confidence: scored.confidence,
    score: scored.score,
    priceUsd: scored.price,           // priceUsd kept for backward-compat with the session tool
    price: scored.price,
    change24h: bundle.data.change24h,
    changeWindowPct: bundle.data.changeWindowPct,
    windowDays: bundle.data.windowDays,
    factors: scored.factors,
    catalystBreakdown: bundle.catalystBreakdown,
    topHeadlines: bundle.topHeadlines,
    disclaimer: 'Educational, rules-based signal from current public data — not financial advice. No position sizing, no trade instruction.',
    generatedAt: new Date().toISOString()
  };
}

module.exports = { execute };
