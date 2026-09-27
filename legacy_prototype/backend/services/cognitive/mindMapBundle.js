// services/cognitive/mindMapBundle.js — the mind map's portable file format.
//
// A bundle is a .zip with one top-level folder:
//
//   <slug>/map.canvas         JSON Canvas 1.0 (jsoncanvas.org) — an open spec,
//                             so the map opens in Obsidian and anything else
//                             that reads it, with documents as real file nodes
//   <slug>/files/…            every document on the map: the original where one
//                             is stored, else its text (.md for a typed note)
//   <slug>/finchat-map.json   the lossless copy — node types, detail, colours,
//                             pins, extracted text — which is what an import reads
//   <slug>/README.txt         what the reader is holding
//
// Why the folder: Obsidian resolves a file node's path from the VAULT root, not
// from the canvas. Unzipping into a vault creates <slug>/, and every path in the
// canvas already starts with it, so the documents open where they are.
//
// Why not XMind: its attachment layout is undocumented, and a format we can
// only guess at is a format that breaks on their next release. JSON Canvas is
// ten fields and a spec page.
//
// Nothing here touches the database, so the whole format is testable offline.

const JSZip = require('jszip');
const { classify, defaultTitle } = require('../linkInfo');

const FORMAT = 'finchat-mindmap';
const VERSION = 1;

const NODE_TYPES = new Set(['root', 'branch', 'leaf', 'question', 'task']);
const HEX = /^#[0-9a-fA-F]{6}$/;

// Import ceilings. The upload itself is capped by multer; these guard what the
// zip EXPANDS into, which is where a hostile file does its damage.
const LIMITS = {
  entries: 400,
  totalBytes: 80 * 1024 * 1024,
  fileBytes: 15 * 1024 * 1024,
  jsonBytes: 8 * 1024 * 1024,
  nodes: 1000,
  edges: 2000,
  docs: 100,
  textChars: 60000
};

// The mimetype of an imported file is DERIVED from its extension against this
// list, never taken from the bundle. A bundle saying "text/html" about a file
// would otherwise get it served back on our origin as a page.
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', json: 'application/json'
};

const clip = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const clipLong = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function mimeFor(name) {
  return MIME_BY_EXT[extOf(name)] || 'application/octet-stream';
}

/** A name safe as a single path segment on Windows, macOS and inside a zip. */
function safeSegment(name, fallback = 'file') {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function slugify(title) {
  return safeSegment(String(title || 'mind-map').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''), 'mind-map').slice(0, 50);
}

// ═══════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════

const CARD_W = 300;
const CARD_H = 110;
const DOC_W = 260;
const DOC_H = 64;
const COL_GAP = 120;
const ROW_GAP = 28;

/**
 * Decide what file each document becomes inside the bundle.
 *
 * An original that is stored goes in as itself. A document whose original was
 * too big to keep (or predates migration 045) still has its text, so the reader
 * gets that rather than a dead node. A typed note is markdown by nature.
 */
function planFiles(docs, slug) {
  const used = new Set();
  // Links are not files — they travel as JSON Canvas `link` nodes instead.
  return docs.filter(d => d.kind !== 'link').map((d) => {
    let name = safeSegment(d.filename, 'document');
    let body;
    let asText = false;
    if (d.data && d.data.length) {
      body = Buffer.isBuffer(d.data) ? d.data : Buffer.from(d.data);
    } else {
      asText = true;
      const text = String(d.extracted || '');
      body = Buffer.from(text, 'utf8');
      if (d.kind === 'text') {
        if (!/\.md$/i.test(name)) name += '.md';
      } else {
        name += ' (text).txt';
      }
    }
    // Two sources called "notes.pdf" must not overwrite each other.
    let candidate = name;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    used.add(candidate.toLowerCase());
    return { doc: d, name: candidate, path: `${slug}/files/${candidate}`, body, asText };
  });
}

/**
 * Lay the tree out left to right: depth is the column, and every leaf (a node's
 * documents count as its leaves) takes its own row. A parent sits centred on
 * its children. Saved x/y are the FinChat canvas's own coordinates and mean
 * nothing to another app, so they are not reused here — they travel in
 * finchat-map.json instead.
 */
