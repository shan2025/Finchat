// services/markdown.js — markdown → plain text / HTML for outbound channels.
//
// Agents write markdown. The in-app surfaces render it (marked + DOMPurify),
// but email, Telegram and SMS were being handed the raw source, so reports
// arrived full of literal "#" and "**" instead of headings and bold.
//
// Deliberately dependency-free: the backend ships no markdown parser and this
// only has to cover what the agents actually emit — headings, bold/italic,
// lists, links, blockquotes, code fences, rules and tables.

// ── inline ───────────────────────────────────────────────────
// URL body of a markdown link. One level of balanced parens is allowed so
// Wikipedia-style targets — .../wiki/Mercury_(planet) — survive intact.
const URL_RX = '((?:[^()\\s]|\\([^()\\s]*\\))+)';
const LINK_RX = new RegExp('\\[([^\\]]*)\\]\\(' + URL_RX + '(?:\\s+"[^"]*")?\\)', 'g');
const IMG_RX = new RegExp('!\\[([^\\]]*)\\]\\(' + URL_RX + '(?:\\s+"[^"]*")?\\)', 'g');

// Applied inside a single line, after block structure is handled.
function inlineToPlain(s) {
  return String(s)
    // images first: ![alt](url) → alt (dropping the URL, it can't be shown)
    .replace(IMG_RX, (_, alt) => alt || '')
    // links: [text](url) → "text (url)", or just the URL when they're the same.
    // Agents often emit [http://x](http://x), which read as a doubled URL.
    .replace(LINK_RX, (_, text, url) => {
      const t = text.trim();
      if (!t) return url;
      return t === url || t === decodeURI(url) ? url : `${t} (${url})`;
    })
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1') // bold+italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2') // italic (not mid-word)
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1');        // strikethrough
}

/**
 * Render markdown as readable plain text. Structure survives as spacing and
 * bullets: h1/h2 become UPPERCASE lines, deeper headings keep their words.
 * @param {string} md
 * @returns {string}
 */
function toPlainText(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;

  for (let raw of lines) {
    // fenced code: keep the code, drop the fences
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) { out.push(raw); continue; }

    let line = raw.replace(/\s+$/, '');

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { out.push('—'.repeat(24)); continue; } // hr
    if (/^\s*\|[-:\s|]+\|\s*$/.test(line)) continue;                                 // table rule

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = inlineToPlain(h[2].replace(/\s+#+\s*$/, '')).trim();
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(h[1].length <= 2 ? text.toUpperCase() : text);
      continue;
    }

    line = line.replace(/^(\s*)>\s?/, '$1');                    // blockquote marker
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ');              // bullets
    line = line.replace(/^(\s*)(\d+)[.)]\s+/, '$1$2. ');        // ordered
    line = line.replace(/^\s*\|\s?(.*?)\s?\|\s*$/, (_, cells) => // table row
      cells.split(/\s*\|\s*/).join(' · '));

    out.push(inlineToPlain(line));
  }

  return out.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── HTML (email body) ────────────────────────────────────────
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Only http(s) and mailto survive as links — anything else (javascript:, data:)
// is rendered as text so a tool-sourced URL can't smuggle a scheme into a mail
// client.
function safeHref(url) {
  return /^(https?:\/\/|mailto:)/i.test(String(url).trim()) ? String(url).trim() : null;
}

