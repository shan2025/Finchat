// tools/CrawlTool.js — bounded same-site crawl built on FetchTool.
// Hard limits: depth ≤ 2, ≤ 10 pages, same origin only, robots.txt respected,
// 1s politeness delay between fetches. For Nova's research digests.
const axios = require('axios');
const { fetchUrl, normalizeUrl } = require('./FetchTool');

const MAX_DEPTH = 2;
const MAX_PAGES = 10;
const DELAY_MS = 1000;
const EXCERPT = 1200;

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  return { url: s };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Minimal robots.txt check: fetch once per crawl, respect Disallow lines for *.
async function loadRobots(origin) {
  try {
    const res = await axios.get(`${origin}/robots.txt`, { timeout: 8000, responseType: 'text' });
    const lines = String(res.data).split(/\r?\n/);
    const disallows = [];
    let applies = false;
    for (const line of lines) {
      const l = line.trim();
      if (/^user-agent:/i.test(l)) applies = /user-agent:\s*\*/i.test(l);
      else if (applies && /^disallow:/i.test(l)) {
        const p = l.replace(/^disallow:\s*/i, '').trim();
        if (p) disallows.push(p);
      }
    }
    return disallows;
  } catch (e) {
    return []; // no robots.txt → nothing disallowed
  }
}

function robotsAllows(disallows, pathname) {
  return !disallows.some(p => pathname.startsWith(p));
}

async function execute(input) {
  const opts = parseInput(input);
  const startUrl = normalizeUrl(opts.url || opts.link);
  if (!startUrl) throw new Error('CrawlTool needs a starting URL, e.g. {"url":"https://example.com","depth":1}');

  const depth = Math.min(Number(opts.depth) || 1, MAX_DEPTH);
  const maxPages = Math.min(Number(opts.maxPages) || MAX_PAGES, MAX_PAGES);

  const origin = new URL(startUrl).origin;
  const disallows = await loadRobots(origin);

  const queue = [{ url: startUrl, d: 0 }];
  const seen = new Set([startUrl]);
  const pages = [];
  const skipped = [];

  while (queue.length && pages.length < maxPages) {
    const { url, d } = queue.shift();
    try {
      const pathname = new URL(url).pathname;
      if (!robotsAllows(disallows, pathname)) { skipped.push({ url, reason: 'robots.txt' }); continue; }

      if (pages.length > 0) await sleep(DELAY_MS); // politeness delay between requests
      const page = await fetchUrl(url);
      pages.push({
        url: page.url,
        title: page.title,
        excerpt: String(page.text || '').slice(0, EXCERPT),
        depth: d
      });

      if (d < depth) {
        for (const link of page.links || []) {
          if (pages.length + queue.length >= maxPages) break;
          try {
            const u = new URL(link.url);
            if (u.origin !== origin || seen.has(link.url)) continue;
            seen.add(link.url);
            queue.push({ url: link.url, d: d + 1 });
          } catch (e) {}
        }
      }
    } catch (err) {
      skipped.push({ url, reason: err.message });
    }
  }

  return {
    startUrl,
    origin,
    pagesCrawled: pages.length,
    pages,
    skipped: skipped.slice(0, 5),
    limits: { depth, maxPages, note: 'same-origin only, robots.txt respected' }
  };
}

module.exports = { execute };
