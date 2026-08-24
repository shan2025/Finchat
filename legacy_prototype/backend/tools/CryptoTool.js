// tools/CryptoTool.js — Cryptocurrency price lookup.
//
// Primary source is CoinGecko (public/demo/pro). The free public tier rate-limits
// hard (HTTP 429), which is why "the price feed is currently rate-limited" kept
// surfacing to users, so this tool now:
//   1. uses a CoinGecko API key when COINGECKO_API_KEY is set (much higher limit),
//   2. retries a 429 once with a short backoff,
//   3. falls back to keyless exchanges (Binance, then Coinbase) that rarely limit,
//   4. supports HISTORICAL prices (days back, or a single past date) for comparison.
const axios = require('axios');

// Map common ticker symbols to CoinGecko IDs
const TICKER_MAP = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'SOL': 'solana',
  'ADA': 'cardano',
  'DOT': 'polkadot',
  'AVAX': 'avalanche-2',
  'MATIC': 'matic-network',
  'POL': 'matic-network',
  'LINK': 'chainlink',
  'UNI': 'uniswap',
  'ATOM': 'cosmos',
  'XRP': 'ripple',
  'DOGE': 'dogecoin',
  'SHIB': 'shiba-inu',
  'LTC': 'litecoin',
  'BNB': 'binancecoin',
  'ARB': 'arbitrum',
  'OP': 'optimism',
  'NEAR': 'near',
  'APT': 'aptos',
  'SUI': 'sui',
  'FIL': 'filecoin',
  'AAVE': 'aave',
  'MKR': 'maker',
  'CRV': 'curve-dao-token',
  'PEPE': 'pepe',
  'WIF': 'dogwifcoin',
  'RENDER': 'render-token',
  'FET': 'fetch-ai',
  'TAO': 'bittensor',
  'INJ': 'injective-protocol'
};

// CoinGecko ID -> Binance trading pair base. Binance quotes most majors against
// USDT; used for the keyless fallback and historical klines.
const BINANCE_BASE = {
  'bitcoin': 'BTC', 'ethereum': 'ETH', 'solana': 'SOL', 'cardano': 'ADA',
  'polkadot': 'DOT', 'avalanche-2': 'AVAX', 'matic-network': 'MATIC',
  'chainlink': 'LINK', 'uniswap': 'UNI', 'cosmos': 'ATOM', 'ripple': 'XRP',
  'dogecoin': 'DOGE', 'shiba-inu': 'SHIB', 'litecoin': 'LTC', 'binancecoin': 'BNB',
  'arbitrum': 'ARB', 'optimism': 'OP', 'near': 'NEAR', 'aptos': 'APT', 'sui': 'SUI',
  'filecoin': 'FIL', 'aave': 'AAVE', 'maker': 'MKR', 'curve-dao-token': 'CRV',
  'pepe': 'PEPE', 'dogwifcoin': 'WIF', 'render-token': 'RENDER', 'fetch-ai': 'FET',
  'bittensor': 'TAO', 'injective-protocol': 'INJ'
};

// CoinGecko ID -> Kraken quote base. Kraken uses XBT for Bitcoin and XDG for
// Dogecoin; everything else is the plain ticker. Used for the keyless Kraken
// fallback and its OHLC history.
const KRAKEN_BASE = {
  'bitcoin': 'XBT', 'dogecoin': 'XDG'
};

const UA = 'FinChat-Finance-Agent/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function krakenPair(coinId, ticker) {
  const base = KRAKEN_BASE[coinId] || BINANCE_BASE[coinId] || ticker;
  return `${base}USD`;
}

// CoinGecko host/header switch. Demo keys use the public host with an
// x-cg-demo-api-key header; pro keys use the pro host with x-cg-pro-api-key.
function coingeckoConfig() {
  const key = (process.env.COINGECKO_API_KEY || '').trim();
  const pro = /^pro$/i.test(process.env.COINGECKO_PLAN || '');
  if (key && pro) {
    return { base: 'https://pro-api.coingecko.com/api/v3', headers: { 'x-cg-pro-api-key': key } };
  }
  if (key) {
    return { base: 'https://api.coingecko.com/api/v3', headers: { 'x-cg-demo-api-key': key } };
  }
  return { base: 'https://api.coingecko.com/api/v3', headers: {} };
}

/**
 * Resolve a user-provided symbol to a CoinGecko API ID.
 * Accepts: 'BTC', 'bitcoin', 'Bitcoin', 'btc', etc.
 */
