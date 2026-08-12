// routes/mindMaps.js — Sprint Z · Track A · /api/mind-maps
//
//   GET    /                              list the caller's maps
//   POST   /generate                      {sourceType, topic|sessionId}
//   GET    /:mapId                        full tree + cross-links
//   PATCH  /:mapId                        rename / layout / theme
//   DELETE /:mapId                        delete a map
//   POST   /:mapId/nodes                  add a node
//   PATCH  /:mapId/nodes/:nodeId          rename / recolor / collapse / retype / move
//   DELETE /:mapId/nodes/:nodeId          delete a node and its subtree
//   POST   /:mapId/nodes/:nodeId/expand   AI-grow this branch
//   POST   /:mapId/nodes/:nodeId/chat     bind a scoped conversation to this node
//   GET    /:mapId/nodes/:nodeId/messages the node conversation so far
//   POST   /:mapId/edges                  add a cross-link
//   DELETE /:mapId/edges/:edgeId          remove a cross-link
//   POST   /:mapId/layout                 bulk position save
//   GET    /:mapId/export?format=         markdown | opml
//
//   POST   /docs                          upload documents (multipart, "files")
//   GET    /docs                          the caller's document library
//   GET    /docs/:docId                   one document + its extracted text
//   PATCH  /docs/:docId                   attach / move to a map or node
//   DELETE /docs/:docId                   forget a document
//
// Ownership mirrors neuralMap.js: someone else's map is 404, never 401 — a 401
// would confirm the id exists.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const Engine = require('../services/cognitive/MindMapEngine');
const { extractFromUpload, persistUpload } = require('../services/attachments');

const NODE_TYPES = ['root', 'branch', 'leaf', 'question', 'task'];
const LAYOUTS = ['radial', 'tree', 'freeform'];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Same limits as the chat composer, one step wider: a study map is normally
// built from a small stack of papers rather than a single attachment.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 6 }
});

// What the node chat ships to the model per document. Smaller than the
// extraction cap on purpose: four sources at 8k each would crowd out the
// conversation itself.
const CHAT_DOC_CHARS = 4000;
const CHAT_DOC_LIMIT = 4;

const clean = (v, max = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** Public shape of a document row. `text` is opt-in — it is the expensive field. */
function docView(row, withText = false) {
  const view = {
    docId: row.doc_id,
    mapId: row.map_id || null,
    nodeId: row.node_id || null,
    filename: row.filename,
    mimetype: row.mimetype,
    size: Number(row.size_bytes) || 0,
    kind: row.kind,
    chars: row.char_count,
    // The blob is served by the existing /uploads static mount. NULL when the
    // disk write failed — the extracted text still works, the original does not.
    url: row.stored_name ? `/uploads/${encodeURIComponent(row.stored_name)}` : null,
    createdAt: row.created_at
  };
  if (withText) view.text = row.extracted || '';
  return view;
}

/** Resolve a document the caller owns, or answer 404 and return null. */
async function requireOwnedDoc(req, res) {
  const r = await query('SELECT * FROM mind_map_docs WHERE doc_id = $1 AND user_id = $2',
    [req.params.docId, req.user.id]);
  const doc = r.rows[0];
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return null; }
  return doc;
}

/** Resolve a map the caller owns, or answer 404 and return null. */
async function requireOwnedMap(req, res) {
  const res_ = await query('SELECT * FROM mind_maps WHERE map_id = $1 AND user_id = $2',
    [req.params.mapId, req.user.id]);
  const map = res_.rows[0];
  if (!map) { res.status(404).json({ error: 'Map not found' }); return null; }
  return map;
}

/** Resolve a node inside an owned map, or answer 404 and return null. */
async function requireOwnedNode(req, res, mapId) {
  const r = await query('SELECT * FROM mind_map_nodes WHERE node_id = $1 AND map_id = $2',
    [req.params.nodeId, mapId]);
  const node = r.rows[0];
  if (!node) { res.status(404).json({ error: 'Node not found' }); return null; }
  return node;
}

// ── GET / ──────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json({ maps: await Engine.listMaps(req.user.id) });
  } catch (err) {
    console.error('Mind map list error:', err);
    res.status(500).json({ error: 'Failed to load mind maps' });
  }
});

