// tools/StockTool.js — Stock price lookup using Yahoo Finance API (v8, v10, and an
// exact-match search fallback).
//
// Fix 11: the tool used to coerce whatever it was handed into a single "ticker"
// string. An agent call of {"symbols": ["AAPL", "TSLA"]} therefore became the
// literal ticker `{"symbols": ["AAPL", "TSLA"]}`, every quote endpoint failed,
// and the search fallback fuzzy-matched that blob to unrelated listings (TSLL,
// AAPL01.BK on the Thai SET) which were then reported as Apple. Two rules now
// hold: the input is parsed into a real symbol list, and the search fallback
// only accepts an EXACT symbol match, preferring the primary US listing.
// Auth failures (401/403) are surfaced as tool errors instead of silently
// degrading into a guess.
const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Yahoo exchange codes for the primary US listings, best first. */
const US_EXCHANGES = ['NMS', 'NYQ', 'NGM', 'NCM', 'ASE', 'PCX', 'BTS', 'NYS'];

/** A plain ticker: 1-6 alphanumerics, optional class suffix (BRK-B) or market suffix (0700.HK). */
const TICKER_RE = /^[A-Z0-9]{1,6}(?:[.-][A-Z0-9]{1,4})?$/;

class StockAuthError extends Error {
  constructor(status, ticker) {
    super(
      `Yahoo Finance rejected the request for "${ticker}" with HTTP ${status} ` +
      `(unauthorized). The market-data credential is missing, expired or rate-limited — ` +
      `check the stock API settings in backend/.env. No price was retrieved, and none was guessed.`
    );
    this.name = 'StockAuthError';
    this.status = status;
    this.ticker = ticker;
  }
}

function isAuthStatus(err) {
  const status = err?.response?.status;
  return status === 401 || status === 403;
}

/**
 * Extract the list of ticker symbols an agent asked for.
 *
 * Accepts, in any nesting: "AAPL", "AAPL, TSLA", {ticker}, {symbol}, {tickers: []},
 * {symbols: []}, and JSON strings of any of those. Returns [] when nothing
 * ticker-like is present — the caller reports that rather than guessing.
 *
 * @param {string|object} input
 * @returns {string[]} upper-cased symbols, de-duplicated, order preserved
 */