function layoutCanvas(nodes, filesByNode) {
  // `filesByNode` values are attachments of either sort: a planned file
  // ({doc, path}) or a link ({doc, link}). Both take one row beside the node.
  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parent_id || null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.order_index || 0) - (b.order_index || 0));

  const pos = new Map();
  const docPos = [];
  let cursor = 0;

  const place = (n, depth) => {
    const x = depth * (CARD_W + COL_GAP);
    const kids = byParent.get(n.node_id) || [];
    const files = filesByNode.get(n.node_id) || [];
    const ys = [];
    for (const f of files) {
      const y = cursor;
      cursor += DOC_H + ROW_GAP;
      docPos.push({ file: f, owner: n.node_id, x: x + CARD_W + COL_GAP, y });
      ys.push(y + DOC_H / 2);
    }
    for (const k of kids) ys.push(place(k, depth + 1));
    let mid;
    if (ys.length) {
      mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    } else {
      mid = cursor + CARD_H / 2;
      cursor += CARD_H + ROW_GAP;
    }
    pos.set(n.node_id, { x, y: Math.round(mid - CARD_H / 2) });
    return mid;
  };

  for (const r of byParent.get(null) || []) place(r, 0);
  return { pos, docPos };
}

function nodeMarkdown(n) {
  const parts = [`## ${n.label || 'Untitled'}`];
  if (n.summary) parts.push(n.summary);
  if (n.detail) parts.push(n.detail);
  if (n.node_type === 'question') parts.unshift('**Question**');
  if (n.node_type === 'task') parts.unshift('- [ ] task');
  return parts.join('\n\n');
}

/** The JSON Canvas document for a map. Exported separately so tests can read it without unzipping. */
function toCanvas({ nodes, edges, docs = [] }, planned) {
  const known = new Set(nodes.map(n => n.node_id));
  const filesByNode = new Map();
  const root = nodes.find(n => !n.parent_id);
  const links = docs.filter(d => d.kind === 'link' && d.url).map(d => ({ doc: d, link: d.url }));
  for (const f of [...planned, ...links]) {
    // A map-level document hangs off the root, where the map's overview is.
    const owner = f.doc.node_id && known.has(f.doc.node_id) ? f.doc.node_id : root?.node_id;
    if (!owner) continue;
    if (!filesByNode.has(owner)) filesByNode.set(owner, []);
    filesByNode.get(owner).push(f);
  }
  const { pos, docPos } = layoutCanvas(nodes, filesByNode);

  const cNodes = [];
  const cEdges = [];
  for (const n of nodes) {
    const p = pos.get(n.node_id);
    if (!p) continue; // unreachable from the root: nothing to draw it under
    const node = { id: n.node_id, type: 'text', x: p.x, y: p.y, width: CARD_W, height: CARD_H, text: nodeMarkdown(n) };
    if (n.color && HEX.test(n.color)) node.color = n.color;
    cNodes.push(node);
    if (n.parent_id && pos.has(n.parent_id)) {
      cEdges.push({ id: `tree_${n.node_id}`, fromNode: n.parent_id, fromSide: 'right',
        toNode: n.node_id, toSide: 'left', toEnd: 'none' });
    }
  }
  docPos.forEach((d, i) => {
    const id = `doc_${d.file.doc.doc_id || i}`;
    cNodes.push(d.file.link
      ? { id, type: 'link', url: d.file.link, x: d.x, y: d.y, width: DOC_W, height: DOC_H }
      : { id, type: 'file', file: d.file.path, x: d.x, y: d.y, width: DOC_W, height: DOC_H });
    cEdges.push({ id: `att_${id}`, fromNode: d.owner, fromSide: 'right', toNode: id, toSide: 'left',
      toEnd: 'none', color: '6' });
  });
  for (const e of edges || []) {
    if (!pos.has(e.from_node) || !pos.has(e.to_node)) continue;
    const edge = { id: e.edge_id, fromNode: e.from_node, toNode: e.to_node, color: '5' };
    if (e.label) edge.label = e.label;
    cEdges.push(edge);
  }
  return { nodes: cNodes, edges: cEdges };
}

/** The lossless description an import reads back. */
function toManifest({ map, nodes, edges, docs = [] }, planned) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    map: {
      title: map.title || '', topic: map.topic || '',
      layout: map.layout || 'radial', theme: map.theme || 'warm'
    },
    nodes: nodes.map(n => ({
      id: n.node_id, parent: n.parent_id || null,
      label: n.label || '', summary: n.summary || '', detail: n.detail || '',
      type: n.node_type || 'leaf', color: n.color || null, icon: n.icon || null,
      collapsed: !!n.collapsed,
      x: Number.isFinite(n.x) ? n.x : null, y: Number.isFinite(n.y) ? n.y : null,
      order: n.order_index || 0
    })),
    edges: (edges || []).map(e => ({ from: e.from_node, to: e.to_node, label: e.label || '', style: e.style || 'dashed' })),
    docs: [
      ...planned.map(f => ({
        node: f.doc.node_id || null,
        filename: f.doc.filename,
        kind: f.doc.kind,
        // Where the ORIGINAL is. Null when the bundle only carries the text.
        file: f.asText ? null : f.path.split('/').slice(1).join('/'),
        text: String(f.doc.extracted || '')
      })),
      ...docs.filter(d => d.kind === 'link' && d.url).map(d => ({
        node: d.node_id || null, filename: d.filename, kind: 'link', url: d.url, text: ''
      }))
    ]
  };
}

