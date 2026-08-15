// test/stock-tool.test.js — StockTool must not invent tickers.
//
// Live run exec_1786766048068_p7ucu9 reported Apple as "AAPL01.BK, THB 29.75"
// (a Thai depositary receipt) and Tesla as TSLL. Cause: the agent called the
// tool with {"symbols": ["AAPL", "TSLA"]}, the tool used that whole JSON blob
// as the ticker, the quote endpoints 401'd, and the search fallback fuzzy-
// matched the blob. These tests pin the three properties that prevent it:
// the symbol list is parsed, a 401 is raised rather than degraded into a
// guess, and the search fallback accepts exact matches only.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execute, parseSymbols, pickBestMatch, StockAuthError } = require('../tools/StockTool');

const authError = (status = 401) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status }
});

const quote = (ticker, over = {}) => ({
  ticker, name: ticker, price: 100, change: 1, changePercent: 1,
  currency: 'USD', marketState: 'REGULAR', exchangeName: 'NasdaqGS',
  timestamp: new Date().toISOString(), ...over
});

/** Deps whose fetchers only know the given symbols; search is off unless supplied. */
function deps({ known = {}, search = async () => null } = {}) {
  const fetcher = async (t) => known[t] || null;
  return { fetchV8: fetcher, fetchV10: fetcher, searchSymbol: search };
}

describe('parseSymbols', () => {
  test('extracts the list from the agent payload that caused the bug', () => {
    assert.deepStrictEqual(
      parseSymbols('{"symbols": ["AAPL", "TSLA"]}'),
      ['AAPL', 'TSLA']
    );
  });

  test('never yields the raw JSON blob as a ticker', () => {
    for (const sym of parseSymbols('{"symbols": ["AAPL", "TSLA"]}')) {
      assert.doesNotMatch(sym, /[{}"[\]]/);
    }
  });

  test('accepts plain, comma-separated, object and nested forms', () => {
    assert.deepStrictEqual(parseSymbols('aapl'), ['AAPL']);
    assert.deepStrictEqual(parseSymbols('$AAPL, tsla'), ['AAPL', 'TSLA']);
    assert.deepStrictEqual(parseSymbols({ ticker: 'MSFT' }), ['MSFT']);
    assert.deepStrictEqual(parseSymbols({ symbols: ['AAPL', 'AAPL'] }), ['AAPL']);
    assert.deepStrictEqual(parseSymbols({ tickers: [{ symbol: 'NVDA' }] }), ['NVDA']);
  });

  test('returns nothing for empty or malformed input', () => {
    assert.deepStrictEqual(parseSymbols(''), []);
    assert.deepStrictEqual(parseSymbols(null), []);
    assert.deepStrictEqual(parseSymbols('{"symbols": ['), []);
  });
});

describe('pickBestMatch', () => {
  const searchResults = [
    { symbol: 'TSLL', quoteType: 'ETF', exchange: 'NMS', shortname: 'Direxion Daily TSLA Bull' },
    { symbol: 'AAPL01.BK', quoteType: 'EQUITY', exchange: 'SET', shortname: 'APPLE INC DR' },
    { symbol: 'AAPL', quoteType: 'EQUITY', exchange: 'NMS', shortname: 'Apple Inc.' },
    { symbol: 'AAPL.MX', quoteType: 'EQUITY', exchange: 'MEX', shortname: 'Apple Inc.' }
  ];

  test('prefers the primary US listing over foreign depositary lines', () => {
    assert.strictEqual(pickBestMatch('AAPL', searchResults), 'AAPL');
  });

  test('refuses to substitute a near-miss for a ticker query', () => {
    assert.strictEqual(pickBestMatch('TSLA', searchResults), null);
  });

  test('resolves a company name to its US equity', () => {
    assert.strictEqual(pickBestMatch('Apple Inc', searchResults), 'AAPL');
  });

  test('ignores non-tradable result types', () => {
    assert.strictEqual(
      pickBestMatch('AAPL', [{ symbol: 'AAPL', quoteType: 'CURRENCY', exchange: 'NMS' }]),
      null
    );
  });
});

describe('execute', () => {
  test('quotes every symbol in a {"symbols": [...]} call', async () => {
    const out = await execute('{"symbols": ["AAPL", "TSLA"]}', {
      __deps: deps({ known: { AAPL: quote('AAPL'), TSLA: quote('TSLA') } })
    });
    assert.deepStrictEqual(out.quotes.map(q => q.ticker), ['AAPL', 'TSLA']);
    assert.strictEqual(out.count, 2);
    assert.deepStrictEqual(out.errors, []);
  });

  test('a single symbol still returns a bare quote object', async () => {
    const out = await execute('AAPL', { __deps: deps({ known: { AAPL: quote('AAPL') } }) });
    assert.strictEqual(out.ticker, 'AAPL');
    assert.strictEqual(out.price, 100);
  });

  test('401 from the quote API is thrown, not degraded into a search guess', async () => {
    let searched = false;
    const failing = {
      fetchV8: async () => { throw authError(401); },
      fetchV10: async () => { throw authError(401); },
      searchSymbol: async () => { searched = true; return 'TSLL'; }
    };
    await assert.rejects(
      () => execute('{"symbols": ["AAPL", "TSLA"]}', { __deps: failing }),
      (err) => {
        assert.ok(err instanceof StockAuthError);
        assert.strictEqual(err.status, 401);
        assert.match(err.message, /backend\/\.env/);
        return true;
      }
    );
    assert.strictEqual(searched, false, 'must not fall back to symbol search after a 401');
  });

  test('403 is treated the same as 401', async () => {
    await assert.rejects(
      () => execute('AAPL', {
        __deps: {
          fetchV8: async () => { throw authError(403); },
          fetchV10: async () => { throw authError(403); },
          searchSymbol: async () => 'AAPL01.BK'
        }
      }),
      StockAuthError
    );
  });

  test('an unresolvable symbol reports an error instead of a lookalike', async () => {
    const out = await execute('TSLA', {
      __deps: deps({ known: {}, search: async () => null })
    });
    assert.ok(out.error);
    assert.strictEqual(out.ticker, 'TSLA');
    assert.doesNotMatch(JSON.stringify(out), /TSLL|AAPL01/);
  });

  test('per-symbol failures do not sink the symbols that worked', async () => {
    const out = await execute({ symbols: ['AAPL', 'ZZZZ'] }, {
      __deps: deps({ known: { AAPL: quote('AAPL') } })
    });
    assert.deepStrictEqual(out.quotes.map(q => q.ticker), ['AAPL']);
    assert.deepStrictEqual(out.errors.map(e => e.ticker), ['ZZZZ']);
  });

  test('empty input is a clear error', async () => {
    const out = await execute('', { __deps: deps() });
    assert.match(out.error, /No ticker symbol/);
    assert.strictEqual(out.ticker, null);
  });
});