// ── POST /generate ─────────────────────────────────────────────
router.post('/generate', requireAuth, async (req, res) => {
  const { sourceType = 'topic', topic, sessionId, docIds } = req.body || {};
  try {
    let out;
    if (sourceType === 'topic') {
      if (!clean(topic)) return res.status(400).json({ error: 'topic is required' });
      out = await Engine.generateFromTopic(req.user.id, topic);
    } else if (sourceType === 'chat') {
      if (!clean(sessionId)) return res.status(400).json({ error: 'sessionId is required' });
      out = await Engine.generateFromChat(req.user.id, sessionId);
    } else if (sourceType === 'document') {
      if (!Array.isArray(docIds) || !docIds.length) {
        return res.status(400).json({ error: 'docIds is required — upload documents first' });
      }
      out = await Engine.generateFromDocuments(req.user.id, docIds, { topic });
    } else if (sourceType === 'graph') {
      // Refuse explicitly rather than silently producing a topic map from the
      // wrong source — a wrong map is worse than none.
      return res.status(501).json({ error: `sourceType "${sourceType}" is not available yet` });
    } else {
      return res.status(400).json({ error: `unknown sourceType "${sourceType}"` });
    }
    res.status(201).json({ ok: true, ...out });
  } catch (err) {
    console.error('Mind map generate error:', err);
    // A refused stub map is the user's problem to retry, not a server fault.
    const isShape = /refusing to save a stub|topic is required|no conversation found|no documents found|extractable text/i
      .test(err.message);
    res.status(isShape ? 422 : 500).json({ error: 'Failed to generate mind map', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// Documents
//
// Registered ahead of /:mapId — "docs" would otherwise be read as a map id.
// ═══════════════════════════════════════════════════════════════

// ── POST /docs ─────────────────────────────────────────────────
// Multipart upload. Text is extracted once, here, and stored on the row: a
// question about a node must never wait on a PDF being re-parsed.
//
// mapId/nodeId are optional — a document uploaded with neither is staged in the
// caller's library, which is how "give the AI these papers, then build a map"
// works before a map exists.
router.post('/docs', requireAuth, upload.array('files', 6), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded (field name: "files")' });
  }
  try {
    const mapId = clean(req.body?.mapId, 80) || null;
    const nodeId = clean(req.body?.nodeId, 80) || null;

    // A node id without its map, or either one belonging to someone else, must
    // not silently degrade into a library upload — the user would never find
    // the file where they put it.
    if (nodeId && !mapId) return res.status(400).json({ error: 'nodeId requires mapId' });
    if (mapId) {
      const own = await query('SELECT 1 FROM mind_maps WHERE map_id = $1 AND user_id = $2', [mapId, req.user.id]);
      if (!own.rows.length) return res.status(404).json({ error: 'Map not found' });
    }
    if (nodeId) {
      const inMap = await query('SELECT 1 FROM mind_map_nodes WHERE node_id = $1 AND map_id = $2', [nodeId, mapId]);
      if (!inMap.rows.length) return res.status(400).json({ error: 'nodeId is not a node in this map' });
    }

    const saved = [];
    for (const f of req.files) {
      const storedName = persistUpload(f, req.user.id);
      const extracted = await extractFromUpload(f);
      const docId = 'mmd_' + uuidv4();
      const text = String(extracted.text || '');
      const r = await query(`
        INSERT INTO mind_map_docs
          (doc_id, user_id, map_id, node_id, filename, mimetype, size_bytes,
           stored_name, kind, extracted, char_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [docId, req.user.id, mapId, nodeId, clean(f.originalname, 200) || 'file',
          f.mimetype || '', f.size || 0, storedName, extracted.kind === 'image' ? 'image' : 'document',
          text, text.length]);
      saved.push(docView(r.rows[0]));
    }
    if (mapId) await Engine.touchMap(mapId);
    res.status(201).json({ ok: true, docs: saved });
  } catch (err) {
    console.error('Mind map doc upload error:', err);
    res.status(500).json({ error: 'Failed to process documents', details: err.message });
  }
});

// ── GET /docs ──────────────────────────────────────────────────
// The caller's library. ?unattached=1 narrows it to documents not yet bound to
// a map, which is the useful set when starting a new one.
router.get('/docs', requireAuth, async (req, res) => {
  try {
    const onlyFree = req.query.unattached === '1';
    const r = await query(`
      SELECT * FROM mind_map_docs
       WHERE user_id = $1 ${onlyFree ? 'AND map_id IS NULL' : ''}
       ORDER BY created_at DESC LIMIT 100
    `, [req.user.id]);
    res.json({ docs: r.rows.map(d => docView(d)) });
  } catch (err) {
    console.error('Mind map doc list error:', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

// ── GET /docs/:docId ───────────────────────────────────────────
router.get('/docs/:docId', requireAuth, async (req, res) => {
  try {
    const doc = await requireOwnedDoc(req, res);
    if (!doc) return;
    res.json({ doc: docView(doc, true) });
  } catch (err) {
    console.error('Mind map doc read error:', err);
    res.status(500).json({ error: 'Failed to load document' });
  }
});

// ── PATCH /docs/:docId ─────────────────────────────────────────
// Move a document: onto a node, up to the map, or back to the library.
// `null` means "detach", which is why absent and null are treated differently.
router.patch('/docs/:docId', requireAuth, async (req, res) => {
  try {
    const doc = await requireOwnedDoc(req, res);
    if (!doc) return;
    const { mapId, nodeId } = req.body || {};

    const nextMap = mapId === undefined ? doc.map_id : (mapId ? clean(mapId, 80) : null);
    const nextNode = nodeId === undefined ? doc.node_id : (nodeId ? clean(nodeId, 80) : null);
    if (nextNode && !nextMap) return res.status(400).json({ error: 'a node-scoped document needs a map' });

    if (nextMap && nextMap !== doc.map_id) {
      const own = await query('SELECT 1 FROM mind_maps WHERE map_id = $1 AND user_id = $2', [nextMap, req.user.id]);
      if (!own.rows.length) return res.status(404).json({ error: 'Map not found' });
    }
    if (nextNode) {
      const inMap = await query('SELECT 1 FROM mind_map_nodes WHERE node_id = $1 AND map_id = $2',
        [nextNode, nextMap]);
      if (!inMap.rows.length) return res.status(400).json({ error: 'nodeId is not a node in that map' });
    }

    const r = await query(
      'UPDATE mind_map_docs SET map_id = $2, node_id = $3 WHERE doc_id = $1 RETURNING *',
      [doc.doc_id, nextMap, nextNode]);
    if (nextMap) await Engine.touchMap(nextMap);
    res.json({ ok: true, doc: docView(r.rows[0]) });
  } catch (err) {
    console.error('Mind map doc move error:', err);
    res.status(500).json({ error: 'Failed to move document' });
  }
});

// ── DELETE /docs/:docId ────────────────────────────────────────
// Drops the row. The file under uploads/ is left alone — the same upload can be
// referenced by a chat message's audit trail, and this route does not own that.
router.delete('/docs/:docId', requireAuth, async (req, res) => {
  try {
    const doc = await requireOwnedDoc(req, res);
    if (!doc) return;
    await query('DELETE FROM mind_map_docs WHERE doc_id = $1', [doc.doc_id]);
    if (doc.map_id) await Engine.touchMap(doc.map_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mind map doc delete error:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ── GET /:mapId ────────────────────────────────────────────────
router.get('/:mapId', requireAuth, async (req, res) => {
  try {
    const full = await Engine.getMap(req.params.mapId, req.user.id);
    if (!full) return res.status(404).json({ error: 'Map not found' });
    res.json(full);
  } catch (err) {
    console.error('Mind map read error:', err);
    res.status(500).json({ error: 'Failed to load mind map' });
  }
});

// ── PATCH /:mapId ──────────────────────────────────────────────
router.patch('/:mapId', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const { title, layout, theme } = req.body || {};
    if (layout !== undefined && !LAYOUTS.includes(layout)) {
      return res.status(400).json({ error: `layout must be one of: ${LAYOUTS.join(', ')}` });
    }
    await query(`
      UPDATE mind_maps SET
        title = COALESCE($2, title),
        layout = COALESCE($3, layout),
        theme = COALESCE($4, theme),
        updated_at = now()
      WHERE map_id = $1
    `, [map.map_id, title !== undefined ? clean(title, 160) : null, layout ?? null,
        theme !== undefined ? clean(theme, 40) : null]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mind map update error:', err);
    res.status(500).json({ error: 'Failed to update mind map' });
  }
});

// ── DELETE /:mapId ─────────────────────────────────────────────
router.delete('/:mapId', requireAuth, async (req, res) => {
  try {
    const del = await query('DELETE FROM mind_maps WHERE map_id = $1 AND user_id = $2',
      [req.params.mapId, req.user.id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Map not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Mind map delete error:', err);
    res.status(500).json({ error: 'Failed to delete mind map' });
  }
});

// ── POST /:mapId/nodes ─────────────────────────────────────────
router.post('/:mapId/nodes', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const { parentId, label, summary, detail, nodeType, color, icon } = req.body || {};
    if (!clean(label)) return res.status(400).json({ error: 'label is required' });
    if (nodeType && !NODE_TYPES.includes(nodeType)) {
      return res.status(400).json({ error: `nodeType must be one of: ${NODE_TYPES.join(', ')}` });
    }
    if (color && !HEX.test(color)) return res.status(400).json({ error: 'color must be #rrggbb' });

    // A parent from another map would silently graft one tree onto another.
    if (parentId) {
      const p = await query('SELECT 1 FROM mind_map_nodes WHERE node_id = $1 AND map_id = $2',
        [parentId, map.map_id]);
      if (!p.rows.length) return res.status(400).json({ error: 'parentId is not a node in this map' });
    }

    const orderRes = await query(
      `SELECT COALESCE(MAX(order_index) + 1, 0) AS next FROM mind_map_nodes
       WHERE map_id = $1 AND parent_id IS NOT DISTINCT FROM $2`, [map.map_id, parentId || null]);

    const nodeId = 'mmn_' + uuidv4();
    await query(`
      INSERT INTO mind_map_nodes
        (node_id, map_id, parent_id, label, summary, detail, node_type, color, icon, order_index)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [nodeId, map.map_id, parentId || null, clean(label, 120), clean(summary, 400),
        clean(detail, 1500), nodeType || 'leaf', color || null, icon || null,
        Number(orderRes.rows[0].next) || 0]);

    await Engine.touchMap(map.map_id);
    res.status(201).json({ ok: true, nodeId });
  } catch (err) {
    console.error('Mind map add node error:', err);
    res.status(500).json({ error: 'Failed to add node' });
  }
});

// ── PATCH /:mapId/nodes/:nodeId ────────────────────────────────
router.patch('/:mapId/nodes/:nodeId', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const node = await requireOwnedNode(req, res, map.map_id);
    if (!node) return;

    const { label, summary, detail, nodeType, color, icon, collapsed, x, y, parentId } = req.body || {};
    if (nodeType && !NODE_TYPES.includes(nodeType)) {
      return res.status(400).json({ error: `nodeType must be one of: ${NODE_TYPES.join(', ')}` });
    }
    if (color && color !== '' && !HEX.test(color)) {
      return res.status(400).json({ error: 'color must be #rrggbb' });
    }

    // Reparenting: reject anything that would build a cycle. A node cannot
    // become a child of its own descendant, or the tree read recurses forever.
    if (parentId !== undefined && parentId !== null) {
      if (parentId === node.node_id) {
        return res.status(400).json({ error: 'a node cannot be its own parent' });
      }
      const target = await query('SELECT 1 FROM mind_map_nodes WHERE node_id = $1 AND map_id = $2',
        [parentId, map.map_id]);
      if (!target.rows.length) {
        return res.status(400).json({ error: 'parentId is not a node in this map' });
      }
      const chain = await query(`
        WITH RECURSIVE up AS (
          SELECT node_id, parent_id FROM mind_map_nodes WHERE node_id = $1
          UNION ALL
          SELECT n.node_id, n.parent_id FROM mind_map_nodes n JOIN up ON up.parent_id = n.node_id
        ) SELECT node_id FROM up
      `, [parentId]);
      if (chain.rows.some(r => r.node_id === node.node_id)) {
        return res.status(400).json({ error: 'that move would create a cycle' });
      }
    }

    await query(`
      UPDATE mind_map_nodes SET
        label     = COALESCE($2, label),
        summary   = COALESCE($3, summary),
        detail    = COALESCE($4, detail),
        node_type = COALESCE($5, node_type),
        color     = CASE WHEN $6::text IS NULL THEN color WHEN $6 = '' THEN NULL ELSE $6 END,
        icon      = COALESCE($7, icon),
        collapsed = COALESCE($8, collapsed),
        x         = COALESCE($9, x),
        y         = COALESCE($10, y),
        parent_id = CASE WHEN $11::text IS NULL THEN parent_id
                         WHEN $11 = '' THEN NULL ELSE $11 END
      WHERE node_id = $1
    `, [node.node_id,
        label !== undefined ? clean(label, 120) : null,
        summary !== undefined ? clean(summary, 400) : null,
        detail !== undefined ? clean(detail, 1500) : null,
        nodeType ?? null,
        color !== undefined ? color : null,
        icon !== undefined ? icon : null,
        typeof collapsed === 'boolean' ? collapsed : null,
        Number.isFinite(x) ? x : null,
        Number.isFinite(y) ? y : null,
        parentId !== undefined ? (parentId === null ? '' : parentId) : null]);

    await Engine.touchMap(map.map_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mind map node update error:', err);
    res.status(500).json({ error: 'Failed to update node' });
  }
});

// ── DELETE /:mapId/nodes/:nodeId ───────────────────────────────
router.delete('/:mapId/nodes/:nodeId', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const node = await requireOwnedNode(req, res, map.map_id);
    if (!node) return;
    if (!node.parent_id) {
      return res.status(400).json({ error: 'cannot delete the root — delete the map instead' });
    }
    // The self-FK cascades, so this removes the whole subtree.
    const del = await query('DELETE FROM mind_map_nodes WHERE node_id = $1', [node.node_id]);
    await Engine.touchMap(map.map_id);
    res.json({ ok: true, deleted: del.rowCount });
  } catch (err) {
    console.error('Mind map node delete error:', err);
    res.status(500).json({ error: 'Failed to delete node' });
  }
});

// ── POST /:mapId/nodes/:nodeId/expand ──────────────────────────
router.post('/:mapId/nodes/:nodeId/expand', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const node = await requireOwnedNode(req, res, map.map_id);
    if (!node) return;
    const out = await Engine.expandNode(map.map_id, node.node_id);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('Mind map expand error:', err);
    res.status(500).json({ error: 'Failed to expand node', details: err.message });
  }
});