function parseSymbols(input) {
  const out = [];

  const push = (value) => {
    if (typeof value !== 'string') return;
    for (const part of value.split(/[,;\s]+/)) {
      const sym = part.trim().toUpperCase().replace(/^\$/, '');
      if (sym && !out.includes(sym)) out.push(sym);
    }
  };

  const walk = (value, depth = 0) => {
    if (value === null || value === undefined || depth > 4) return;
    if (Array.isArray(value)) {
      value.forEach(v => walk(v, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['ticker', 'tickers', 'symbol', 'symbols', 'query', 'q']) {
        if (key in value) walk(value[key], depth + 1);
      }
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      // A JSON payload arriving as a string is structure, not a ticker.
      if (/^[[{]/.test(trimmed)) {
        try {
          walk(JSON.parse(trimmed), depth + 1);
          return;
        } catch {
          return; // Malformed JSON is never a ticker.
        }
      }
      push(trimmed);
    }
  };

  walk(input);
  return out;
}

async function _fetchV8(ticker) {
  const response = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
    {
      params: { interval: '1d', range: '1d' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    }
  );
  const result = response.data?.chart?.result?.[0];
  if (!result || !result.meta || typeof result.meta.regularMarketPrice === 'undefined') {
    return null;
  }
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const previousClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = +(price - previousClose).toFixed(2);
  const changePercent = previousClose ? +((change / previousClose) * 100).toFixed(2) : 0;

  return {
    ticker: meta.symbol || ticker,
    name: meta.shortName || meta.longName || ticker,
    price,
    change,
    changePercent,
    currency: meta.currency || 'USD',
    marketState: meta.marketState || 'unknown',
    exchangeName: meta.exchangeName || 'unknown',
    timestamp: new Date().toISOString()
  };
}

async function _fetchV10(ticker) {
  const response = await axios.get(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`,
    {
      params: { modules: 'price' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    }
  );
  const priceData = response.data?.quoteSummary?.result?.[0]?.price;
  if (!priceData || typeof priceData.regularMarketPrice?.raw === 'undefined') {
    return null;
  }
  const price = priceData.regularMarketPrice.raw;
  const previousClose = priceData.regularMarketPreviousClose?.raw || price;
  const change = priceData.regularMarketChange?.raw ?? +(price - previousClose).toFixed(2);
  const changePercent = priceData.regularMarketChangePercent?.raw ?? (previousClose ? +((change / previousClose) * 100).toFixed(2) : 0);

  return {
    ticker: priceData.symbol || ticker,
    name: priceData.shortName || priceData.longName || ticker,
    price,
    change: +Number(change).toFixed(2),
    changePercent: +Number(changePercent).toFixed(2),
    currency: priceData.currency || 'USD',
    marketState: priceData.marketState || 'unknown',
    exchangeName: priceData.exchangeName || 'unknown',
    timestamp: new Date().toISOString()
  };
}

/** Map a day count to the smallest Yahoo range that covers it. */
function daysToRange(days) {
  if (days <= 5) return '5d';
  if (days <= 31) return '1mo';
  if (days <= 93) return '3mo';
  if (days <= 186) return '6mo';
  if (days <= 366) return '1y';
  if (days <= 731) return '2y';
  return '5y';
}

/**
 * Daily close history for one ticker via the Yahoo v8 chart endpoint — the same
 * source as the live quote, so history and current price agree. Returns the last
 * `days` daily closes with start/end price and % change, mirroring CryptoTool's
 * history shape so the signal engine can treat both asset classes uniformly.
 */
async function _fetchHistory(ticker, days) {
  const clamped = Math.max(2, Math.min(Math.round(days) || 30, 1825));
  const response = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
    { params: { interval: '1d', range: daysToRange(clamped) }, headers: { 'User-Agent': USER_AGENT }, timeout: 12000 }
  );
  const result = response.data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const stamps = result?.timestamp;
  if (!Array.isArray(closes) || !Array.isArray(stamps) || !closes.length) return null;

  const series = [];
  for (let i = 0; i < stamps.length; i++) {
    if (closes[i] == null) continue; // Yahoo pads gaps (holidays) with nulls
    series.push({ date: new Date(stamps[i] * 1000).toISOString().slice(0, 10), price: +closes[i].toFixed(2) });
  }
  const trimmed = series.slice(-clamped);
  if (!trimmed.length) return null;
  const first = trimmed[0], last = trimmed[trimmed.length - 1];
  return {
    ticker: result.meta?.symbol || ticker,
    name: result.meta?.shortName || result.meta?.longName || ticker,
    rangeDays: clamped,
    startDate: first.date,
    endDate: last.date,
    startPrice: first.price,
    endPrice: last.price,
    changePct: first.price ? +(((last.price - first.price) / first.price) * 100).toFixed(2) : 0,
    series: trimmed,
    currency: result.meta?.currency || 'USD',
    source: 'Yahoo Finance'
  };
}

/**
 * Choose a search result for `query`, or null when nothing is safe to use.
 *
 * For a ticker-shaped query only an EXACT symbol match qualifies; a Thai
 * depositary receipt (AAPL01.BK) or a leveraged ETF (TSLL) is a different
 * instrument, not a fallback for AAPL. Among exact matches the primary US
 * listing wins. A free-text query (a company name) may match by name, still
 * preferring a US equity.
 *
 * @param {string} query
 * @param {Array<object>} quotes Yahoo search `quotes` entries
 * @returns {string|null}
 */
function pickBestMatch(query, quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  const wanted = String(query || '').trim().toUpperCase();
  if (!wanted) return null;

  const tradable = quotes.filter(
    q => q && typeof q.symbol === 'string' &&
      ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(q.quoteType)
  );
  if (tradable.length === 0) return null;

  const rank = (q) => {
    const idx = US_EXCHANGES.indexOf(String(q.exchange || '').toUpperCase());
    // US listings first (in preference order), then everything else.
    return idx === -1 ? US_EXCHANGES.length : idx;
  };
  const best = (list) => list.slice().sort((a, b) => rank(a) - rank(b))[0]?.symbol || null;

  const exact = tradable.filter(q => q.symbol.toUpperCase() === wanted);
  if (exact.length > 0) return best(exact);

  // Ticker-shaped input with no exact match: refuse rather than guess.
  if (TICKER_RE.test(wanted)) return null;

  const byName = tradable.filter(q =>
    String(q.shortname || q.longname || '').toUpperCase().includes(wanted)
  );
  return best(byName.length > 0 ? byName : tradable);
}

async function _searchSymbol(query) {
  try {
    const response = await axios.get(
      'https://query2.finance.yahoo.com/v1/finance/search',
      {
        params: { q: query, quotesCount: 10, newsCount: 0 },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 8000
      }
    );
    return pickBestMatch(query, response.data?.quotes);
  } catch (e) {
    if (isAuthStatus(e)) throw new StockAuthError(e.response.status, query);
    return null;
  }
}

/**
 * Resolve one symbol to a quote, or an {error} object. Auth failures propagate
 * as StockAuthError so the agent sees a credential problem instead of a guess.
 */
async function quoteOne(ticker, deps) {
  const { fetchV8, fetchV10, searchSymbol } = deps;
  let authError = null;

  for (const [label, fetcher] of [['v8', fetchV8], ['v10', fetchV10]]) {
    try {
      const data = await fetcher(ticker);
      if (data) return data;
    } catch (err) {
      if (isAuthStatus(err)) {
        authError = new StockAuthError(err.response.status, ticker);
        console.error(`StockTool ${label} auth failure for ${ticker}: HTTP ${err.response.status}`);
      } else if (err.response?.status !== 404) {
        console.warn(`StockTool ${label} error for ${ticker}: ${err.message}`);
      }
    }
  }

  // A 401/403 means we were never allowed to ask. Guessing a symbol from search
  // would produce a confident wrong number, so surface the credential failure.
  if (authError) throw authError;

  const resolved = await searchSymbol(ticker);
  if (resolved && resolved.toUpperCase() !== ticker) {
    console.log(`StockTool: resolved "${ticker}" -> "${resolved}" via Yahoo search (exact match)`);
    try {
      const data = await fetchV8(resolved) || await fetchV10(resolved);
      if (data) return data;
    } catch (err) {
      if (isAuthStatus(err)) throw new StockAuthError(err.response.status, resolved);
    }
  }

  console.warn(`StockTool: no exact match for symbol "${ticker}"`);
  return {
    error: `Unable to fetch stock data for "${ticker}". No exact symbol match was found — ` +
      `refusing to substitute a similarly-named listing.`,
    ticker
  };
}

/**
 * Look up current price and market data for one or more ticker symbols.
 *
 * @param {string|object} input "TSLA", "AAPL, TSLA", {ticker}, or {symbols: [...]}
 * @param {object} [context] Execution context; `context.__deps` injects fetchers in tests.
 * @returns {Promise<object>} a single quote for one symbol, or {quotes, errors, count}
 */
async function execute(input, context = {}) {
  const deps = {
    fetchV8: _fetchV8,
    fetchV10: _fetchV10,
    searchSymbol: _searchSymbol,
    fetchHistory: _fetchHistory,
    ...(context && context.__deps)
  };

  const symbols = parseSymbols(input);
  if (symbols.length === 0) {
    return {
      error: 'No ticker symbol provided. Pass a symbol string ("AAPL") or {"symbols": ["AAPL", "TSLA"]}.',
      ticker: null
    };
  }

  // History mode: {"ticker":"AAPL","days":30} → daily close series for one ticker.
  const daysRaw = (input && typeof input === 'object') ? (input.days ?? input.history ?? input.range) : null;
  if (daysRaw != null && daysRaw !== '' && !isNaN(+daysRaw)) {
    try {
      const hist = await deps.fetchHistory(symbols[0], +daysRaw);
      return hist || { error: `No price history found for "${symbols[0]}".`, ticker: symbols[0] };
    } catch (err) {
      if (isAuthStatus(err)) throw new StockAuthError(err.response.status, symbols[0]);
      return { error: `Unable to fetch history for "${symbols[0]}". ${err.message}`, ticker: symbols[0] };
    }
  }

  // A StockAuthError propagates out of here: ToolManager then records a tool
  // error the agent must report, instead of a "result" that looks like data.
  const results = await Promise.all(symbols.map(sym => quoteOne(sym, deps)));

  if (symbols.length === 1) return results[0];

  return {
    quotes: results.filter(r => !r.error),
    errors: results.filter(r => r.error).map(r => ({ ticker: r.ticker, error: r.error })),
    count: results.filter(r => !r.error).length,
    timestamp: new Date().toISOString()
  };
}

module.exports = { execute, parseSymbols, pickBestMatch, StockAuthError };
