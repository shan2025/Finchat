// services/linkAttach.js — turn what a user (or an agent) pasted into link
// attachments, for mind map nodes and board cards alike.
//
// Accepts explicit {url, title} pairs, free text with URLs in it, or both. Each
// URL is classified from the URL alone (linkInfo.js — never fetched). A Drive
// or Docs link with no title is named from Drive when the user has connected
// it, so the card says "Duxbe POS — Spec v2" instead of "Google Doc".
const { classify, defaultTitle, extractUrls } = require('./linkInfo');

const MAX_LINKS = 25;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A YouTube video's real title, from YouTube's public oEmbed endpoint.
 *
 * The one outside fetch this file makes, and it is safe for the reason the
 * rest are refused: the HOST is fixed (www.youtube.com), and the user's URL is
 * only a query parameter to it — never somewhere the server connects to.
 * Best effort: a slow or failed answer just leaves the generic name.
 */
async function youtubeTitle(videoUrl) {
  try {
    const axios = require('axios');
    const res = await axios.get('https://www.youtube.com/oembed', {
      params: { url: videoUrl, format: 'json' }, timeout: 4000, maxRedirects: 0
    });
    return clean(res.data && res.data.title, 200);
  } catch (e) {
    return '';
  }
}

/**
 * @param {string} userId
 * @param {{links?: Array<{url:string,title?:string}>, text?: string}} input
 * @returns {Promise<{links: Array<{url,provider,title}>, rejected: string[]}>}
 */
async function prepareLinks(userId, { links = [], text = '' } = {}) {
  const raw = [];
  for (const l of Array.isArray(links) ? links : []) {
    if (l && typeof l.url === 'string') raw.push({ url: l.url, title: l.title });
  }
  for (const u of extractUrls(text, MAX_LINKS)) raw.push({ url: u });

  const out = [];
  const rejected = [];
  const seen = new Set();
  let driveReady = null; // looked up once, and only if a Drive link needs a name

  for (const r of raw.slice(0, MAX_LINKS * 2)) {
    const info = classify(r.url);
    if (!info) { rejected.push(clean(r.url, 200)); continue; }
    if (seen.has(info.url)) continue;
    seen.add(info.url);

    let title = clean(r.title, 200);
    if (!title && info.provider === 'youtube') title = await youtubeTitle(info.url);
    if (!title && info.fileId && (info.provider === 'gdoc' || info.provider === 'gdrive')) {
      try {
        const Drive = require('./googleDrive');
        if (driveReady === null) driveReady = await Drive.isConnected(userId);
        if (driveReady) {
          const f = await Drive.getFile(userId, info.fileId);
          if (f && f.title) title = f.title;
        }
      } catch (e) { /* a name is cosmetic — the link still attaches */ }
    }
    out.push({ url: info.url, provider: info.provider, title: title || defaultTitle(info) });
    if (out.length >= MAX_LINKS) break;
  }
  return { links: out, rejected };
}

/** What a client needs to render a stored link row. */
function linkView(url, provider) {
  if (!url) return null;
  const info = classify(url);
  return {
    href: url,
    provider: provider || (info ? info.provider : 'web'),
    embedUrl: info ? info.embedUrl : null,
    host: info ? info.host : null,
    kindLabel: info ? info.label : 'Link'
  };
}

module.exports = { prepareLinks, linkView, MAX_LINKS };
