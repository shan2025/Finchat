// tools/SearchTool.js — Real web search via DuckDuckGo HTML endpoint.
// The old Instant-Answer API returned only Wikipedia abstracts, which is why agents
// answered "no results found" for job queries, market news, etc. This version POSTs
// to the html.duckduckgo.com form (the actual submit path used by the site UI) and
// parses the results — real titles + URLs + snippets.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

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

/**
 * Execute a real web search. Returns up to `limit` results with title/url/snippet.
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

  if (!query) return { query, results: [], source: 'duckduckgo', error: 'empty query' };
  limit = Math.max(1, Math.min(10, limit || 6));

  try {
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
        timeout: 12000,
        maxRedirects: 3,
        validateStatus: (s) => s >= 200 && s < 400
      }
    );

    const html = res.data || '';

    // Parse each result block. A single "result" contains a title <a class="result__a">
    // and a snippet <a class="result__snippet"> (or a div with the same class).
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

    if (results.length === 0) {
      return {
        query,
        results: [],
        source: 'duckduckgo',
        note: 'Search returned no parseable results. The query may be too specific or the search backend may have blocked the request. Suggest a broader query.'
      };
    }

    return { query, results, source: 'duckduckgo' };
  } catch (err) {
    console.warn(`⚠️ SearchTool failed: ${err.message}`);
    return {
      query,
      results: [],
      source: 'duckduckgo',
      error: `Search backend error: ${err.message}. Suggest the user try a different query, or provide guidance from general knowledge.`
    };
  }
}

module.exports = { execute };
