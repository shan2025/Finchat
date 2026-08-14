// tools/QuoraTool.js — community Q&A discovery from Quora.
// Quora has NO public API and aggressively blocks direct scraping, so we can't
// read answer bodies reliably. Instead we surface the most relevant Quora
// question threads via a site-scoped search (title + snippet + link), which the
// agent can then open with the `fetch` tool if a page is reachable.
// Like Reddit, this is unverified opinion — flagged for cross-checking.
//
// That site-scoped search used to be a private DuckDuckGo scrape, which made this
// tool permanently dead on any datacenter IP (DDG blackholes them). It now runs on
// the shared provider chain in SearchTool, so it works wherever `search` works.
const { runProviders } = require('./SearchTool');

function parseInput(input) {
  if (input && typeof input === 'object') return { query: String(input.query || input.topic || '').trim(), limit: +input.limit || 6 };
  const s = String(input || '').trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); return { query: String(o.query || o.topic || '').trim(), limit: +o.limit || 6 }; } catch (e) {} }
  return { query: s, limit: 6 };
}

async function execute(input) {
  const { query, limit } = parseInput(input);
  if (!query) return { query, results: [], source: 'quora', error: 'empty query' };

  try {
    const { results: hits, source, attempts } = await runProviders(`site:quora.com ${query}`, Math.min(limit, 10));

    const results = hits
      .filter(r => /quora\.com/.test(r.url || ''))
      .map(r => ({ question: r.title, url: r.url, excerpt: String(r.snippet || '').slice(0, 300) }));

    // No provider succeeded at all — an outage, not an absence of discussion.
    if (!source) {
      return {
        query,
        results: [],
        source: 'quora',
        searchUnavailable: true,
        error:
          `QUORA LOOKUP UNAVAILABLE — every search provider failed (${attempts.join('; ')}). ` +
          'Quora has no API, so search is the only way in. This is a tool outage, NOT evidence. ' +
          'Do NOT tell the user that nothing has been asked about this; say the lookup is down.'
      };
    }

    if (!results.length) return { query, results: [], source: 'quora', via: source, note: `No Quora threads found for "${query}". Try the search or reddit tool instead.` };

    return {
      query,
      source: 'quora',
      via: source,
      verified: false, // community opinion — NOT fact
      crossCheckAdvice: 'Quora answers are anonymous opinion of varying quality. Use these only for perspectives/angles; verify every factual claim with the wikipedia, news, or search tool and cite that source. Use fetch on a result URL to read the full thread if you need detail.',
      results
    };
  } catch (err) {
    console.warn(`⚠️ QuoraTool failed: ${err.message}`);
    return { query, results: [], source: 'quora', error: `Quora lookup error: ${err.message}. Fall back to the search or reddit tool.` };
  }
}

module.exports = { execute };
