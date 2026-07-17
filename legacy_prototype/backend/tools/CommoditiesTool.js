// tools/CommoditiesTool.js — Live commodity prices (gold, silver, oil, natural gas, etc.)
// via Yahoo Finance's public futures endpoints. This is why Aurelius previously
// couldn't answer "gold and silver price today" — we only had equity + crypto tools.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Map friendly commodity names → Yahoo Finance futures tickers.
const SYMBOL_MAP = {
  gold: 'GC=F',
  silver: 'SI=F',
  platinum: 'PL=F',
  palladium: 'PA=F',
  copper: 'HG=F',
  oil: 'CL=F',
  'crude oil': 'CL=F',
  brent: 'BZ=F',
  'natural gas': 'NG=F',
  gas: 'NG=F',
  corn: 'ZC=F',
  wheat: 'ZW=F',
  soybean: 'ZS=F',
  coffee: 'KC=F',
  sugar: 'SB=F',
  cotton: 'CT=F',
  cocoa: 'CC=F'
};

function resolve(name) {
  if (!name) return { ticker: null, canonical: null };
  const key = String(name).toLowerCase().trim();
  if (SYMBOL_MAP[key]) return { ticker: SYMBOL_MAP[key], canonical: key };
  // Partial match — e.g. "silver bullion" → silver
  for (const canon of Object.keys(SYMBOL_MAP)) {
    if (key.includes(canon)) return { ticker: SYMBOL_MAP[canon], canonical: canon };
  }
  // Assume the caller passed a raw ticker
  return { ticker: key.toUpperCase(), canonical: key };
}

async function fetchOne(commodity) {
  const { ticker, canonical } = resolve(commodity);
  if (!ticker) return { commodity, error: 'Unknown commodity' };
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
      {
        params: { interval: '1d', range: '1d' },
        headers: { 'User-Agent': UA },
        timeout: 10000
      }
    );
    const r = res.data?.chart?.result?.[0];
    if (!r) return { commodity: canonical || commodity, error: `No data for ${ticker}` };
    const meta = r.meta;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    const change = prev ? +(price - prev).toFixed(2) : 0;
    const changePercent = prev ? +((change / prev) * 100).toFixed(2) : 0;
    return {
      commodity: canonical || commodity,
      ticker,
      price,
      change,
      changePercent,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || 'unknown',
      source: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return { commodity, error: `Yahoo Finance error: ${err.message}` };
  }
}

/**
 * Look up one or more commodities.
 *
 * @param {string|object} input - "gold", "gold, silver", or {commodities: [...]}, {commodity: "..."}
 */
async function execute(input) {
  let list = [];
  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      if (Array.isArray(p.commodities)) list = p.commodities;
      else if (p.commodity) list = [p.commodity];
      else list = input.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    } catch {
      list = input.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    }
  } else if (input && typeof input === 'object') {
    if (Array.isArray(input.commodities)) list = input.commodities;
    else if (input.commodity) list = [input.commodity];
  }

  if (list.length === 0) return { error: 'No commodity specified. Try "gold" or "gold, silver".', results: [] };

  const results = await Promise.all(list.slice(0, 6).map(fetchOne));
  return { count: results.length, results };
}

module.exports = { execute };
