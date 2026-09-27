// services/linkInfo.js — what a pasted link IS, decided from the URL alone.
//
// The server never fetches a pasted link to find out. Fetching arbitrary URLs
// on a user's say-so is a server-side request forgery hole (it would happily
// read http://169.254.169.254/ or anything on the private network), and for the
// links people actually paste — Google Docs, Drive, YouTube, an image — the URL
// already says everything the UI needs: which icon, and whether it can preview.
//
// The one enrichment that IS done is for Drive links when the user has
// connected Drive: services/googleDrive.js asks Google for the real file name.

const MAX_URL = 2048;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;

// docs.google.com/<kind>/d/<id> — the kinds a person shares.
const GDOC_KINDS = {
  document: 'Google Doc',
  spreadsheets: 'Google Sheet',
  presentation: 'Google Slides',
  forms: 'Google Form',
  drawings: 'Google Drawing'
};

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Parse and classify one URL.
 *
 * @returns {null | {
 *   url: string, provider: 'gdoc'|'gdrive'|'youtube'|'image'|'video'|'web',
 *   label: string, fileId: string|null, embedUrl: string|null, host: string
 * }} null when it is not an http(s) URL at all.
 */
function classify(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > MAX_URL) return null;
  let u;
  try { u = new URL(text); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Credentials in a URL are never something to store and show to others.
  if (u.username || u.password) return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const out = { url: u.toString(), provider: 'web', label: '', fileId: null, embedUrl: null, host };

  // Google Docs / Sheets / Slides / Forms
  if (host === 'docs.google.com') {
    const k = parts[0];
    const i = parts.indexOf('d');
    const id = i >= 0 ? parts[i + 1] : null;
    if (GDOC_KINDS[k] && id && DRIVE_ID.test(id)) {
      return { ...out, provider: 'gdoc', label: GDOC_KINDS[k], fileId: id,
        embedUrl: `https://docs.google.com/${k}/d/${id}/preview` };
    }
  }

  // Drive files and folders
  if (host === 'drive.google.com') {
    let id = null;
    let folder = false;
    const f = parts.indexOf('d');
    if (parts[0] === 'file' && f >= 0) id = parts[f + 1];
    else if (parts[0] === 'drive' && parts.includes('folders')) { id = parts[parts.indexOf('folders') + 1]; folder = true; }
    else if (parts[0] === 'open' || parts[0] === 'uc') id = u.searchParams.get('id');
    if (id && DRIVE_ID.test(id)) {
      return { ...out, provider: 'gdrive', label: folder ? 'Drive folder' : 'Drive file', fileId: id,
        embedUrl: folder ? null : `https://drive.google.com/file/d/${id}/preview` };
    }
  }

  // YouTube
  let yt = null;
  if (host === 'youtu.be') yt = parts[0];
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (parts[0] === 'watch') yt = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) yt = parts[1];
  }
  if (yt && YT_ID.test(yt)) {
    return { ...out, provider: 'youtube', label: 'YouTube video', fileId: yt,
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}` };
  }

  if (IMAGE_EXT.test(u.pathname)) return { ...out, provider: 'image', label: 'Image' };
  if (VIDEO_EXT.test(u.pathname)) return { ...out, provider: 'video', label: 'Video' };

  return { ...out, label: host };
}

/**
 * A readable name for a link nobody named: the last path segment for a file
 * URL, otherwise the host. Drive and Docs ids are not names, so those fall back
 * to the kind ("Google Doc") until Drive supplies the real one.
 */
function defaultTitle(info) {
  if (!info) return 'Link';
  if (info.provider === 'gdoc' || info.provider === 'gdrive' || info.provider === 'youtube') return info.label;
  const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  try {
    const u = new URL(info.url);
    const last = decode(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(0, 120);
    // A wiki-style page reads best as its title: /wiki/Shor%27s_algorithm → "Shor's algorithm".
    if (last && u.pathname.split('/').filter(Boolean).length >= 2) {
      return `${last.replace(/[_-]+/g, ' ').trim()} — ${info.host}`.slice(0, 120);
    }
    return (info.host + (u.pathname.length > 1 ? decode(u.pathname) : '')).slice(0, 120);
  } catch (e) {
    return info.host || 'Link';
  }
}

/**
 * Pull every URL out of pasted text — one per line, or mixed into a sentence.
 * Trailing punctuation that a sentence adds (")." "," "]") is not part of it.
 */
function extractUrls(text, limit = 25) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (let raw of found) {
    raw = raw.replace(/[),.;:!?\]}>]+$/, '');
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { classify, defaultTitle, extractUrls };
