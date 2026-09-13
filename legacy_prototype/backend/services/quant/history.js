// services/quant/history.js — daily closing prices, fetched once, reused.
//
// Both the analytics tool and the alert monitor need the same thing: a clean
// array of daily closes for an asset. Fetching it is the expensive, flaky part —
// CoinGecko rate-limits keyless callers (429), Binance bans Render's shared IP
// on and off, and the monitor runs every 15 minutes for every watched holding.
//
// So history is cached in process memory. Daily bars only change once a day;
// re-fetching a 365-day series on every tick would spend the rate limit on
// numbers that have not moved, and get the whole monitor throttled exactly when
// it matters. The CURRENT price is fetched separately and fresh — see live().
const cryptoTool = require('../../tools/CryptoTool');
const stockTool = require('../../tools/StockTool');
const { cached } = require('../microCache');

// Daily bars — a few hours stale is irrelevant to a 30- or 365-day statistic.
const HISTORY_TTL_MS = 3 * 60 * 60 * 1000;
// Live prices go stale fast, but two alert rules on one asset in the same tick
// should not cost two requests.
const LIVE_TTL_MS = 60 * 1000;

const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'USDD', 'PYUSD']);

const EXCHANGE_SUFFIX = { NSE: '.NS', BSE: '.BO' };

function isStablecoin(symbol) {
  return STABLECOINS.has(String(symbol || '').toUpperCase());
}

/** The ticker Yahoo actually quotes: RELIANCE on NSE is RELIANCE.NS. */
function tickerFor(symbol, exchange) {
  const suffix = EXCHANGE_SUFFIX[String(exchange || '').toUpperCase()];
  const s = String(symbol || '').toUpperCase();
  return suffix && !s.endsWith(suffix) ? `${s}${suffix}` : s;
}

/**
 * Daily closes for one asset, oldest first.
 *
 * Throws on failure rather than returning {error}: the cache would otherwise
 * store an outage as if it were a price series, and every caller for the next
 * three hours would be told the asset has no history.
 *
 * @returns {{ prices:number[], dates:string[], source:string, kind:string, days:number }}
 */
async function closes({ symbol, kind = 'crypto', exchange = null, days = 365 }) {
  const k = String(kind).toLowerCase() === 'crypto' ? 'crypto' : 'stock';
  const ticker = k === 'stock' ? tickerFor(symbol, exchange) : String(symbol).toUpperCase();
  const d = Math.max(30, Math.min(Math.round(days) || 365, 1825));

  return cached(`quant:hist:${k}:${ticker}:${d}`, HISTORY_TTL_MS, async () => {
    const out = k === 'crypto'
      ? await cryptoTool.execute({ symbol: ticker, days: d })
      : await stockTool.execute({ ticker, days: d });

    if (!out || out.error || !Array.isArray(out.series) || out.series.length < 2) {
      throw new Error((out && out.error) || `No price history available for ${ticker}.`);
    }

    const rows = out.series
      .map((p) => ({ date: p.date, price: Number(p.priceUsd ?? p.price) }))
      .filter((p) => Number.isFinite(p.price) && p.price > 0);

    return {
      symbol: ticker,
      kind: k,
      prices: rows.map((r) => r.price),
      dates: rows.map((r) => r.date),
      source: out.source || (k === 'stock' ? 'Yahoo Finance' : 'unknown'),
      days: rows.length,
      currency: k === 'crypto' ? 'USD' : (out.currency || 'USD')
    };
  });
}

/** Current price and 24h change. Short cache — see LIVE_TTL_MS. */
async function live({ symbol, kind = 'crypto', exchange = null }) {
  const k = String(kind).toLowerCase() === 'crypto' ? 'crypto' : 'stock';
  const ticker = k === 'stock' ? tickerFor(symbol, exchange) : String(symbol).toUpperCase();

  return cached(`quant:live:${k}:${ticker}`, LIVE_TTL_MS, async () => {
    const out = k === 'crypto'
      ? await cryptoTool.execute({ symbol: ticker })
      : await stockTool.execute({ ticker });
    const price = Number(k === 'crypto' ? out && out.priceUsd : out && out.price);
    if (!out || out.error || !Number.isFinite(price) || price <= 0) {
      throw new Error((out && out.error) || `No live price for ${ticker}.`);
    }
    return {
      symbol: ticker,
      price,
      change24hPct: Number(k === 'crypto' ? out.change24h : out.changePercent),
      source: out.source || null,
      currency: k === 'crypto' ? 'USD' : (out.currency || 'USD')
    };
  });
}

module.exports = { closes, live, isStablecoin, tickerFor, STABLECOINS };
