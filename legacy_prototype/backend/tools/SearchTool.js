// tools/SearchTool.js — Real web search, with a provider chain.
//
// History: this used to scrape html.duckduckgo.com directly. That works from a
// residential IP but is silently blackholed from datacenter IPs (Render), so every
// call burned the full timeout and returned []. Worse, the empty result read to the
// model as "this topic does not exist" — it once told a user a real Basheer short
// story was "non-existent or misattributed" when in fact search had simply timed out.
//
// So: try real search APIs first (they work from anywhere), keep the DDG scrape as a
// last-ditch option, fall back to Wikipedia, and if everything fails say plainly that
// SEARCH IS BROKEN rather than that nothing was found.
const axios = require('axios');
const wikipedia = require('./WikipediaTool');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
const TIMEOUT = 12000;

// Extract inner text from an HTML fragment (drops tags, decodes minimal entities).
function textOnly(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c))
    .replace(/&([a-z]+);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e] || ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// DDG's HTML result URLs are wrapped in a /l/?uddg=<encoded> redirect. Unwrap them.
function unwrapDdgUrl(href) {
  if (!href) return '';
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* pass */ } }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

// ---------------------------------------------------------------- providers

// Brave Search API — $5/1,000 requests with $5 of free credit each month (~1,000 free
// requests), 50 q/s. Requires a card on file, and bills it past the credit.
async function braveSearch(query, limit) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count: limit },
    headers: {
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    timeout: TIMEOUT
  });
  return (res.data?.web?.results || []).slice(0, limit).map(r => ({
    title: textOnly(r.title),
    url: r.url,
    snippet: textOnly(r.description).slice(0, 300)
  }));
}

// SearxNG — self-hosted metasearch. No key, no quota, no vendor, so it goes first
// when configured. Two caveats worth knowing before you point SEARXNG_URL anywhere:
//   1. JSON is NOT in SearxNG's default `formats` list (html only). The instance must
//      set `search.formats: [html, json]` or this returns an HTML page and parses to 0.
//   2. It proxies Google/Bing/DDG rather than indexing anything itself, so hosting it
//      on a datacenter IP just relocates the blocking that broke the DDG scrape. Host
//      it on a residential/clean IP or it will not help.
// Public instances are unusable for this: most disable JSON, and the rest rate-limit.
async function searxngSearch(query, limit) {
  const base = process.env.SEARXNG_URL.replace(/\/+$/, '');
  const res = await axios.get(`${base}/search`, {
    params: { q: query, format: 'json', language: 'en' },
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      ...(process.env.SEARXNG_AUTH ? { Authorization: process.env.SEARXNG_AUTH } : {})
    },
    timeout: TIMEOUT
  });
  if (typeof res.data !== 'object' || !Array.isArray(res.data?.results)) {
    throw new Error('instance did not return JSON — enable `formats: [html, json]` in its settings.yml');
  }
  return res.data.results.slice(0, limit).map(r => ({
    title: textOnly(r.title),
    url: r.url,
    snippet: textOnly(r.content).slice(0, 300)
  }));
}

// Tavily — search API built for LLM use; returns clean snippets. Free "Researcher"
// tier is 1,000 credits/month with no card required, and hard-stops at the cap.
async function tavilySearch(query, limit) {
  const res = await axios.post('https://api.tavily.com/search', {
    api_key: process.env.TAVILY_API_KEY,
    query,
    max_results: limit,
    search_depth: 'basic'
  }, { timeout: TIMEOUT, headers: { 'Content-Type': 'application/json' } });
  return (res.data?.results || []).slice(0, limit).map(r => ({
    title: textOnly(r.title),
    url: r.url,
    snippet: textOnly(r.content).slice(0, 300)
  }));
}

// DuckDuckGo HTML scrape — kept as a fallback because it works from residential
// IPs (local dev) even when no API key is configured. Expect it to fail on Render.
async function ddgSearch(query, limit) {
  const res = await axios.post(
    'https://html.duckduckgo.com/html/',
    new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
    {
      headers: {
        // Full browser-style header set — DDG anomaly-blocks minimal clients.
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://duckduckgo.com/',
        'Origin': 'https://duckduckgo.com',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      decompress: true,
      timeout: TIMEOUT,
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 400
    }
  );

  const html = res.data || '';
  const results = [];
  const anchorRe = /<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html)) !== null && results.length < limit) {
    const rawUrl = m[1];
    const title = textOnly(m[2]);
    if (!title || !rawUrl) continue;
    const url = unwrapDdgUrl(rawUrl);
    if (!/^https?:\/\//.test(url)) continue;

    // Try to grab the matching snippet right after this anchor
    const restOfBlock = html.slice(m.index, m.index + 3000);
    const snipMatch = restOfBlock.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snipMatch ? textOnly(snipMatch[1]) : '';

    results.push({ title, url, snippet: snippet.slice(0, 300) });
  }
  return results;
}