function resolveSymbol(input) {
  const cleaned = input.trim().toUpperCase();

  // 1. Direct ticker match
  if (TICKER_MAP[cleaned]) return { id: TICKER_MAP[cleaned], ticker: cleaned };

  // 2. Try lowercase as CoinGecko ID directly
  const asId = input.trim().toLowerCase();
  const reverseMatch = Object.entries(TICKER_MAP).find(([, v]) => v === asId);
  if (reverseMatch) return { id: asId, ticker: reverseMatch[0] };

  // 3. Partial match against known names
  const partialMatch = Object.entries(TICKER_MAP).find(([ticker, id]) =>
    id.includes(asId) || asId.includes(id) || asId.includes(ticker.toLowerCase())
  );
  if (partialMatch) return { id: partialMatch[1], ticker: partialMatch[0] };

  // 4. Fallback: assume user gave a CoinGecko ID directly
  return { id: asId, ticker: cleaned };
}

function prettyName(coinId) {
  return coinId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Current price providers -------------------------------------------------

async function fromCoinGecko(coinId, ticker) {
  const cg = coingeckoConfig();
  const doGet = () => axios.get(`${cg.base}/simple/price`, {
    params: {
      ids: coinId,
      vs_currencies: 'usd',
      include_24hr_change: true,
      include_market_cap: true,
      include_24hr_vol: true,
      include_last_updated_at: true
    },
    timeout: 10000,
    headers: { Accept: 'application/json', 'User-Agent': UA, ...cg.headers }
  });

  let response;
  try {
    response = await doGet();
  } catch (err) {
    // One quick retry on rate limit — CoinGecko's public window is short.
    if (err.response?.status === 429) {
      await sleep(1500);
      response = await doGet();
    } else {
      throw err;
    }
  }

  const data = response.data[coinId];
  if (!data || typeof data.usd !== 'number') {
    return null; // unknown id — let the caller try fallbacks / report not found
  }
  return {
    symbol: ticker,
    name: prettyName(coinId),
    priceUsd: data.usd,
    change24h: data.usd_24h_change != null ? +data.usd_24h_change.toFixed(2) : 0,
    marketCapUsd: data.usd_market_cap || 0,
    volume24hUsd: data.usd_24h_vol || 0,
    lastUpdated: data.last_updated_at
      ? new Date(data.last_updated_at * 1000).toISOString()
      : new Date().toISOString(),
    source: 'CoinGecko'
  };
}

async function fromBinance(coinId, ticker) {
  const base = BINANCE_BASE[coinId];
  if (!base) return null;
  const { data } = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
    params: { symbol: `${base}USDT` },
    timeout: 8000,
    headers: { Accept: 'application/json', 'User-Agent': UA }
  });
  if (!data || data.lastPrice == null) return null;
  return {
    symbol: ticker,
    name: prettyName(coinId),
    priceUsd: +data.lastPrice,
    change24h: data.priceChangePercent != null ? +(+data.priceChangePercent).toFixed(2) : 0,
    marketCapUsd: 0, // exchanges don't expose market cap
    volume24hUsd: data.quoteVolume ? +data.quoteVolume : 0,
    lastUpdated: new Date().toISOString(),
    source: 'Binance (USDT pair)'
  };
}

async function fromCoinbase(coinId, ticker) {
  const base = BINANCE_BASE[coinId] || ticker;
  const { data } = await axios.get(`https://api.coinbase.com/v2/prices/${base}-USD/spot`, {
    timeout: 8000,
    headers: { Accept: 'application/json', 'User-Agent': UA }
  });
  const amount = data?.data?.amount;
  if (amount == null) return null;
  return {
    symbol: ticker,
    name: prettyName(coinId),
    priceUsd: +amount,
    change24h: 0, // spot endpoint has no 24h change
    marketCapUsd: 0,
    volume24hUsd: 0,
    lastUpdated: new Date().toISOString(),
    source: 'Coinbase (spot)'
  };
}

