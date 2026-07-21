// tools/WikipediaTool.js — authoritative reference lookups via the official
// Wikipedia REST/Action APIs (no key required). Because Wikipedia is sourced and
// citation-backed, agents use this as the "ground truth" to CROSS-CHECK claims
// pulled from community sources like Reddit/Quora before reporting them.
const axios = require('axios');

const UA = 'FinChat/1.0 (research agent; contact admin@finchat.local)';
const API = 'https://en.wikipedia.org/w/api.php';
const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

function parseInput(input) {
  if (input && typeof input === 'object') return { query: String(input.query || input.topic || '').trim(), limit: +input.limit || 3 };
  const s = String(input || '').trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); return { query: String(o.query || o.topic || '').trim(), limit: +o.limit || 3 }; } catch (e) {} }
  return { query: s, limit: 3 };
}

/**
 * Look up encyclopedic facts. Returns matching article titles plus a sourced
 * extract for the top hit — the piece an agent should quote when verifying.
 */
async function execute(input) {
  const { query, limit } = parseInput(input);
  if (!query) return { query, results: [], source: 'wikipedia', error: 'empty query' };

  try {
    // 1. Full-text search for candidate articles.
    const searchRes = await axios.get(API, {
      params: { action: 'query', list: 'search', srsearch: query, srlimit: Math.min(limit, 5), format: 'json', origin: '*' },
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 12000
    });
    const hits = (searchRes.data?.query?.search || []).map(h => ({
      title: h.title,
      snippet: String(h.snippet || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`
    }));

    if (!hits.length) return { query, results: [], source: 'wikipedia', note: `No Wikipedia article matched "${query}".` };

    // 2. Fetch a proper sourced summary for the top hit.
    let extract = null, extractUrl = hits[0].url;
    try {
      const sumRes = await axios.get(REST + encodeURIComponent(hits[0].title.replace(/ /g, '_')), {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 12000
      });
      extract = sumRes.data?.extract || null;
      if (sumRes.data?.content_urls?.desktop?.page) extractUrl = sumRes.data.content_urls.desktop.page;
    } catch (e) { /* summary optional — search hits still returned */ }

    return {
      query,
      source: 'wikipedia',
      authoritative: true, // agents may treat this as a verification anchor
      topArticle: extract ? { title: hits[0].title, extract, url: extractUrl } : null,
      results: hits
    };
  } catch (err) {
    console.warn(`⚠️ WikipediaTool failed: ${err.message}`);
    return { query, results: [], source: 'wikipedia', error: `Wikipedia API error: ${err.message}` };
  }
}

module.exports = { execute };
