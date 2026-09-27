// services/cognitive/mindMapDocFile.js — how a mind map document leaves the
// server, for the owner (routes/mindMaps.js) and for a share link
// (routes/sharedMindMaps.js) alike.
//
// Two ways out, and every document supports both:
//
//   view      rendered by the browser — but only for types that cannot run
//             script on this origin (PDF, raster images, plain text). Anything
//             else is sent as a download even when a view was asked for.
//   download  always an attachment, whatever the type.
//
// A document whose original was never stored (too big, or uploaded before
// migration 045) still has its extracted text, so it is served as that — as a
// .txt — rather than refusing. "You can view or download any file" has to hold
// for those rows too.

// Types a browser may render in place. An uploaded .html or .svg rendered on
// THIS origin would run script beside the app — those always download.
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif',
  'image/webp', 'text/plain', 'text/markdown', 'text/csv']);

const baseType = (t) => String(t || '').toLowerCase().split(';')[0].trim();

/** What a document can do, for a client deciding which buttons to show. */
function capabilities(doc) {
  // A link is opened, not downloaded: there is no file of ours behind it.
  if (doc.kind === 'link') {
    const p = doc.provider;
    const preview = p === 'image' ? 'image-link' : p === 'video' ? 'video-link'
      : (p === 'youtube' || p === 'gdoc' || p === 'gdrive') ? 'embed' : null;
    return { hasOriginal: false, hasText: false, preview, downloadable: false };
  }
  const hasOriginal = !!(doc.has_data || doc.data);
  const hasText = Number(doc.char_count) > 0 || String(doc.extracted || '').trim().length > 0;
  const type = baseType(doc.mimetype);
  let preview = null;
  if (hasOriginal && type.startsWith('image/') && INLINE_TYPES.has(type)) preview = 'image';
  else if (hasOriginal && type === 'application/pdf') preview = 'pdf';
  else if (hasText) preview = 'text';
  return { hasOriginal, hasText, preview, downloadable: hasOriginal || hasText };
}

function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Send a document. `doc.data` is the original's bytes when there is one; with
 * none, `doc.extracted` is sent as text.
 *
 * @returns {boolean} false when there is nothing at all to send.
 */
function sendDocFile(res, doc, { download = false } = {}) {
  let name = String(doc.filename || 'document').replace(/[\r\n]/g, ' ').trim() || 'document';
  let body;
  let type;
  if (doc.data && doc.data.length) {
    body = doc.data;
    type = baseType(doc.mimetype);
  } else if (String(doc.extracted || '').trim()) {
    body = Buffer.from(String(doc.extracted), 'utf8');
    type = 'text/plain';
    if (!/\.(txt|md)$/i.test(name)) name += '.txt';
  } else {
    return false;
  }

  const inline = !download && INLINE_TYPES.has(type);
  res.set('Content-Type', inline
    ? (type.startsWith('text/') ? `${type}; charset=utf-8` : type)
    : 'application/octet-stream');
  res.set('Content-Disposition', disposition(inline ? 'inline' : 'attachment', name));
  res.set('X-Content-Type-Options', 'nosniff');
  // No script, ever. PDFs are the one exception to `sandbox` only because
  // Chrome refuses to show a PDF under it; its viewer runs the document in its
  // own process, not on this origin.
  if (inline && type === 'application/pdf') {
    res.removeHeader('Content-Security-Policy');
  } else {
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  }
  res.send(body);
  return true;
}

module.exports = { sendDocFile, capabilities, INLINE_TYPES };
