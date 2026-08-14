// tools/RedditTool.js — community sentiment/discussion via Reddit's public JSON
// endpoints (no OAuth key needed; a real User-Agent is mandatory or Reddit 429s).
// Reddit is OPINION, not fact: every result is flagged unverified and the tool
// tells the agent to cross-check specifics against wikipedia/news/search before
// reporting them as true.
const axios = require('axios');
const { runProviders } = require('./SearchTool');

const UA = 'FinChat/1.0 (research agent by u/finchat; +https://finchat.local)';

// Fallback when Reddit's JSON API 403s (it bot-blocks datacenter IPs): find Reddit
// threads via a site-scoped search. This used to run its own DuckDuckGo scrape, which
// meant the fallback was dead in exactly the deployment where it was needed — DDG
// blackholes datacenter IPs, so a 403 from Reddit was followed by a 12s timeout and
// no results at all. It now goes through the shared provider chain (SearxNG/Tavily/
// Brave/DDG), so it works anywhere `search` works. Fewer fields than the JSON API
// (no score or comment count), but real thread links the agent can open with fetch.
async function searchFallback(query, subreddit, limit) {
  const scope = subreddit ? `site:reddit.com/r/${subreddit.replace(/^r\//, '')}` : 'site:reddit.com';
  const { results, source, attempts } = await runProviders(`${scope} ${query}`, Math.min(limit, 10));
  const mapped = results
    .filter(r => /reddit\.com\/r\//.test(r.url || ''))
    .map(r => {
      const subMatch = r.url.match(/reddit\.com\/(r\/[^/]+)/);
      return {
        title: r.title,
        subreddit: subMatch ? subMatch[1] : '',
        excerpt: String(r.snippet || '').slice(0, 300),
        url: r.url
      };
    });
  return { results: mapped, source, attempts };
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
    console.warn(`⚠️ RedditTool JSON API failed (${err.message}) — falling back to site-scoped search`);
  }

  // API blocked or empty → site:reddit.com search via the shared provider chain
  if (!results.length) {
    try {
      const fb = await searchFallback(query, subreddit, limit);
      results = fb.results;
      via = fb.source ? `search:${fb.source}` : 'search';

      // Chain exhausted: this is a tool outage, and the model must not read it as
      // "nobody on Reddit has discussed this" — same failure that had agents
      // declaring real things non-existent.
      if (!results.length && !fb.source) {
        return {
          query,
          results: [],
          source: 'reddit',
          searchUnavailable: true,
          error:
            `REDDIT LOOKUP UNAVAILABLE — the Reddit API blocked this request and every ` +
            `search provider then failed (${fb.attempts.join('; ')}). This is a tool outage, ` +
            'NOT evidence. Do NOT tell the user that there is no discussion on this topic; ' +
            'say that the Reddit lookup is currently unavailable.'
        };
      }
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