// ── POST /:mapId/nodes/:nodeId/chat ────────────────────────────
// Binds a chat session to a node and hands back the session id plus a seeded
// opening prompt carrying the node's ancestor path.
//
// It deliberately does NOT run the agent here. Sending through the existing
// /api/ai-chat/send keeps one code path for token debiting, the proof chain,
// Sentinel pre-checks and MemoryEngine ingest — forking that logic into this
// route would mean two places to keep correct.
router.post('/:mapId/nodes/:nodeId/chat', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const node = await requireOwnedNode(req, res, map.map_id);
    if (!node) return;

    const existing = await query('SELECT session_id FROM mind_map_chats WHERE node_id = $1', [node.node_id]);
    const sessionId = existing.rows[0]?.session_id || uuidv4();
    if (!existing.rows.length) {
      await query('INSERT INTO mind_map_chats (map_id, node_id, session_id) VALUES ($1,$2,$3)',
        [map.map_id, node.node_id, sessionId]);
    }

    const path = await Engine.ancestorChain(node.node_id);

    // Documents in scope for this node — its own, then its ancestors', then the
    // map's. Shipped in the attachment shape /api/ai-chat/send already accepts,
    // so the client can hand them straight back without a second format.
    const docs = (await Engine.inheritedDocs(node.node_id))
      .filter(d => String(d.extracted || '').trim().length > 40)
      .slice(0, CHAT_DOC_LIMIT)
      .map(d => ({
        docId: d.doc_id,
        name: d.filename,
        kind: d.kind,
        scope: d.node_id === node.node_id ? 'node' : (d.node_id ? 'ancestor' : 'map'),
        text: String(d.extracted).slice(0, CHAT_DOC_CHARS)
      }));

    res.json({
      ok: true,
      sessionId,
      resumed: existing.rows.length > 0,
      node: { nodeId: node.node_id, label: node.label, summary: node.summary },
      path,
      docs,
      // Prefix for a free-typed question, so the agent answers about THIS node
      // rather than the last thing in the transcript.
      contextPrefix: `[Mind map "${map.title}" · ${path.join(' → ')}]`,
      // The frontend POSTs this to /api/ai-chat/send with the session id above.
      seedPrompt:
        `In the context of "${map.title}" (${path.join(' → ')}), explain "${node.label}"` +
        (node.summary ? ` — currently summarised as: ${node.summary}.` : '.') +
        (docs.length ? ` Answer from the attached source document(s) where they cover it, and say so when they do not.` : '')
    });
  } catch (err) {
    console.error('Mind map node chat error:', err);
    res.status(500).json({ error: 'Failed to open node chat' });
  }
});

