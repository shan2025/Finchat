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
//   POST   /:mapId/edges                  add a cross-link
//   DELETE /:mapId/edges/:edgeId          remove a cross-link
//   POST   /:mapId/layout                 bulk position save
//   GET    /:mapId/export?format=         markdown | opml
//
// Ownership mirrors neuralMap.js: someone else's map is 404, never 401 — a 401
// would confirm the id exists.

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const Engine = require('../services/cognitive/MindMapEngine');

const NODE_TYPES = ['root', 'branch', 'leaf', 'question', 'task'];
const LAYOUTS = ['radial', 'tree', 'freeform'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const clean = (v, max = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

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
  const { sourceType = 'topic', topic, sessionId } = req.body || {};
  try {
    let out;
    if (sourceType === 'topic') {
      if (!clean(topic)) return res.status(400).json({ error: 'topic is required' });
      out = await Engine.generateFromTopic(req.user.id, topic);
    } else if (sourceType === 'chat') {
      if (!clean(sessionId)) return res.status(400).json({ error: 'sessionId is required' });
      out = await Engine.generateFromChat(req.user.id, sessionId);
    } else if (sourceType === 'document' || sourceType === 'graph') {
      // Wired in A5. Refuse explicitly rather than silently producing a
      // topic map from the wrong source — a wrong map is worse than none.
      return res.status(501).json({ error: `sourceType "${sourceType}" is not available yet` });
    } else {
      return res.status(400).json({ error: `unknown sourceType "${sourceType}"` });
    }
    res.status(201).json({ ok: true, ...out });
  } catch (err) {
    console.error('Mind map generate error:', err);
    // A refused stub map is the user's problem to retry, not a server fault.
    const isShape = /refusing to save a stub|topic is required|no conversation found/i.test(err.message);
    res.status(isShape ? 422 : 500).json({ error: 'Failed to generate mind map', details: err.message });
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
    res.json({
      ok: true,
      sessionId,
      resumed: existing.rows.length > 0,
      node: { nodeId: node.node_id, label: node.label, summary: node.summary },
      // The frontend POSTs this to /api/ai-chat/send with the session id above.
      seedPrompt:
        `In the context of "${map.title}" (${path.join(' → ')}), explain "${node.label}"` +
        (node.summary ? ` — currently summarised as: ${node.summary}.` : '.')
    });
  } catch (err) {
    console.error('Mind map node chat error:', err);
    res.status(500).json({ error: 'Failed to open node chat' });
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