async function fromKraken(coinId, ticker) {
  const { data } = await axios.get('https://api.kraken.com/0/public/Ticker', {
    params: { pair: krakenPair(coinId, ticker) },
    timeout: 8000,
    headers: { Accept: 'application/json', 'User-Agent': UA }
  });
  const result = data?.result;
  if (!result || !Object.keys(result).length) return null;
  const t = Object.values(result)[0]; // result is keyed by Kraken's own pair name
  const last = t?.c?.[0] != null ? +t.c[0] : null;
  const open = t?.o != null ? +t.o : null;
  if (last == null) return null;
  return {
    symbol: ticker,
    name: prettyName(coinId),
    priceUsd: last,
    change24h: open ? +(((last - open) / open) * 100).toFixed(2) : 0,
    marketCapUsd: 0,
    volume24hUsd: t?.v?.[1] ? +(+t.v[1] * last).toFixed(0) : 0, // 24h base vol → USD
    lastUpdated: new Date().toISOString(),
    source: 'Kraken'
  };
}

async function getCurrent(coinId, ticker, symbolInput) {
  const providers = [fromCoinGecko, fromBinance, fromKraken, fromCoinbase];
  let lastErr = null;
  for (const provider of providers) {
    try {
      const result = await provider(coinId, ticker);
      if (result) return result;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ CryptoTool: ${provider.name} failed for ${coinId}: ${err.message}`);
    }
  }
  return {
    error: `Unable to fetch a live price for "${symbolInput}" from CoinGecko, Binance, or Coinbase${lastErr ? ` (last error: ${lastErr.message})` : ''}. Try again shortly or check the symbol.`,
    symbol: ticker
  };
}

// ---- Cross-source comparison -------------------------------------------------
// Query every current-price provider in parallel and report each price plus a
// consensus (median) and spread. Useful for verifying a quote isn't an outlier
// and for spotting when one venue diverges (a signal in itself).
async function compareAll(coinId, ticker, symbolInput) {
  const providers = [fromCoinGecko, fromBinance, fromKraken, fromCoinbase];
  const settled = await Promise.allSettled(providers.map((p) => p(coinId, ticker)));

  const sources = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value && typeof s.value.priceUsd === 'number') {
      sources.push({
        source: s.value.source,
        priceUsd: s.value.priceUsd,
        change24h: s.value.change24h || 0,
        marketCapUsd: s.value.marketCapUsd || 0
      });
    }
  }

  if (!sources.length) {
    return { error: `No source could price "${symbolInput}" right now.`, symbol: ticker };
  }

  const prices = sources.map((s) => s.priceUsd).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const consensusUsd = prices.length % 2 ? prices[mid] : +((prices[mid - 1] + prices[mid]) / 2).toFixed(2);
  const spreadPct = consensusUsd
    ? +(((prices[prices.length - 1] - prices[0]) / consensusUsd) * 100).toFixed(2)
    : 0;
  const marketCapUsd = Math.max(0, ...sources.map((s) => s.marketCapUsd || 0));

  return {
    symbol: ticker,
    name: prettyName(coinId),
    consensusUsd,
    spreadPct,        // gap between highest and lowest venue, % of consensus
    marketCapUsd,
    sourceCount: sources.length,
    sources,          // per-venue price + 24h change
    lastUpdated: new Date().toISOString()
  };
}

// ---- Historical prices (for comparison) --------------------------------------

async function historyFromCoinGecko(coinId, days) {
  const cg = coingeckoConfig();
  const { data } = await axios.get(`${cg.base}/coins/${coinId}/market_chart`, {
    params: { vs_currency: 'usd', days, interval: 'daily' },
    timeout: 12000,
    headers: { Accept: 'application/json', 'User-Agent': UA, ...cg.headers }
  });
  if (!Array.isArray(data?.prices) || data.prices.length === 0) return null;
  return {
    series: data.prices.map(([ts, price]) => ({
      date: new Date(ts).toISOString().slice(0, 10),
      priceUsd: +price.toFixed(price >= 1 ? 2 : 8)
    })),
    source: 'CoinGecko'
  };
}

async function historyFromBinance(coinId, days) {
  const base = BINANCE_BASE[coinId];
  if (!base) return null;
  const { data } = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol: `${base}USDT`, interval: '1d', limit: Math.min(days + 1, 1000) },
    timeout: 10000,
    headers: { Accept: 'application/json', 'User-Agent': UA }
  });
  if (!Array.isArray(data) || data.length === 0) return null;
  return {
    // kline row: [openTime, open, high, low, close, ...]
    series: data.map((k) => ({
      date: new Date(k[0]).toISOString().slice(0, 10),
      priceUsd: +(+k[4]).toFixed(+k[4] >= 1 ? 2 : 8)
    })),
    source: 'Binance (USDT pair)'
  };
}

async function historyFromKraken(coinId, ticker, days) {
  const { data } = await axios.get('https://api.kraken.com/0/public/OHLC', {
    params: { pair: krakenPair(coinId, ticker), interval: 1440 }, // 1440min = 1 day
    timeout: 10000,
    headers: { Accept: 'application/json', 'User-Agent': UA }
  });
  const result = data?.result;
  if (!result) return null;
  const rows = Object.entries(result).find(([k]) => k !== 'last')?.[1];
  if (!Array.isArray(rows) || !rows.length) return null;
  const trimmed = rows.slice(-Math.min(days + 1, rows.length));
  return {
    // OHLC row: [time, open, high, low, close, vwap, volume, count]
    series: trimmed.map((k) => ({
      date: new Date(k[0] * 1000).toISOString().slice(0, 10),
      priceUsd: +(+k[4]).toFixed(+k[4] >= 1 ? 2 : 8)
    })),
    source: 'Kraken'
  };
}

async function getHistory(coinId, ticker, days, symbolInput) {
  const clamped = Math.max(1, Math.min(Math.round(days) || 30, 3650));
  const providers = [
    { name: 'historyFromCoinGecko', fn: () => historyFromCoinGecko(coinId, clamped) },
    { name: 'historyFromBinance', fn: () => historyFromBinance(coinId, clamped) },
    { name: 'historyFromKraken', fn: () => historyFromKraken(coinId, ticker, clamped) }
  ];
  let lastErr = null;
  for (const provider of providers) {
    try {
      const hist = await provider.fn();
      if (hist && hist.series.length) {
        const first = hist.series[0];
        const last = hist.series[hist.series.length - 1];
        const changePct = first.priceUsd
          ? +(((last.priceUsd - first.priceUsd) / first.priceUsd) * 100).toFixed(2)
          : 0;
        return {
          symbol: ticker,
          name: prettyName(coinId),
          rangeDays: clamped,
          startDate: first.date,
          endDate: last.date,
          startPriceUsd: first.priceUsd,
          endPriceUsd: last.priceUsd,
          changePct,
          series: hist.series,
          source: hist.source
        };
      }
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ CryptoTool: ${provider.name} failed for ${coinId}: ${err.message}`);
    }
  }
  return {
    error: `Unable to fetch historical prices for "${symbolInput}"${lastErr ? ` (last error: ${lastErr.message})` : ''}.`,
    symbol: ticker
  };
}

