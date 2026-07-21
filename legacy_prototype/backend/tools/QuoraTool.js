// tools/QuoraTool.js — community Q&A discovery from Quora.
// Quora has NO public API and aggressively blocks direct scraping, so we can't
// read answer bodies reliably. Instead we surface the most relevant Quora
// question threads via a site-scoped DuckDuckGo search (title + snippet + link),
// which the agent can then open with the `fetch` tool if a page is reachable.
// Like Reddit, this is unverified opinion — flagged for cross-checking.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

function textOnly(html) {
  return String(html || '').replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c))
    .replace(/&([a-z]+);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e] || ' '))
    .replace(/\s+/g, ' ').trim();
}

function unwrapDdgUrl(href) {
  if (!href) return '';
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) {} }
  return href.startsWith('//') ? 'https:' + href : href;
}

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
    const res = await axios.post(
      'https://html.duckduckgo.com/html/',
      new URLSearchParams({ q: `site:quora.com ${query}`, kl: 'us-en' }).toString(),
      {
        headers: {
          'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5', 'Referer': 'https://duckduckgo.com/', 'Origin': 'https://duckduckgo.com'
        },
        timeout: 12000, maxRedirects: 3, validateStatus: s => s >= 200 && s < 400
      }
    );

    const html = res.data || '';
    const results = [];
    const anchorRe = /<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = anchorRe.exec(html)) !== null && results.length < Math.min(limit, 10)) {
      const url = unwrapDdgUrl(m[1]);
      const title = textOnly(m[2]);
      if (!title || !/quora\.com/.test(url)) continue;
      const rest = html.slice(m.index, m.index + 3000);
      const snip = rest.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      results.push({ question: title, url, excerpt: snip ? textOnly(snip[1]).slice(0, 300) : '' });
    }

    if (!results.length) return { query, results: [], source: 'quora', note: `No Quora threads found for "${query}". Quora may have blocked the lookup — try the search or reddit tool instead.` };

    return {
      query,
      source: 'quora',
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
