// tools/StockTool.js — Stock price lookup using Yahoo Finance v8 API (no API key required)
const axios = require('axios');

/**
 * Look up the current stock price and market data for a given ticker symbol.
 *
 * @param {string} input - Ticker symbol (e.g. "TSLA") or JSON with {ticker: "TSLA"}
 * @returns {Promise<{ ticker, price, change, changePercent, currency, marketState, name }>}
 */
async function execute(input) {
  let ticker;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      ticker = parsed.ticker || input;
    } catch {
      ticker = input.trim().toUpperCase();
    }
  } else {
    ticker = (input?.ticker || '').trim().toUpperCase();
  }

  if (!ticker) {
    return { error: 'No ticker symbol provided', ticker: null };
  }

  try {
    // Yahoo Finance v8 quote API (public, no key required)
    const response = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
      {
        params: {
          interval: '1d',
          range: '1d'
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      }
    );

    const result = response.data?.chart?.result?.[0];
    if (!result) {
      return { error: `No data found for ticker "${ticker}"`, ticker };
    }

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const previousClose = meta.chartPreviousClose || meta.previousClose;
    const change = previousClose ? +(price - previousClose).toFixed(2) : 0;
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
  } catch (err) {
    // Fallback: try a simpler endpoint
    console.warn(`⚠️ StockTool: Yahoo Finance API failed for ${ticker}: ${err.message}`);
    return {
      error: `Unable to fetch stock data for "${ticker}". ${err.message}`,
      ticker
    };
  }
}

module.exports = { execute };
