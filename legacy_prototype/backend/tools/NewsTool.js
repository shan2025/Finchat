// tools/NewsTool.js — crypto/finance/tech headlines from free RSS feeds
// (no API key needed). CoinDesk + Cointelegraph for crypto, CNBC for markets,
// The Verge/TechCrunch-style feeds for tech/AI. Recency-filtered, keyword-matched.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

const FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', topics: ['crypto'] },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', topics: ['crypto'] },
  { name: 'CNBC Markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', topics: ['markets', 'finance'] },
  { name: 'CNBC Tech', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910', topics: ['tech', 'ai'] },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/', topics: ['tech', 'ai', 'research'] }
];

const MAX_AGE_HOURS = 48;
const MAX_ITEMS = 10;

function parseInput(input) {
  if (typeof input === 'object' && input !== null) {
    return { query: input.query || input.topic || input.symbol || '', category: input.category || '' };
  }
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { const o = JSON.parse(s); return { query: o.query || o.topic || o.symbol || '', category: o.category || '' }; } catch (e) {}
  }
  return { query: s, category: '' };
}

function stripCdata(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function parseRss(xml, feedName) {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < 30) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return mm ? stripCdata(mm[1]) : '';
    };
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    items.push({
      feed: feedName,
      title: pick('title'),
      url: linkMatch ? stripCdata(linkMatch[1]) : '',
      summary: pick('description').slice(0, 220),
      publishedAt: pick('pubDate') || pick('dc:date')
    });
  }
  return items.filter(i => i.title && i.url);
}

// Symbol aliases so "SOL" matches "Solana" headlines etc.
const ALIASES = {
  btc: ['bitcoin'], eth: ['ethereum', 'ether'], sol: ['solana'], doge: ['dogecoin'],
  xrp: ['ripple'], ada: ['cardano'], gold: ['gold', 'bullion'], silver: ['silver']
};

async function execute(input) {
  const { query, category } = parseInput(input);
  const q = query.toLowerCase();
  const terms = q ? [q, ...(ALIASES[q] || [])] : [];

  // Pick feeds: category filter if given, else all
  const feeds = category
    ? FEEDS.filter(f => f.topics.includes(category.toLowerCase()))
    : FEEDS;

  const all = [];
  const errors = [];
  await Promise.all(feeds.map(async f => {
    try {
      const res = await axios.get(f.url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        timeout: 12000, responseType: 'text'
      });
      all.push(...parseRss(res.data, f.name));
    } catch (err) {
      errors.push({ feed: f.name, error: err.message });
    }
  }));

  const now = Date.now();
  let results = all.filter(i => {
    const ts = Date.parse(i.publishedAt);
    const fresh = isNaN(ts) || (now - ts) < MAX_AGE_HOURS * 3600 * 1000;
    if (!fresh) return false;
    if (!terms.length) return true;
    const hay = (i.title + ' ' + i.summary).toLowerCase();
    return terms.some(t => hay.includes(t));
  });

  // Newest first, cap
  results.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  results = results.slice(0, MAX_ITEMS);

  if (!results.length && terms.length) {
    // Nothing keyword-matched — return the freshest general headlines instead of an empty set
    const fallback = all
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
      .slice(0, 5);
    return { query, matched: 0, note: `No headlines matched "${query}" in the last ${MAX_AGE_HOURS}h; returning the latest general headlines.`, results: fallback, feedErrors: errors };
  }

  return { query, matched: results.length, results, feedErrors: errors };
}

module.exports = { execute };