function inlineToHtml(s) {
  // escapeHtml runs first, so the raw text can never open a tag; the markdown
  // patterns below then add the only markup in the output.
  let t = escapeHtml(s);
  t = t.replace(IMG_RX, (_, alt) => alt);
  t = t.replace(LINK_RX, (m, text, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    if (!href) return text || url;      // javascript:/data: rendered as text
    return `<a href="${escapeHtml(href)}" style="color:#8c491a;">${text.trim() || escapeHtml(href)}</a>`;
  });
  t = t.replace(/`([^`]+)`/g, '<code style="background:#f0e9dd;padding:1px 4px;border-radius:4px;">$1</code>');
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // Bare URLs the agent didn't wrap in markdown.
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (m, pre, url) => `${pre}<a href="${url}" style="color:#8c491a;">${url}</a>`);
  return t;
}

/**
 * Render markdown as a self-contained HTML fragment suitable for an email
 * body. Inline styles only — mail clients strip <style> blocks.
 * @param {string} md
 * @returns {string}
 */
function toHtml(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let listType = null;   // 'ul' | 'ol' | null
  let para = [];
  let fence = null;      // buffered code-fence lines

  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };
  const flushPara = () => {
    if (!para.length) return;
    html.push(`<p style="margin:0 0 12px;line-height:1.55;">${para.map(inlineToHtml).join('<br>')}</p>`);
    para = [];
  };
  const openList = (t) => {
    if (listType === t) return;
    closeList();
    html.push(`<${t} style="margin:0 0 12px;padding-left:22px;line-height:1.55;">`);
    listType = t;
  };

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (fence === null) { flushPara(); closeList(); fence = []; }
      else {
        html.push('<pre style="background:#f0e9dd;padding:12px;border-radius:8px;overflow-x:auto;' +
          'font-size:12px;margin:0 0 12px;">' + escapeHtml(fence.join('\n')) + '</pre>');
        fence = null;
      }
      continue;
    }
    if (fence !== null) { fence.push(raw); continue; }

    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) { flushPara(); closeList(); continue; }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushPara(); closeList();
      html.push('<hr style="border:none;border-top:1px solid #e0d6c4;margin:18px 0;">');
      continue;
    }
    if (/^\s*\|[-:\s|]+\|\s*$/.test(line)) continue;

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); closeList();
      const size = [21, 18, 16, 15, 14, 13][h[1].length - 1];
      html.push(`<h${h[1].length} style="font-size:${size}px;margin:20px 0 8px;color:#3a2e23;">` +
        `${inlineToHtml(h[2].replace(/\s+#+\s*$/, ''))}</h${h[1].length}>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { flushPara(); openList('ul'); html.push(`<li>${inlineToHtml(bullet[1])}</li>`); continue; }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) { flushPara(); openList('ol'); html.push(`<li>${inlineToHtml(ordered[1])}</li>`); continue; }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara(); closeList();
      html.push('<blockquote style="margin:0 0 12px;padding:6px 14px;border-left:3px solid #c67139;' +
        `color:#5b4a3a;">${inlineToHtml(quote[1])}</blockquote>`);
      continue;
    }

    const row = /^\s*\|\s?(.*?)\s?\|\s*$/.exec(line);
    if (row) { flushPara(); closeList(); para.push(row[1].split(/\s*\|\s*/).join(' · ')); flushPara(); continue; }

    para.push(line);
  }
  if (fence !== null) {
    html.push('<pre style="background:#f0e9dd;padding:12px;border-radius:8px;overflow-x:auto;' +
      'font-size:12px;margin:0 0 12px;">' + escapeHtml(fence.join('\n')) + '</pre>');
  }
  flushPara(); closeList();
  return html.join('\n');
}

/**
 * Full HTML email document for one notification.
 * @param {string} title
 * @param {string} md - the notification body, in markdown
 */
function toEmailHtml(title, md) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5ead8;">
<div style="max-width:680px;margin:0 auto;padding:26px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#3a2e23;font-size:14px;">
  <div style="background:#fffaf0;border:1px solid #e7d9be;border-radius:16px;padding:26px 28px;">
    <h1 style="font-size:19px;margin:0 0 4px;color:#3a2e23;">${escapeHtml(title || 'FinChat')}</h1>
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a7d6a;margin-bottom:18px;">FinChat</div>
    ${toHtml(md)}
  </div>
  <div style="text-align:center;font-size:11px;color:#8a7d6a;margin-top:14px;">
    Sent by FinChat · manage delivery channels in Settings
  </div>
</div></body></html>`;
}

/** First `max` characters of the plain-text rendering — for teasers and SMS. */
function toSnippet(md, max = 300) {
  const t = toPlainText(md).replace(/\s*\n+\s*/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

module.exports = { toPlainText, toHtml, toEmailHtml, toSnippet, escapeHtml };
