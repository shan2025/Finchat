// tools/FetchTool.js — fetch a URL and return clean readable text + metadata.
// The follow-through for SearchTool: search finds URLs, fetch extracts content.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
const MAX_TEXT = 6000;
const MAX_BYTES = 2 * 1024 * 1024; // refuse >2MB documents

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return { url: input.url || input.link || '' };
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { const o = JSON.parse(s); return { url: o.url || o.link || '' }; } catch (e) {}
  }
  return { url: s };
}

function normalizeUrl(url) {
  let u = String(url || '').trim().replace(/^["']|["']$/g, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// Strip a raw HTML document down to readable text (readability-lite):
// drop script/style/nav/header/footer/aside/form blocks, prefer <article>/<main>,
// convert block tags to newlines, decode common entities, collapse whitespace.
function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');

  // Prefer semantic main-content containers when present
  const article = h.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || h.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  let body = article ? article[1] : h;

  body = body.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  body = body.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
             .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(n); } catch (e) { return ' '; } });
  return body.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.length < 15) {
    try {
      const abs = new URL(m[1], baseUrl).toString();
      if (!/^https?:/.test(abs) || seen.has(abs)) continue;
      seen.add(abs);
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (text) links.push({ url: abs, text });
    } catch (e) {}
  }
  return links;
}

async function fetchUrl(url) {
  const target = normalizeUrl(url);
  if (!target) throw new Error('FetchTool needs a URL, e.g. {"url": "https://example.com/article"}');

  const res = await axios.get(target, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: 15000,
    maxRedirects: 4,
    maxContentLength: MAX_BYTES,
    responseType: 'text',
    validateStatus: s => s >= 200 && s < 400
  });

  const contentType = String(res.headers['content-type'] || '');
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

  if (contentType.includes('json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    return {
      url: target, contentType: 'json', title: '',
      text: raw.slice(0, MAX_TEXT), links: [],
      truncated: raw.length > MAX_TEXT
    };
  }

  const text = htmlToText(raw);
  return {
    url: target,
    contentType: 'html',
    title: extractTitle(raw),
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    links: extractLinks(raw, target)
  };
}

// Jina Reader fallback (the one durable win from Agent-Reach's playbook): route the
// URL through r.jina.ai, which renders the page (JS included) and returns clean
// markdown. Works keyless from datacenter IPs where a direct GET gets blocked or
// returns a near-empty JS shell; an optional JINA_API_KEY raises the rate limit.
// No login, no proxy, runs fine on Render — unlike Agent-Reach's social channels.
async function fetchViaJina(url) {
  const target = normalizeUrl(url);
  // Jina 403s browser-spoofing User-Agents (anti-scraper); a plain client UA passes.
  // We deliberately do NOT send X-Return-Format:text so Jina keeps the "Title:/URL
  // Source:" header block we parse the title from.
  const headers = { 'User-Agent': 'FinChat-Fetch/1.0', 'Accept': 'text/plain' };
  if (process.env.JINA_API_KEY) headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;

  const res = await axios.get(`https://r.jina.ai/${target}`, {
    headers, timeout: 20000, maxContentLength: MAX_BYTES, responseType: 'text',
    validateStatus: s => s >= 200 && s < 400
  });
  const text = String(res.data || '').trim();
  // Jina prepends "Title: ...\nURL Source: ...\nMarkdown Content:\n" — lift the title.
  const titleMatch = text.match(/^Title:\s*(.+)$/m);
  return {
    url: target,
    contentType: 'markdown',
    title: titleMatch ? titleMatch[1].trim().slice(0, 200) : '',
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    links: [],
    via: 'jina'
  };
}

async function execute(input) {
  const { url } = parseInput(input);
  let page;
  try {
    page = await fetchUrl(url);
    // Thin extraction (block page, cookie wall, or JS-rendered shell) → let Jina try.
    if (page.contentType === 'html' && (page.text || '').length < 200) {
      try {
        const jina = await fetchViaJina(url);
        if ((jina.text || '').length > (page.text || '').length) page = jina;
      } catch (e) { /* keep the thin direct result */ }
    }
  } catch (directErr) {
    // Direct fetch failed outright (403/timeout/DNS) — Jina is the fallback.
    try {
      page = await fetchViaJina(url);
    } catch (jinaErr) {
      throw new Error(`Fetch failed directly (${directErr.message}) and via Jina Reader (${jinaErr.message}).`);
    }
  }
  return { ...page, source: page.url };
}

module.exports = { execute, fetchUrl, fetchViaJina, htmlToText, extractTitle, extractLinks, normalizeUrl };
