// tools/CryptoTool.js — Cryptocurrency price lookup via CoinGecko public API (no API key required)
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

/**
 * Execute a cryptocurrency price lookup using CoinGecko.
 *
 * @param {string} input - Crypto symbol/name (e.g. "BTC", "ethereum", "solana") or JSON with {symbol}
 * @returns {Promise<{ symbol, name, priceUsd, change24h, marketCapUsd, volume24hUsd, lastUpdated }>}
 */
async function execute(input) {
  let symbolInput;

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      symbolInput = parsed.symbol || parsed.coin || parsed.crypto || input;
    } catch {
      symbolInput = input.trim();
    }
  } else {
    symbolInput = (input?.symbol || input?.coin || '').trim();
  }

  if (!symbolInput) {
    return { error: 'No cryptocurrency symbol provided.', symbol: null };
  }

  const { id: coinId, ticker } = resolveSymbol(symbolInput);

  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_market_cap: true,
        include_24hr_vol: true,
        include_last_updated_at: true
      },
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'FinChat-Finance-Agent/1.0'
      }
    });

    const data = response.data[coinId];
    if (!data) {
      return {
        error: `No data found for "${symbolInput}" (resolved to "${coinId}"). Try a different name or ticker.`,
        symbol: ticker
      };
    }

    return {
      symbol: ticker,
      name: coinId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      priceUsd: data.usd,
      change24h: data.usd_24h_change ? +data.usd_24h_change.toFixed(2) : 0,
      marketCapUsd: data.usd_market_cap || 0,
      volume24hUsd: data.usd_24h_vol || 0,
      lastUpdated: data.last_updated_at
        ? new Date(data.last_updated_at * 1000).toISOString()
        : new Date().toISOString(),
      source: 'CoinGecko'
    };
  } catch (err) {
    console.warn(`⚠️ CryptoTool: CoinGecko API failed for ${coinId}: ${err.message}`);

    // Handle rate limiting specifically
    if (err.response?.status === 429) {
      return {
        error: `CoinGecko rate limit reached. Please wait a moment and try again.`,
        symbol: ticker
      };
    }

    return {
      error: `Unable to fetch crypto data for "${symbolInput}". ${err.message}`,
      symbol: ticker
    };
  }
}

module.exports = { execute };
