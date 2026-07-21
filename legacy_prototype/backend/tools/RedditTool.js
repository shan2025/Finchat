// tools/RedditTool.js — community sentiment/discussion via Reddit's public JSON
// endpoints (no OAuth key needed; a real User-Agent is mandatory or Reddit 429s).
// Reddit is OPINION, not fact: every result is flagged unverified and the tool
// tells the agent to cross-check specifics against wikipedia/news/search before
// reporting them as true.
const axios = require('axios');

const UA = 'FinChat/1.0 (research agent by u/finchat; +https://finchat.local)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

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

// Fallback when Reddit's JSON API 403s (it bot-blocks datacenter IPs): find
// Reddit threads via a site-scoped DuckDuckGo search. Fewer fields (no score),
// but real relevant thread links the agent can open with fetch.
async function ddgFallback(query, subreddit, limit) {
  const scope = subreddit ? `site:reddit.com/r/${subreddit.replace(/^r\//, '')}` : 'site:reddit.com';
  const res = await axios.post(
    'https://html.duckduckgo.com/html/',
    new URLSearchParams({ q: `${scope} ${query}`, kl: 'us-en' }).toString(),
    {
      headers: {
        'User-Agent': BROWSER_UA, 'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://duckduckgo.com/', 'Origin': 'https://duckduckgo.com'
      },
      timeout: 12000, maxRedirects: 3, validateStatus: s => s >= 200 && s < 400
    }
  );
  const html = res.data || '';
  const out = [];
  const anchorRe = /<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html)) !== null && out.length < Math.min(limit, 10)) {
    const url = unwrapDdgUrl(m[1]);
    const title = textOnly(m[2]);
    if (!title || !/reddit\.com\/r\//.test(url)) continue;
    const rest = html.slice(m.index, m.index + 3000);
    const snip = rest.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const subMatch = url.match(/reddit\.com\/(r\/[^/]+)/);
    out.push({ title, subreddit: subMatch ? subMatch[1] : '', excerpt: snip ? textOnly(snip[1]).slice(0, 300) : '', url });
  }
  return out;
}

function parseInput(input) {
  if (input && typeof input === 'object') return { query: String(input.query || input.topic || '').trim(), subreddit: input.subreddit || '', limit: +input.limit || 6 };
  const s = String(input || '').trim();
  if (s.startsWith('{')) { try { const o = JSON.parse(s); return { query: String(o.query || o.topic || '').trim(), subreddit: o.subreddit || '', limit: +o.limit || 6 }; } catch (e) {} }
  return { query: s, subreddit: '', limit: 6 };
}

function mapPosts(children, limit) {
  return (children || [])
    .filter(c => c?.kind === 't3' && c.data)
    .slice(0, limit)
    .map(c => {
      const d = c.data;
      return {
        title: d.title,
        subreddit: `r/${d.subreddit}`,
        author: `u/${d.author}`,
        score: d.score,
        numComments: d.num_comments,
        upvoteRatio: d.upvote_ratio,
        createdUtc: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        excerpt: String(d.selftext || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        url: `https://www.reddit.com${d.permalink}`
      };
    });
}

/**
 * Search Reddit discussion. Sorted by relevance; higher score/comment counts and
 * a high upvoteRatio indicate broader community agreement (still not proof).
 */
async function execute(input) {
  const { query, subreddit, limit } = parseInput(input);
  if (!query) return { query, results: [], source: 'reddit', error: 'empty query' };

  const base = subreddit
    ? `https://www.reddit.com/r/${encodeURIComponent(subreddit.replace(/^r\//, ''))}/search.json`
    : 'https://www.reddit.com/search.json';
  const params = { q: query, sort: 'relevance', t: 'month', limit: Math.min(limit, 10), raw_json: 1 };
  if (subreddit) params.restrict_sr = 1;

  let results = [];
  let via = 'reddit-api';
  try {
    const res = await axios.get(base, { params, headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 12000 });
    results = mapPosts(res.data?.data?.children, limit);
  } catch (err) {
    console.warn(`⚠️ RedditTool JSON API failed (${err.message}) — falling back to DuckDuckGo site search`);
  }

  // API blocked or empty → DuckDuckGo site:reddit.com fallback
  if (!results.length) {
    try {
      results = await ddgFallback(query, subreddit, limit);
      via = 'duckduckgo';
    } catch (err) {
      console.warn(`⚠️ RedditTool fallback failed: ${err.message}`);
      return { query, results: [], source: 'reddit', error: `Reddit lookup failed (API blocked and search fallback errored: ${err.message}).` };
    }
  }

  if (!results.length) return { query, results: [], source: 'reddit', via, note: `No Reddit discussion found for "${query}".` };

  return {
    query,
    source: 'reddit',
    via,
    verified: false, // community opinion — NOT fact
    crossCheckAdvice: 'These are unverified user opinions. Before reporting any factual claim (a price, date, event, product spec), confirm it with the wikipedia, news, or search tool and cite that authoritative source — not Reddit alone.',
    results
  };
}

module.exports = { execute };
