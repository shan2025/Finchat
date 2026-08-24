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
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/', topics: ['tech', 'ai', 'research'] },
  // Bloomberg public RSS is intermittent/partly paywalled — kept because when it
  // responds it's high-signal; per-feed errors are swallowed below if it 403s.
  { name: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', topics: ['markets', 'finance'] },
  { name: 'Bloomberg Technology', url: 'https://feeds.bloomberg.com/technology/news.rss', topics: ['tech', 'ai'] },
  // Reuters as a reliable markets fallback so a Bloomberg outage never leaves the brief empty.
  { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews', topics: ['markets', 'finance', 'business'] },
  // --- Catalyst feeds: the "why prices move" sources beyond market headlines ---
  // Regulation is a first-order catalyst (an SEC action can move a whole sector).
  { name: 'SEC Press', url: 'https://www.sec.gov/news/pressreleases.rss', topics: ['regulation', 'markets'] },
  // Macro: Fed policy, rates, inflation — the tide that lifts or sinks all boats.
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', topics: ['macro', 'markets'] },
  // Geopolitics: war, sanctions, elections — risk-on/risk-off drivers.
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', topics: ['geopolitics', 'world'] }
];

const MAX_AGE_HOURS = 48;
const MAX_ITEMS = 12;

// Catalyst taxonomy — what actually moves markets, mapped to detection keywords.
// Each headline is tagged with every category it matches so Aurelius can reason
// about the DRIVER, not just the price. Order is roughly by market impact.
const CATALYST_KEYWORDS = {
  regulation: ['sec ', 'lawsuit', 'regulat', 'ban ', 'banned', 'approve', 'approval', 'court', 'ruling', 'congress', 'senate', 'cftc', 'legislation', 'legal', 'tax', 'sanction', 'enforcement', 'settlement'],
  macro: ['federal reserve', 'the fed', 'interest rate', 'rate cut', 'rate hike', 'inflation', 'cpi', 'ppi', 'jobs report', 'unemployment', 'gdp', 'powell', 'treasury yield', 'recession', 'stimulus', 'monetary'],
  geopolitics: ['war', 'invasion', 'sanction', 'ukraine', 'russia', 'israel', 'iran', 'gaza', 'middle east', 'tariff', 'trade war', 'election', 'coup', 'conflict', 'military'],
  institutional: ['blackrock', 'microstrategy', 'strategy ', 'grayscale', 'institution', 'whale', 'treasury', 'accumulat', 'holdings', 'spot etf', 'etf inflow', 'etf outflow', 'fidelity', 'vanguard', 'pension', 'hedge fund', 'sovereign'],
  celebrity: ['musk', 'elon', 'trump', 'saylor', 'celebrity', 'influencer', 'endorse', 'tweet'],
  adoption: ['partnership', 'integration', 'mainnet', 'upgrade', 'adoption', 'payment', 'listing', 'launch', 'acquire', 'acquisition', 'merger', 'ipo', 'funding round', 'raises'],
  earnings: ['earnings', 'revenue', 'guidance', 'quarterly', 'profit', 'loss', 'beat estimates', 'missed estimates', 'forecast'],
  security: ['hack', 'exploit', 'breach', 'stolen', 'rug pull', 'scam', 'fraud', 'bankrupt', 'liquidat', 'default', 'collapse']
};

function classifyCatalysts(text) {
  const hay = String(text || '').toLowerCase();
  const tags = [];
  for (const [cat, kws] of Object.entries(CATALYST_KEYWORDS)) {
    if (kws.some((k) => hay.includes(k))) tags.push(cat);
  }
  return tags;
}

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

  // Match on WORD BOUNDARIES, not raw substrings. Short tickers like "ETH" and
  // "SOL" otherwise matched inside unrelated words ("dethrones", "solar"),
  // dragging tennis and off-topic headlines into a crypto brief and skewing the
  // catalyst sentiment. \b keeps "SOL"/"$SOL" but drops "solar".
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const termRes = terms.map((t) => new RegExp(`\\b${esc(t)}\\b`, 'i'));

  const now = Date.now();
  let results = all.filter(i => {
    const ts = Date.parse(i.publishedAt);
    const fresh = isNaN(ts) || (now - ts) < MAX_AGE_HOURS * 3600 * 1000;
    if (!fresh) return false;
    if (!termRes.length) return true;
    const hay = `${i.title} ${i.summary}`;
    return termRes.some(re => re.test(hay));
  });

  // Newest first, cap
  results.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  results = results.slice(0, MAX_ITEMS);

  // Tag each headline with the catalyst categories it signals, and roll up a
  // breakdown so the agent can see at a glance WHAT is driving the tape.
  const tag = (items) => items.map((i) => ({ ...i, catalysts: classifyCatalysts(`${i.title} ${i.summary}`) }));
  const breakdown = (items) => {
    const b = {};
    for (const i of items) for (const c of i.catalysts || []) b[c] = (b[c] || 0) + 1;
    return b;
  };

  if (!results.length && terms.length) {
    // Nothing keyword-matched — return the freshest general headlines instead of an empty set
    const fallback = tag(all
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
      .slice(0, 6));
    return { query, matched: 0, note: `No headlines matched "${query}" in the last ${MAX_AGE_HOURS}h; returning the latest general headlines.`, catalystBreakdown: breakdown(fallback), results: fallback, feedErrors: errors };
  }

  const tagged = tag(results);
  return { query, matched: tagged.length, catalystBreakdown: breakdown(tagged), results: tagged, feedErrors: errors };
}

module.exports = { execute };