function readme(map, planned) {
  return [
    `${map.title || 'Mind map'}`,
    '',
    'A mind map exported from FinChat.',
    '',
    '  map.canvas         open in Obsidian (unzip into your vault), or any JSON Canvas app',
    '  files/            the documents attached to the map\'s nodes',
    '  finchat-map.json   import this whole .zip back into FinChat → Mind Maps → Import',
    '',
    `${planned.length} document(s) included.`,
    ...planned.filter(f => f.asText).map(f => `  · "${f.doc.filename}" is included as its extracted text — the original was not stored.`),
    ''
  ].join('\n');
}

/**
 * Build the .zip for one map.
 *
 * @param {{map:object, nodes:object[], edges:object[], docs:object[]}} full
 *        `docs` rows must carry `data` (bytes or null) and `extracted`.
 * @returns {Promise<{buffer:Buffer, filename:string}>}
 */
async function buildBundle(full) {
  const slug = slugify(full.map.title);
  const planned = planFiles(full.docs || [], slug);
  const zip = new JSZip();
  const dir = zip.folder(slug);
  dir.file('map.canvas', JSON.stringify(toCanvas(full, planned), null, 2));
  dir.file('finchat-map.json', JSON.stringify(toManifest(full, planned), null, 2));
  dir.file('README.txt', readme(full.map, planned));
  for (const f of planned) zip.file(f.path, f.body);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, filename: `${slug}.zip` };
}

// ═══════════════════════════════════════════════════════════
// Import
// ═══════════════════════════════════════════════════════════

class BundleError extends Error {}

