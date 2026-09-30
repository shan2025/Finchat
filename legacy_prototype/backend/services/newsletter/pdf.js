// services/newsletter/pdf.js — a report-shaped markdown document → PDF cards.
//
// The same card deck the app shows (frontend/report_cards.js), drawn as pages:
// cream paper, gold ornament and spaced kicker, serif headline, sans body,
// a "Why it matters" block, a mono tagline and an n/N counter. The PARSE is
// the app's own — report_cards.js runs unchanged in Node — so a brief splits
// into exactly the cards it does on screen; only the drawing is re-done here.
//
// Fonts are PDFKit's built-in standard fonts (Times / Helvetica / Courier), so
// nothing has to be shipped or fetched. They only cover Latin-1 + a handful of
// typographic characters, which is why every string goes through `pdfSafe`:
// emoji are dropped (the card design strips them anyway) and the few symbols
// agents use for meaning (₹ → "Rs", → → "->", ₿ → "BTC") are spelled out.

const PDFDocument = require('pdfkit');
require('../../../frontend/report_cards.js');
const RC = globalThis.ReportCards;

const W = 432, H = 540;            // 4:5 portrait, the carousel shape
const M = 38;                      // outer text margin
const COLORS = {
  paper: '#f6f1e7', edge: '#e7ddca', ink: '#1f1b16', body: '#57514a',
  gold: '#a8894e', sub: '#6d6358', dark: '#2a2622', darkInk: '#f6f1e7', darkBody: '#d9cfbf'
};

// ── Text safety for the standard (WinAnsi) fonts ─────────────────────────
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));
const REPLACE = [
  [/[‐‑‒−]/g, '-'], [/[→⟶⇒➜]/g, '->'], [/[←⟵]/g, '<-'],
  [/↔/g, '<->'], [/[↑⬆]/g, 'up'], [/[↓⬇]/g, 'down'], [/₹/g, 'Rs '],
  [/₿/g, 'BTC '], [/≈/g, '~'], [/≤/g, '<='], [/≥/g, '>='], [/ | | | /g, ' '],
  [/′/g, "'"], [/″/g, '"'], [/✓|✔|✅/g, '-'], [/•|●|▪/g, '•']
];
function pdfSafe(s) {
  let t = String(s == null ? '' : s).normalize('NFC');
  for (const [re, to] of REPLACE) t = t.replace(re, to);
  let out = '';
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c === 10 || (c >= 32 && c < 127) || (c >= 160 && c <= 255) || WINANSI_EXTRA.has(ch)) out += ch;
    // anything else (emoji, CJK, variation selectors) is dropped
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

