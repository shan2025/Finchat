// tools/YouTubeTool.js — search YouTube and read video metadata + transcripts.
// Uses the OFFICIAL YouTube Data API v3 (needs a free YOUTUBE_API_KEY) rather than
// yt-dlp scraping, because scraping YouTube from datacenter IPs (Render) is blocked
// and would need a proxy — the same trap as Agent-Reach's social channels. The API
// path is key-only, quota-friendly, and works fine on the server.
//
// Two modes:
//   {"query":"nvidia q3 earnings call"}   → search: top videos + metadata
//   {"url":"https://youtu.be/XXXX"}       → details + statistics + transcript
//   {"videoId":"XXXX"}                     → same as url
//
// Transcripts come from YouTube's public timedtext endpoint (no key, best-effort:
// only works when the video has caption tracks and the endpoint isn't IP-blocked).
// When it can't fetch one, the video metadata is still returned with transcript:null.
const axios = require('axios');

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = () => process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || '';

function parseInput(input) {
  const o = (input && typeof input === 'object') ? input
    : (String(input || '').trim().startsWith('{') ? safeJson(input) : { query: String(input || '').trim() });
  const url = String(o.url || o.link || '').trim();
  return {
    query: String(o.query || o.topic || '').trim(),
    videoId: String(o.videoId || o.id || '').trim() || videoIdFromUrl(url),
    limit: +o.limit || 5
  };
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

function videoIdFromUrl(url) {
  if (!url) return '';
  const m = url.match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(url) ? url : '');
}

function isoDurationToText(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const [h, min, s] = [m[1] || 0, m[2] || 0, m[3] || 0].map(Number);
  return (h ? `${h}:${String(min).padStart(2, '0')}` : `${min}`) + `:${String(s).padStart(2, '0')}`;
}

// Best-effort transcript via the public timedtext endpoint. First ask for the track
// list, then fetch the first (prefer English) track as plain text. Returns null on
// any failure — captions off, none available, or endpoint blocked.
async function fetchTranscript(videoId) {
  try {
    const list = await axios.get('https://www.youtube.com/api/timedtext', {
      params: { type: 'list', v: videoId }, timeout: 10000, responseType: 'text'
    });
    const langs = [...String(list.data || '').matchAll(/lang_code="([^"]+)"/g)].map(x => x[1]);
    if (!langs.length) return null;
    const lang = langs.find(l => /^en/i.test(l)) || langs[0];

    const cap = await axios.get('https://www.youtube.com/api/timedtext', {
      params: { lang, v: videoId }, timeout: 10000, responseType: 'text'
    });
    const text = String(cap.data || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;#39;/g, "'").replace(/&amp;quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    return text ? { lang, text: text.slice(0, 6000), truncated: text.length > 6000 } : null;
  } catch (e) {
    return null;
  }
}

async function searchVideos(query, limit) {
  const res = await axios.get(`${API}/search`, {
    params: { key: KEY(), part: 'snippet', q: query, type: 'video', maxResults: Math.min(limit, 10), order: 'relevance' },
    timeout: 12000
  });
  return (res.data?.items || []).map(it => ({
    videoId: it.id?.videoId,
    title: it.snippet?.title,
    channel: it.snippet?.channelTitle,
    publishedAt: it.snippet?.publishedAt,
    excerpt: String(it.snippet?.description || '').slice(0, 240),
    url: `https://www.youtube.com/watch?v=${it.id?.videoId}`
  })).filter(v => v.videoId);
}

async function videoDetails(videoId) {
  const res = await axios.get(`${API}/videos`, {
    params: { key: KEY(), part: 'snippet,statistics,contentDetails', id: videoId }, timeout: 12000
  });
  const it = res.data?.items?.[0];
  if (!it) return null;
  return {
    videoId,
    title: it.snippet?.title,
    channel: it.snippet?.channelTitle,
    publishedAt: it.snippet?.publishedAt,
    duration: isoDurationToText(it.contentDetails?.duration),
    views: it.statistics?.viewCount,
    likes: it.statistics?.likeCount,
    description: String(it.snippet?.description || '').slice(0, 1200),
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

async function execute(input) {
  const { query, videoId, limit } = parseInput(input);

  if (!KEY()) {
    return {
      source: 'youtube', results: [], searchUnavailable: true,
      error: 'YOUTUBE NOT CONFIGURED — set YOUTUBE_API_KEY in the environment (free from Google Cloud). This is a setup gap, NOT evidence; do not tell the user the video/topic does not exist.'
    };
  }

  try {
    // Specific video → details + transcript.
    if (videoId) {
      const details = await videoDetails(videoId);
      if (!details) return { source: 'youtube', videoId, results: [], note: `No YouTube video found for id "${videoId}".` };
      const transcript = await fetchTranscript(videoId);
      return { source: 'youtube', mode: 'video', video: details, transcript };
    }

    // Query → search results.
    if (!query) return { source: 'youtube', results: [], error: 'provide a "query" to search, or a "url"/"videoId" for a specific video' };
    const results = await searchVideos(query, limit);
    if (!results.length) return { source: 'youtube', query, results: [], note: `No YouTube videos found for "${query}".` };
    return { source: 'youtube', mode: 'search', query, results };
  } catch (err) {
    const status = err.response?.status;
    const reason = err.response?.data?.error?.message || err.message;
    // 403 from the API usually means quota exceeded or a bad/blocked key.
    return {
      source: 'youtube', results: [], searchUnavailable: true,
      error: `YOUTUBE API ERROR (${status || ''}: ${reason}) — likely quota exhausted or an invalid key. This is a tool outage, NOT evidence; say the YouTube lookup is unavailable.`
    };
  }
}

module.exports = { execute, fetchTranscript, videoIdFromUrl };
