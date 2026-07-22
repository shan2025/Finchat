// tools/StockTool.js — Stock price lookup using Yahoo Finance API (v8, v10, and search fallbacks)
// Fix 7: Added v10 quoteSummary fallback and symbol resolution via Yahoo search API when v8 returns 404.
const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function _fetchV8(ticker) {
  const response = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
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
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}`,
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

async function _searchSymbol(query) {
  try {
    const response = await axios.get(
      'https://query2.finance.yahoo.com/v1/finance/search',
      {
        params: { q: query, quotesCount: 3, newsCount: 0 },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 8000
      }
    );
    const quotes = response.data?.quotes;
    if (Array.isArray(quotes) && quotes.length > 0) {
      // Find first equity, etf, or index symbol
      const found = quotes.find(q => q.symbol && ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(q.quoteType)) || quotes[0];
      return found.symbol;
    }
  } catch (e) {
    // Ignore search errors
  }
  return null;
}

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

  // Attempt 1: Yahoo Finance v8 chart API
  try {
    const data = await _fetchV8(ticker);
    if (data) return data;
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn(`⚠️ StockTool v8 error for ${ticker}: ${err.message}`);
    }
  }

  // Attempt 2: Yahoo Finance v10 quoteSummary API
  try {
    const data = await _fetchV10(ticker);
    if (data) return data;
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn(`⚠️ StockTool v10 error for ${ticker}: ${err.message}`);
    }
  }

  // Attempt 3: Symbol resolution search (if ticker was a company name or wrong exchange suffix)
  const resolvedSymbol = await _searchSymbol(ticker);
  if (resolvedSymbol && resolvedSymbol.toUpperCase() !== ticker) {
    console.log(`🔍 StockTool: resolved "${ticker}" -> "${resolvedSymbol}" via Yahoo search`);
    try {
      const data = await _fetchV8(resolvedSymbol) || await _fetchV10(resolvedSymbol);
      if (data) return data;
    } catch (e) {
      // fallback failed
    }
  }

  console.warn(`⚠️ StockTool: All Yahoo Finance endpoints failed for symbol "${ticker}"`);
  return {
    error: `Unable to fetch stock data for "${ticker}". Symbol may be invalid or Yahoo Finance API unreachable.`,
    ticker
  };
}

module.exports = { execute };
