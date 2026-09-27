// routes/sharedMindMaps.js — the public side of a mind map share link.
//
//   GET /:token                     the map, read-only (no login)
//   GET /:token/docs/:docId         one document's text
//   GET /:token/docs/:docId/file    one document's file: viewed in place, or
//                                   ?download=1 to save it (any type)
//   GET /:token/bundle              the map as a bundle .zip, to import elsewhere
//
// The token is the whole permission (migration 055). Every failure — unknown,
// revoked, expired, a document from another map, documents switched off —
// answers the same 404, so a probe learns nothing about which it hit.
//
// What a reader can NEVER reach through here: who owns the map, the node
// conversations, or any document that is not on this map.

const express = require('express');
const router = express.Router();
const { query } = require('../database');
const Engine = require('../services/cognitive/MindMapEngine');
const Bundle = require('../services/cognitive/mindMapBundle');
const { sendDocFile, capabilities } = require('../services/cognitive/mindMapDocFile');
const { linkView } = require('../services/linkAttach');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const NOT_FOUND = { error: 'This link is not valid any more — ask for a new one.' };

async function resolveShare(req, res) {
  const token = String(req.params.token || '');
  if (!TOKEN.test(token)) { res.status(404).json(NOT_FOUND); return null; }
  const r = await query(`
    SELECT s.share_id, s.map_id, s.user_id, s.include_docs, s.expires_at
      FROM mind_map_shares s
     WHERE s.token = $1 AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
  `, [token]);
  if (!r.rows.length) { res.status(404).json(NOT_FOUND); return null; }
  // Nobody should cache a response that a revoke is meant to end.
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return r.rows[0];
}

async function sharedDoc(req, res, share, withData) {
  if (!share.include_docs) { res.status(404).json(NOT_FOUND); return null; }
  const cols = withData ? `${Engine.DOC_COLS}, data` : Engine.DOC_COLS;
  const r = await query(`SELECT ${cols} FROM mind_map_docs WHERE doc_id = $1 AND map_id = $2`,
    [req.params.docId, share.map_id]);
  if (!r.rows.length) { res.status(404).json(NOT_FOUND); return null; }
  return r.rows[0];
}

function publicDoc(d) {
  return {
    docId: d.doc_id,
    nodeId: d.node_id || null,
    filename: d.filename,
    mimetype: d.mimetype,
    size: Number(d.size_bytes) || 0,
    kind: d.kind,
    chars: d.char_count,
    // hasOriginal, hasText, preview ('image'|'pdf'|'text'|'embed'|'image-link'|'video-link'|null), downloadable
    ...capabilities(d),
    link: d.kind === 'link' ? linkView(d.url, d.provider) : null
  };
}

router.get('/:token', async (req, res) => {
  try {
    const share = await resolveShare(req, res);
    if (!share) return;
    const full = await Engine.getMap(share.map_id, share.user_id);
    if (!full) return res.status(404).json(NOT_FOUND);

    query('UPDATE mind_map_shares SET view_count = view_count + 1, last_viewed_at = now() WHERE share_id = $1',
      [share.share_id]).catch(() => {});

    res.json({
      map: {
        title: full.map.title, topic: full.map.topic,
        layout: full.map.layout, theme: full.map.theme, updatedAt: full.map.updated_at
      },
      nodes: full.nodes.map(n => ({
        nodeId: n.node_id, parentId: n.parent_id, label: n.label, summary: n.summary,
        detail: n.detail, nodeType: n.node_type, color: n.color, icon: n.icon,
        collapsed: n.collapsed, order: n.order_index, depth: n.depth
      })),
      edges: full.edges.map(e => ({ fromNode: e.from_node, toNode: e.to_node, label: e.label })),
      includeDocs: share.include_docs,
      docs: share.include_docs ? full.docs.map(publicDoc) : [],
      expiresAt: share.expires_at
    });
  } catch (err) {
    console.error('Shared mind map read error:', err);
    res.status(500).json({ error: 'Failed to load the shared map' });
  }
});

router.get('/:token/docs/:docId', async (req, res) => {
  try {
    const share = await resolveShare(req, res);
    if (!share) return;
    const d = await sharedDoc(req, res, share, false);
    if (!d) return;
    res.json({ doc: { ...publicDoc(d), text: d.extracted || '' } });
  } catch (err) {
    console.error('Shared mind map doc error:', err);
    res.status(500).json({ error: 'Failed to load the document' });
  }
});

router.get('/:token/docs/:docId/file', async (req, res) => {
  try {
    const share = await resolveShare(req, res);
    if (!share) return;
    const d = await sharedDoc(req, res, share, true);
    if (!d) return;
    // ?download=1 → always an attachment. Without it, safe types render in
    // place and everything else downloads anyway (see mindMapDocFile.js).
    if (!sendDocFile(res, d, { download: req.query.download === '1' })) {
      res.status(404).json({ error: 'This document has no stored file or text.' });
    }
  } catch (err) {
    console.error('Shared mind map file error:', err);
    res.status(500).json({ error: 'Failed to load the file' });
  }
});

router.get('/:token/bundle', async (req, res) => {
  try {
    const share = await resolveShare(req, res);
    if (!share) return;
    const full = await Engine.getMap(share.map_id, share.user_id);
    if (!full) return res.status(404).json(NOT_FOUND);
    const docs = share.include_docs ? await Engine.mapDocsWithData(share.map_id) : [];
    const { buffer, filename } = await Bundle.buildBundle({ ...full, docs });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Shared mind map bundle error:', err);
    res.status(500).json({ error: 'Failed to build the download' });
  }
});

module.exports = router;