// Self-hosted SearxNG first (free and unmetered), then Tavily, then Brave. The last two
// are not ordered by quality — Tavily's free tier simply stops at its monthly cap, while
// Brave bills the card on file once the $5 monthly credit is spent. Burning the
// hard-capped provider first means a runaway loop costs nothing.
// `available` keeps unconfigured providers out of the chain so a missing key is skipped
// instantly instead of costing a failed round-trip.
const PROVIDERS = [
  { name: 'searxng', available: () => !!process.env.SEARXNG_URL, run: searxngSearch },
  { name: 'tavily', available: () => !!process.env.TAVILY_API_KEY, run: tavilySearch },
  { name: 'brave', available: () => !!process.env.BRAVE_API_KEY, run: braveSearch },
  { name: 'duckduckgo', available: () => process.env.SEARCH_DISABLE_DDG !== 'true', run: ddgSearch }
];

// ---------------------------------------------------------------- entrypoint

/**
 * Execute a real web search. Returns up to `limit` results with title/url/snippet.
 *
 * On total provider failure the result carries `searchUnavailable: true` and an
 * `error` that tells the model to report a broken tool — NOT to conclude that the
 * subject does not exist, and NOT to answer from memory as if it had searched.
 *
 * @param {string|object} input - the query string, or {query, limit}
 * @returns {Promise<{ query: string, results: Array<{title, snippet, url}>, source: string }>}
 */
async function execute(input) {
  let query, limit = 6;
  if (typeof input === 'string') {
    try { const p = JSON.parse(input); query = p.query || input; if (p.limit) limit = +p.limit; }
    catch { query = input.trim(); }
  } else {
    query = (input?.query || '').trim();
    if (input?.limit) limit = +input.limit;
  }

  if (!query) return { query, results: [], source: 'none', error: 'empty query' };
  limit = Math.max(1, Math.min(10, limit || 6));

  const attempts = [];

  for (const provider of PROVIDERS) {
    if (!provider.available()) continue;
    try {
      const results = await provider.run(query, limit);
      if (results.length) return { query, results, source: provider.name };
      attempts.push(`${provider.name}: 0 results`);
    } catch (err) {
      const detail = err.response?.status ? `HTTP ${err.response.status}` : err.message;
      console.warn(`⚠️ SearchTool provider ${provider.name} failed: ${detail}`);
      attempts.push(`${provider.name}: ${detail}`);
    }
  }

  // Every web provider is down. Wikipedia's API is not IP-blocked from datacenters,
  // so try it with the FULL query before giving up — for encyclopedic subjects it
  // usually has the answer the scraper would have found.
  try {
    const wiki = await wikipedia.execute({ query, limit: Math.min(limit, 5) });
    if (wiki?.results?.length) {
      return {
        query,
        results: wiki.results,
        topArticle: wiki.topArticle || null,
        source: 'wikipedia-fallback',
        degraded: true,
        note: `Web search is unavailable right now (${attempts.join('; ')}). These results are from Wikipedia only, so coverage is limited to encyclopedic topics and may be out of date. Tell the user that general web search is currently down and that this answer is Wikipedia-sourced.`
      };
    }
  } catch (err) {
    attempts.push(`wikipedia-fallback: ${err.message}`);
  }

  return {
    query,
    results: [],
    source: 'none',
    searchUnavailable: true,
    error:
      'WEB SEARCH IS CURRENTLY UNAVAILABLE — every search provider failed ' +
      `(${attempts.join('; ')}). This is a tool outage, NOT evidence about the query. ` +
      'You MUST tell the user plainly that your web search is not working right now. ' +
      'Do NOT say that the topic was "not found", "does not exist", or is "misattributed" — ' +
      'you did not actually get to search. If you know something about the subject from your ' +
      'own knowledge you may share it, but label it clearly as unverified recall rather than ' +
      'a search result.'
  };
}

module.exports = { execute };