/**
 * Execute a cryptocurrency price lookup.
 *
 * Input forms (string, JSON string, or object):
 *   "BTC"                         → current price
 *   { symbol: "BTC" }             → current price
 *   { symbol: "BTC", days: 30 }   → daily price history for the last 30 days
 *                                    (with start/end price and % change for comparison)
 *   { symbol: "BTC", compare: true } → same coin priced across every venue at once
 *                                    (per-source price + median consensus + spread)
 *
 * @returns current: { symbol, name, priceUsd, change24h, marketCapUsd, volume24hUsd, lastUpdated, source }
 *          history: { symbol, name, rangeDays, startDate, endDate, startPriceUsd, endPriceUsd, changePct, series[], source }
 *          compare: { symbol, name, consensusUsd, spreadPct, marketCapUsd, sourceCount, sources[], lastUpdated }
 */
async function execute(input) {
  let symbolInput = '';
  let days = null;
  let compare = false;

  const readObj = (o) => {
    symbolInput = String(o.symbol || o.coin || o.crypto || o.id || '').trim();
    const d = o.days ?? o.history ?? o.range;
    if (d != null && d !== '' && !isNaN(+d)) days = +d;
    compare = o.compare === true || o.compare === 'true' || o.sources === true;
  };

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') readObj(parsed);
      else symbolInput = input.trim();
    } catch {
      symbolInput = input.trim();
    }
  } else if (input && typeof input === 'object') {
    readObj(input);
  }

  if (!symbolInput) {
    return { error: 'No cryptocurrency symbol provided.', symbol: null };
  }

  const { id: coinId, ticker } = resolveSymbol(symbolInput);

  if (days != null) {
    return getHistory(coinId, ticker, days, symbolInput);
  }
  if (compare) {
    return compareAll(coinId, ticker, symbolInput);
  }
  return getCurrent(coinId, ticker, symbolInput);
}

module.exports = { execute };