// ── GET /:mapId/nodes/:nodeId/messages ─────────────────────────
// The node's conversation so far, so reopening a node shows the thread instead
// of a blank panel. Empty (not 404) when nothing has been asked yet.
router.get('/:mapId/nodes/:nodeId/messages', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const node = await requireOwnedNode(req, res, map.map_id);
    if (!node) return;

    const bind = await query('SELECT session_id FROM mind_map_chats WHERE node_id = $1', [node.node_id]);
    if (!bind.rows.length) return res.json({ ok: true, sessionId: null, messages: [] });

    const msgs = await query(`
      SELECT role, content, created_at FROM ai_conversations
       WHERE session_id = $1 AND user_id = $2 AND role IN ('user','assistant')
       ORDER BY created_at ASC LIMIT 60
    `, [bind.rows[0].session_id, req.user.id]);

    res.json({ ok: true, sessionId: bind.rows[0].session_id, messages: msgs.rows });
  } catch (err) {
    console.error('Mind map node messages error:', err);
    res.status(500).json({ error: 'Failed to load node conversation' });
  }
});

// ── POST /:mapId/edges ─────────────────────────────────────────
router.post('/:mapId/edges', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const { fromNode, toNode, label, style } = req.body || {};
    if (!fromNode || !toNode) return res.status(400).json({ error: 'fromNode and toNode are required' });
    if (fromNode === toNode) return res.status(400).json({ error: 'a cross-link needs two different nodes' });

    const both = await query(
      'SELECT node_id FROM mind_map_nodes WHERE map_id = $1 AND node_id = ANY($2::text[])',
      [map.map_id, [fromNode, toNode]]);
    if (both.rows.length !== 2) {
      return res.status(400).json({ error: 'both nodes must belong to this map' });
    }

    const edgeId = 'mme_' + uuidv4();
    await query(`
      INSERT INTO mind_map_edges (edge_id, map_id, from_node, to_node, label, style)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (map_id, from_node, to_node) DO UPDATE SET label = EXCLUDED.label, style = EXCLUDED.style
    `, [edgeId, map.map_id, fromNode, toNode, clean(label, 120), clean(style, 20) || 'dashed']);
    await Engine.touchMap(map.map_id);
    res.status(201).json({ ok: true, edgeId });
  } catch (err) {
    console.error('Mind map edge error:', err);
    res.status(500).json({ error: 'Failed to add cross-link' });
  }
});