// ── Inline markdown → styled runs ────────────────────────────────────────
// Bold, italic, links (inline and reference-style), code. Everything else is
// flattened to its words; the model's text is never trusted as structure.
function inlineRuns(src, refs) {
  const byId = new Map((refs || []).filter(r => r.url).map(r => [String(r.id), r.url]));
  let s = String(src || '')
    // "([3][5])" is two citations, not link text "3" pointing at ref 5.
    .replace(/\(\s*((?:\[\d+\][\s,]*)+)\)/g, '$1')
    .replace(/\[([^\]]*[^\d\]][^\]]*)\]\[([^\]]+)\]/g, (m, text, id) => byId.has(id) ? `\u0001${text}\u0002${byId.get(id)}\u0003` : text)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, text, url) => `\u0001${text}\u0002${url}\u0003`)
    .replace(/\[(\d+)\]/g, (m, id) => byId.has(id) ? `\u0001[${id}]\u0002${byId.get(id)}\u0003` : `[${id}]`)
    .replace(/`([^`]+)`/g, '$1');
  const runs = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3|\u0001(.+?)\u0002(.+?)\u0003/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[2] != null) runs.push({ text: m[2], bold: true });
    else if (m[4] != null) runs.push({ text: m[4], italic: true });
    else runs.push({ text: m[5], link: m[6] });
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs
    .map(r => ({ ...r, text: pdfSafe(r.text.replace(/\*\*|__/g, '')) }))
    .filter(r => r.text.length);
}

// Markdown fragment → paragraphs: { kind: 'p'|'li'|'oli', n?, runs }.
function blocks(md, refs) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ kind: 'p', runs: inlineRuns(para.join(' '), refs) }); para = []; } };
  for (const raw of String(md || '').split('\n')) {
    const ln = raw.trim();
    if (!ln) { flush(); continue; }
    if (/^#{1,6}\s+/.test(ln)) { flush(); out.push({ kind: 'p', runs: inlineRuns('**' + ln.replace(/^#+\s+/, '') + '**', refs) }); continue; }
    let m = ln.match(/^[-*+]\s+(.*)$/);
    if (m) { flush(); out.push({ kind: 'li', runs: inlineRuns(m[1], refs) }); continue; }
    m = ln.match(/^(\d+)[.)]\s+(.*)$/);
    if (m) { flush(); out.push({ kind: 'oli', n: m[1], runs: inlineRuns(m[2], refs) }); continue; }
    if (/^>\s?/.test(ln)) { para.push(ln.replace(/^>\s?/, '')); continue; }
    para.push(ln);
  }
  flush();
  return out.filter(b => b.runs.length);
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }

// ── Drawing ──────────────────────────────────────────────────────────────
function makeDoc(meta) {
  const doc = new PDFDocument({
    size: [W, H], margins: { top: M, bottom: M + 14, left: M, right: M },
    autoFirstPage: false, bufferPages: true,
    info: { Title: pdfSafe(meta.title), Author: 'FinChat', Subject: pdfSafe(meta.subject || '') }
  });
  doc._fcDark = false;
  // Every page — including the continuation page of a card too long for one —
  // gets the paper and frame, so an overflow still looks like the same card.
  doc.on('pageAdded', () => {
    const bg = doc._fcDark ? COLORS.dark : COLORS.paper;
    doc.save().rect(0, 0, W, H).fill(bg).restore();
    doc.save().lineWidth(0.8).strokeColor(doc._fcDark ? '#4a433b' : COLORS.edge)
      .rect(11, 11, W - 22, H - 22).stroke().restore();
    doc.x = M; doc.y = M;
  });
  return doc;
}

function font(doc, face, size, color) { doc.font(face).fontSize(size).fillColor(color); }

function ornament(doc, y, dark) {
  const cx = W / 2;
  doc.save().lineWidth(0.6).strokeColor(COLORS.gold).opacity(0.6)
    .moveTo(cx - 34, y).lineTo(cx - 8, y).moveTo(cx + 8, y).lineTo(cx + 34, y).stroke()
    .opacity(1).circle(cx, y, 1.8).fill(COLORS.gold).restore();
  return y + 10;
}

function kicker(doc, text, y, s) {
  font(doc, 'Courier-Bold', 7.2 * s, COLORS.gold);
  doc.text(pdfSafe(text).toUpperCase(), M, y, { width: W - 2 * M, align: 'center', characterSpacing: 1.6 });
  return doc.y + 6 * s;
}

function writeRuns(doc, runs, x, width, opts, palette) {
  const base = opts.face || 'Helvetica';
  runs.forEach((r, i) => {
    const face = r.bold ? (base === 'Times-Roman' ? 'Times-Bold' : 'Helvetica-Bold')
      : r.italic ? (base === 'Times-Roman' ? 'Times-Italic' : 'Helvetica-Oblique') : base;
    doc.font(face).fillColor(r.link ? COLORS.gold : r.bold ? palette.strong : palette.text);
    const last = i === runs.length - 1;
    const o = { width, align: opts.align || 'left', lineGap: opts.lineGap, continued: !last, link: r.link || null, underline: false };
    if (i === 0) doc.text(r.text, x, doc.y, o); else doc.text(r.text, o);
  });
}

function writeBlocks(doc, list, { size, lineGap, align, palette, x = M, width = W - 2 * M, face }) {
  doc.fontSize(size);
  for (const b of list) {
    if (b.kind === 'p') {
      writeRuns(doc, b.runs, x, width, { lineGap, align, face }, palette);
    } else {
      const mark = b.kind === 'li' ? '•' : `${b.n}.`;
      const y0 = doc.y;
      doc.font('Helvetica-Bold').fillColor(COLORS.gold).text(mark, x, y0, { width: 14, lineGap });
      doc.y = y0;
      writeRuns(doc, b.runs, x + 14, width - 14, { lineGap, face }, palette);
    }
    doc.moveDown(0.45);
  }
}

// Height a set of blocks would take at a given size, measured the same way
// it will be drawn. Used to shrink a crowded card before it spills over.
function measure(doc, list, size, lineGap, width) {
  let h = 0;
  for (const b of list) {
    const text = b.runs.map(r => r.text).join('');
    doc.font('Helvetica').fontSize(size);
    h += doc.heightOfString(text, { width: b.kind === 'p' ? width : width - 14, lineGap }) + size * 0.55;
  }
  return h;
}

function counter(doc, i, n) {
  font(doc, 'Helvetica', 7, doc._fcDark ? COLORS.darkBody : COLORS.gold);
  doc.text(`${i}/${n}`, W - M - 40, 22, { width: 40, align: 'right', lineBreak: false });
  doc.x = M;
}

function tagline(doc, text) {
  if (!text) return;
  font(doc, 'Courier', 7, COLORS.gold);
  const t = pdfSafe(text).toUpperCase();
  const y = Math.max(doc.y + 8, H - M - 6);
  if (y > H - 24) return; // overflowed card: no room left, skip rather than add a page
  // The tagline sits inside the bottom margin on purpose; lift the margin while
  // it is drawn or PDFKit decides the line doesn't fit and opens a blank page.
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.text(t, M, y, { width: W - 2 * M, align: 'center', characterSpacing: 1.4, lineBreak: false });
  doc.page.margins.bottom = bottom;
}

function newCard(doc, { dark = false, index, total }) {
  doc._fcDark = dark;
  doc.addPage();
  counter(doc, index, total);
  return ornament(doc, M + 4, dark);
}

// Pick the largest body size (down to 80%) at which the card fits on one page.
function fitScale(doc, bodyList, whyList, fixedHeight) {
  const avail = H - M - 30 - fixedHeight;
  for (let s = 1; s >= 0.8; s -= 0.05) {
    const need = measure(doc, bodyList, 9.8 * s, 2.6 * s, W - 2 * M) +
      (whyList.length ? 26 + measure(doc, whyList, 9.2 * s, 2.4 * s, W - 2 * M) : 0);
    if (need <= avail) return s;
  }
  return 0.8;
}

function renderStory(doc, s, refs, n, i, storyNo) {
  let y = newCard(doc, { index: i, total: n });
  const body = blocks(s.body, refs), why = blocks(s.why, refs);
  font(doc, 'Times-Bold', 21, COLORS.ink);
  const headH = doc.heightOfString(pdfSafe(s.headline), { width: W - 2 * M, align: 'center' });
  const scale = fitScale(doc, body, why, 60 + headH + (s.sub ? 22 : 0));
  y = kicker(doc, s.kicker && s.kicker !== s.headline ? s.kicker : `Story ${String(storyNo).padStart(2, '0')}`, y, 1);
  font(doc, 'Times-Bold', 21, COLORS.ink);
  doc.text(pdfSafe(s.headline), M, y, { width: W - 2 * M, align: 'center', lineGap: 1 });
  if (s.sub) {
    font(doc, 'Times-Italic', 12, COLORS.sub);
    doc.text(pdfSafe(s.sub), M, doc.y + 3, { width: W - 2 * M, align: 'center' });
  }
  doc.y += 12;
  writeBlocks(doc, body, { size: 9.8 * scale, lineGap: 2.6 * scale, palette: { text: COLORS.body, strong: COLORS.ink } });
  if (why.length) {
    doc.y += 4;
    doc.save().lineWidth(0.7).strokeColor(COLORS.edge).moveTo(M, doc.y).lineTo(W - M, doc.y).stroke().restore();
    doc.y += 7;
    font(doc, 'Courier-Bold', 6.8, COLORS.gold);
    doc.text('WHY IT MATTERS', M, doc.y, { characterSpacing: 1.5 });
    doc.y += 3;
    writeBlocks(doc, why, { size: 9.2 * scale, lineGap: 2.4 * scale, palette: { text: COLORS.ink, strong: COLORS.ink } });
  }
  tagline(doc, s.tag);
}

function renderCover(doc, d, stories, n) {
  let y = newCard(doc, { index: 1, total: n });
  y = kicker(doc, d.date || 'Today', y + 30, 1);
  font(doc, 'Times-Bold', 30, COLORS.ink);
  doc.text(pdfSafe(d.title || 'The Daily'), M, y + 4, { width: W - 2 * M, align: 'center', lineGap: 1 });
  doc.y += 10;
  if (d.intro) {
    writeBlocks(doc, blocks(d.intro, d.refs), { size: 9.8, lineGap: 2.6, align: 'center', palette: { text: COLORS.body, strong: COLORS.ink } });
  }
  if (stories.length) {
    doc.y += 8;
    font(doc, 'Courier-Bold', 7, COLORS.gold);
    doc.text('IN THIS ISSUE', M, doc.y, { width: W - 2 * M, align: 'center', characterSpacing: 1.6 });
    doc.y += 8;
    stories.slice(0, 8).forEach((s, k) => {
      const yy = doc.y;
      font(doc, 'Courier-Bold', 8, COLORS.gold);
      doc.text(String(k + 1).padStart(2, '0'), M + 30, yy, { width: 22 });
      font(doc, 'Times-Roman', 12, COLORS.ink);
      doc.text(pdfSafe(s.headline), M + 54, yy - 2, { width: W - 2 * M - 84 });
      doc.y += 4;
    });
  }
  tagline(doc, `${stories.length} stories inside`);
}

function renderSimple(doc, s, refs, n, i, { dark = false, kickerText, title, tag }) {
  let y = newCard(doc, { dark, index: i, total: n });
  y = kicker(doc, kickerText, y, 1);
  font(doc, 'Times-Bold', 21, dark ? COLORS.darkInk : COLORS.ink);
  doc.text(pdfSafe(title), M, y, { width: W - 2 * M, align: 'center' });
  doc.y += 12;
  const list = blocks(s.body || s.why, refs);
  const scale = fitScale(doc, list, [], 90);
  writeBlocks(doc, list, {
    size: 10 * scale, lineGap: 2.8 * scale, align: dark ? 'center' : 'left',
    face: dark ? 'Times-Roman' : 'Helvetica',
    palette: dark ? { text: COLORS.darkBody, strong: COLORS.darkInk } : { text: COLORS.body, strong: COLORS.ink }
  });
  tagline(doc, tag);
}

function renderSources(doc, refs, n, i) {
  let y = newCard(doc, { index: i, total: n });
  y = kicker(doc, 'Sources', y, 1);
  font(doc, 'Times-Bold', 21, COLORS.ink);
  doc.text('Where this comes from', M, y, { width: W - 2 * M, align: 'center' });
  doc.y += 12;
  refs.slice(0, 30).forEach((r, k) => {
    const yy = doc.y;
    font(doc, 'Courier-Bold', 7.5, COLORS.gold);
    // Word ids ("crypto-btc") don't fit the number column; number those instead.
    const label = /^\d{1,3}$/.test(String(r.id)) ? String(r.id) : String(k + 1);
    doc.text(label, M, yy + 1, { width: 18, lineBreak: false });
    doc.y = yy;
    font(doc, 'Helvetica', 8.6, COLORS.ink);
    doc.text(pdfSafe(r.title || (r.url ? hostOf(r.url) : '')), M + 20, yy, {
      width: W - 2 * M - 20, link: r.url || null, continued: !!r.url
    });
    if (r.url) { font(doc, 'Helvetica', 7.2, COLORS.gold); doc.text('  ' + pdfSafe(hostOf(r.url)), { link: r.url }); }
    doc.y += 3;
  });
  tagline(doc, 'Check the claim, not the tone');
}

/**
 * Markdown (report-shaped) → PDF Buffer. Returns { buffer, pages, title, stories }.
 * Non-report markdown still renders: it becomes a cover plus one text card.
 */
async function renderNewsletterPdf(markdown, { subject } = {}) {
  const d = RC.parse(markdown);
  const stories = d.slides.filter(s => s.kind === 'story');
  const slides = d.slides.length ? d.slides
    : [{ kind: 'closing', kicker: 'Today', headline: d.title || 'Today', body: markdown, why: '', tag: '' }];
  const n = slides.length + 1;
  const doc = makeDoc({ title: [d.title, d.date].filter(Boolean).join(' - ') || 'FinChat Daily', subject });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });

  renderCover(doc, { ...d, refs: d.refs }, stories, n);
  slides.forEach((s, idx) => {
    const i = idx + 2;
    if (s.kind === 'summary') {
      renderSimple(doc, s, d.refs, n, i, { kickerText: 'The headlines',
        title: /executive summary/i.test(s.headline) ? 'Today in brief' : s.headline, tag: s.tag || 'Strongest signals first' });
    } else if (s.kind === 'closing') {
      renderSimple(doc, s, d.refs, n, i, { dark: true, kickerText: s.kicker,
        title: s.headline === s.kicker ? 'The thread that ties it together' : s.headline, tag: s.tag || 'Connect the dots' });
    } else if (s.kind === 'sources') {
      renderSources(doc, d.refs, n, i);
    } else {
      renderStory(doc, s, d.refs, n, i, stories.indexOf(s) + 1);
    }
  });

  const pages = doc.bufferedPageRange().count;
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages, title: d.title, date: d.date, stories: stories.map(s => s.headline) };
}

module.exports = { renderNewsletterPdf, pdfSafe, inlineRuns, blocks };