/** Declared size of an entry, before inflating it. JSZip keeps it on `_data`. */
function declaredSize(entry) {
  const n = entry && entry._data && entry._data.uncompressedSize;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read a bundle back into a validated, self-consistent structure.
 *
 * Everything in the zip is treated as hostile: sizes are checked before a byte
 * is inflated, ids are remapped rather than trusted, a node whose parent is
 * missing is dropped rather than grafted somewhere, and a parent cycle cannot
 * survive because nodes are only ever reached by walking down from the root.
 *
 * @returns {Promise<{map:object, nodes:object[], edges:object[], docs:object[], dropped:object}>}
 */
async function parseBundle(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new BundleError('That file is not a zip — export a map from FinChat to get one.');
  }

  const entries = Object.values(zip.files).filter(e => !e.dir);
  if (entries.length > LIMITS.entries) throw new BundleError('That bundle has too many files in it.');
  const total = entries.reduce((s, e) => s + declaredSize(e), 0);
  if (total > LIMITS.totalBytes) throw new BundleError('That bundle is too large once unpacked.');

  // The manifest sits at the root or one folder down. Deeper is not ours.
  const manifestEntry = entries
    .filter(e => /(^|\/)finchat-map\.json$/.test(e.name) && e.name.split('/').length <= 2)
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!manifestEntry) {
    throw new BundleError('No finchat-map.json in that zip — only bundles exported from FinChat can be imported.');
  }
  if (declaredSize(manifestEntry) > LIMITS.jsonBytes) throw new BundleError('finchat-map.json is too large.');
  const base = manifestEntry.name.includes('/') ? manifestEntry.name.slice(0, manifestEntry.name.lastIndexOf('/') + 1) : '';

  let m;
  try {
    m = JSON.parse(await manifestEntry.async('string'));
  } catch (err) {
    throw new BundleError('finchat-map.json is not valid JSON.');
  }
  if (!m || m.format !== FORMAT) throw new BundleError('finchat-map.json is not a FinChat mind map.');
  if (Number(m.version) > VERSION) {
    throw new BundleError('That bundle was made by a newer FinChat than this one — update and try again.');
  }

  const rawNodes = Array.isArray(m.nodes) ? m.nodes.slice(0, LIMITS.nodes * 2) : [];
  const roots = rawNodes.filter(n => n && !n.parent);
  if (roots.length !== 1) throw new BundleError('The map in that bundle does not have exactly one root.');

  const kids = new Map();
  for (const n of rawNodes) {
    if (!n || typeof n.id !== 'string' || !n.parent) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }

  // Walk down from the root: parents always precede children (the self-FK
  // needs that), and anything unreachable — orphans, cycles — never gets in.
  const nodes = [];
  const seen = new Set();
  const queue = [roots[0]];
  while (queue.length && nodes.length < LIMITS.nodes) {
    const n = queue.shift();
    if (typeof n.id !== 'string' || seen.has(n.id)) continue;
    seen.add(n.id);
    const isRoot = n === roots[0];
    const type = NODE_TYPES.has(n.type) ? n.type : (isRoot ? 'root' : 'leaf');
    nodes.push({
      ref: n.id,
      parentRef: isRoot ? null : n.parent,
      label: clip(n.label, 120) || 'Untitled',
      summary: clip(n.summary, 400),
      detail: clip(n.detail, 1500),
      type: isRoot ? 'root' : (type === 'root' ? 'branch' : type),
      color: typeof n.color === 'string' && HEX.test(n.color) ? n.color : null,
      icon: n.icon ? clip(n.icon, 40) : null,
      collapsed: n.collapsed === true,
      x: Number.isFinite(n.x) ? n.x : null,
      y: Number.isFinite(n.y) ? n.y : null,
      order: Number.isInteger(n.order) ? Math.max(0, Math.min(n.order, 100000)) : 0
    });
    const children = (kids.get(n.id) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    queue.push(...children);
  }

  const edges = [];
  const pairs = new Set();
  for (const e of (Array.isArray(m.edges) ? m.edges : []).slice(0, LIMITS.edges)) {
    if (!e || !seen.has(e.from) || !seen.has(e.to) || e.from === e.to) continue;
    const key = `${e.from}\u0000${e.to}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    edges.push({ fromRef: e.from, toRef: e.to, label: clip(e.label, 120), style: clip(e.style, 20) || 'dashed' });
  }

  const docs = [];
  let skippedDocs = 0;
  for (const d of (Array.isArray(m.docs) ? m.docs : []).slice(0, LIMITS.docs)) {
    if (!d) continue;
    if (d.kind === 'link') {
      // Re-classified here, never trusted: a bundle's "link" could be
      // javascript: or carry credentials. classify() refuses both.
      const info = classify(d.url);
      if (!info) { skippedDocs++; continue; }
      docs.push({
        nodeRef: d.node && seen.has(d.node) ? d.node : null,
        filename: clip(d.filename, 200) || defaultTitle(info),
        kind: 'link', mimetype: '', text: '', data: null,
        url: info.url, provider: info.provider
      });
      continue;
    }
    const filename = clip(d.filename, 200) || 'document';
    const kind = d.kind === 'text' ? 'text' : (d.kind === 'image' ? 'image' : 'document');
    let data = null;
    if (kind !== 'text' && typeof d.file === 'string' && d.file) {
      // Look the file up by its exact name inside the bundle folder. The name
      // is a lookup key only — nothing from the zip ever reaches the disk.
      const entry = zip.file(base + d.file);
      if (entry && declaredSize(entry) <= LIMITS.fileBytes) {
        data = await entry.async('nodebuffer');
        if (data.length > LIMITS.fileBytes) data = null;
      }
    }
    const text = clipLong(d.text, LIMITS.textChars);
    if (!data && !text) { skippedDocs++; continue; }
    docs.push({
      nodeRef: d.node && seen.has(d.node) ? d.node : null,
      filename,
      kind,
      mimetype: kind === 'text' ? 'text/plain' : mimeFor(filename),
      text,
      data
    });
  }

  return {
    map: {
      title: clip(m.map && m.map.title, 160) || nodes[0].label,
      topic: clip(m.map && m.map.topic, 400),
      layout: ['radial', 'tree', 'freeform'].includes(m.map && m.map.layout) ? m.map.layout : 'radial',
      theme: clip(m.map && m.map.theme, 40) || 'warm'
    },
    nodes,
    edges,
    docs,
    dropped: { nodes: rawNodes.length - nodes.length, docs: skippedDocs }
  };
}

module.exports = {
  FORMAT,
  VERSION,
  LIMITS,
  buildBundle,
  parseBundle,
  toCanvas,
  toManifest,
  planFiles,
  mimeFor,
  slugify,
  BundleError
};