// ── DELETE /:mapId/edges/:edgeId ───────────────────────────────
router.delete('/:mapId/edges/:edgeId', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const del = await query('DELETE FROM mind_map_edges WHERE edge_id = $1 AND map_id = $2',
      [req.params.edgeId, map.map_id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Cross-link not found' });
    await Engine.touchMap(map.map_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mind map edge delete error:', err);
    res.status(500).json({ error: 'Failed to remove cross-link' });
  }
});

// ── POST /:mapId/layout ────────────────────────────────────────
// Bulk position save. One statement via unnest — a marquee drag can move 40+
// nodes, and awaiting per node loses positions when the drag outruns the writes
// (the same failure neuralMap.js hit).
router.post('/:mapId/layout', requireAuth, async (req, res) => {
  try {
    const map = await requireOwnedMap(req, res);
    if (!map) return;
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    if (positions.length > 500) return res.status(400).json({ error: 'Too many nodes in one request' });

    // Dedupe: one UPDATE ... FROM cannot touch the same row twice. Last wins.
    const byId = new Map();
    for (const p of positions) {
      if (!p || typeof p.nodeId !== 'string' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      byId.set(p.nodeId, p);
    }
    const valid = [...byId.values()];
    if (valid.length) {
      await query(`
        UPDATE mind_map_nodes n SET x = t.x, y = t.y
        FROM unnest($2::text[], $3::real[], $4::real[]) AS t(id, x, y)
        WHERE n.node_id = t.id AND n.map_id = $1
      `, [map.map_id, valid.map(p => p.nodeId), valid.map(p => p.x), valid.map(p => p.y)]);
      await Engine.touchMap(map.map_id);
    }
    res.json({ ok: true, saved: valid.length, skipped: positions.length - valid.length });
  } catch (err) {
    console.error('Mind map layout error:', err);
    res.status(500).json({ error: 'Failed to save layout' });
  }
});

// ── GET /:mapId/export ─────────────────────────────────────────
router.get('/:mapId/export', requireAuth, async (req, res) => {
  const format = String(req.query.format || 'markdown').toLowerCase();
  try {
    const full = await Engine.getMap(req.params.mapId, req.user.id);
    if (!full) return res.status(404).json({ error: 'Map not found' });

    if (format === 'markdown') {
      res.type('text/markdown').send(toMarkdown(full));
    } else if (format === 'opml') {
      res.type('text/x-opml').send(toOpml(full));
    } else if (format === 'png') {
      // PNG is a canvas render — the browser owns it, the server has no canvas.
      res.status(501).json({ error: 'PNG export happens client-side from the canvas' });
    } else {
      res.status(400).json({ error: 'format must be markdown or opml' });
    }
  } catch (err) {
    console.error('Mind map export error:', err);
    res.status(500).json({ error: 'Failed to export mind map' });
  }
});

// ── export helpers ─────────────────────────────────────────────

function childrenOf(nodes, parentId) {
  return nodes.filter(n => n.parent_id === parentId).sort((a, b) => a.order_index - b.order_index);
}

function toMarkdown({ map, nodes }) {
  const root = nodes.find(n => !n.parent_id);
  const lines = [`# ${map.title || 'Mind map'}`, ''];
  if (root?.summary) lines.push(root.summary, '');
  const walk = (parentId, depth) => {
    for (const n of childrenOf(nodes, parentId)) {
      lines.push(`${'  '.repeat(Math.max(0, depth - 1))}- **${n.label}**${n.summary ? ` — ${n.summary}` : ''}`);
      if (n.detail) lines.push(`${'  '.repeat(depth)}${n.detail}`);
      walk(n.node_id, depth + 1);
    }
  };
  if (root) walk(root.node_id, 1);
  return lines.join('\n') + '\n';
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toOpml({ map, nodes }) {
  const root = nodes.find(n => !n.parent_id);
  const walk = (parentId, indent) => childrenOf(nodes, parentId).map(n => {
    const kids = walk(n.node_id, indent + '  ');
    const attrs = `text="${xmlEscape(n.label)}"` + (n.summary ? ` _note="${xmlEscape(n.summary)}"` : '');
    return kids
      ? `${indent}<outline ${attrs}>\n${kids}\n${indent}</outline>`
      : `${indent}<outline ${attrs}/>`;
  }).join('\n');

  const body = root
    ? `    <outline text="${xmlEscape(root.label)}">\n${walk(root.node_id, '      ')}\n    </outline>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>${xmlEscape(map.title || 'Mind map')}</title></head>
  <body>
${body}
  </body>
</opml>
`;
}

module.exports = router;
