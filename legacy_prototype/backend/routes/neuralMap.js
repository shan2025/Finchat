// routes/neuralMap.js — Neural Map: a live graph of the real FinChat system.
//
// The graph is DERIVED at read time from actual state, never hand-authored:
//   • agents        ← agent_configs (id, capabilities, wired tool manifest, runtime_settings)
//   • tools         ← the tool names each agent is actually wired to, described by ToolRegistry
//   • entities      ← Sprint 5C knowledge graph (entities / entity_edges), grown by ReflectionEngine
//   • chain         ← proof_chain + token ledger, with live height / anchor counts
//   • you           ← the signed-in user
//
// On top of the derived graph we merge the user's own annotations, custom nodes
// and hand-drawn connections (see migration 1720000000014_neural-map).

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { getToolMeta } = require('../services/cognitive/ToolRegistry');

const NN = require('../../frontend/nn_core');

const NODE_TYPES = ['agent', 'tool', 'entity', 'chain', 'doc', 'idea'];

// Deterministic key for a derived edge, so annotations survive a rebuild.
const edgeKeyFor = (from, to) => `${from}~${to}`;

// The built-in map: the graph derived from live system state. It has no row in
// neural_maps — it exists for every user, and is the only map that carries
// derived nodes. User-created knowledge maps start blank.
const SYSTEM_MAP = 'system';

/**
 * Resolve ?mapId= to a map this user actually owns. Returns null (→ 404) for
 * someone else's map, so map ids can't be probed by guessing.
 */
async function resolveMap(userId, mapId) {
  if (!mapId || mapId === SYSTEM_MAP) {
    return { map_id: SYSTEM_MAP, name: 'System Map', kind: 'knowledge', derived: true };
  }
  const r = await query(
    `SELECT map_id, name, kind, config, weights, metrics FROM neural_maps WHERE map_id = $1 AND user_id = $2`,
    [mapId, userId]
  );
  return r.rows[0] ? { ...r.rows[0], derived: false } : null;
}

// ══════════════════════════════════════════════════════════
// Maps — "new map" works like starting a new chat
// ══════════════════════════════════════════════════════════

/** GET /api/neural-map/maps — the System Map plus every map you've made. */
router.get('/maps', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT map_id, name, kind, config, metrics, created_at, updated_at
       FROM neural_maps WHERE user_id = $1 ORDER BY created_at ASC`,
      [req.user.id]
    );
    const counts = await query(
      `SELECT map_id, COUNT(*)::int AS c FROM neural_map_nodes WHERE user_id = $1 GROUP BY map_id`,
      [req.user.id]
    );
    const byMap = new Map(counts.rows.map(x => [x.map_id, x.c]));
    res.json({
      maps: [
        { mapId: SYSTEM_MAP, name: 'System Map', kind: 'knowledge', builtIn: true,
          subtitle: 'Live graph of your agents, tools and memory' },
        ...r.rows.map(m => ({
          mapId: m.map_id, name: m.name, kind: m.kind, builtIn: false,
          config: m.config, metrics: m.metrics,
          nodeCount: byMap.get(m.map_id) || 0,
          createdAt: m.created_at, updatedAt: m.updated_at
        }))
      ]
    });
  } catch (err) {
    console.error('List maps error:', err);
    res.status(500).json({ error: 'Failed to list maps' });
  }
});

/**
 * POST /api/neural-map/maps — create a map.
 * Body: { name, kind: 'knowledge' | 'network', config? }
 */
router.post('/maps', requireAuth, async (req, res) => {
  try {
    const kind = req.body?.kind === 'network' ? 'network' : 'knowledge';
    const name = (req.body?.name || '').toString().trim().slice(0, 80)
      || (kind === 'network' ? 'Untitled network' : 'Untitled map');
    const config = kind === 'network' ? NN.normalizeConfig(req.body?.config) : {};
    const mapId = `map_${randomUUID()}`;
    await query(
      `INSERT INTO neural_maps (map_id, user_id, name, kind, config) VALUES ($1, $2, $3, $4, $5)`,
      [mapId, req.user.id, name, kind, JSON.stringify(config)]
    );
    res.json({ ok: true, mapId, name, kind, config });
  } catch (err) {
    console.error('Create map error:', err);
    res.status(500).json({ error: 'Failed to create map' });
  }
});

/** PATCH /api/neural-map/maps/:mapId — rename. */
router.patch('/maps/:mapId', requireAuth, async (req, res) => {
  try {
    if (req.params.mapId === SYSTEM_MAP) {
      return res.status(400).json({ error: 'The System Map is built in and cannot be renamed.' });
    }
    const name = (req.body?.name || '').toString().trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const r = await query(
      `UPDATE neural_maps SET name = $3, updated_at = now() WHERE map_id = $1 AND user_id = $2 RETURNING map_id`,
      [req.params.mapId, req.user.id, name]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Map not found' });
    res.json({ ok: true, name });
  } catch (err) {
    console.error('Rename map error:', err);
    res.status(500).json({ error: 'Failed to rename map' });
  }
});

/** DELETE /api/neural-map/maps/:mapId — remove a map and everything in it. */
router.delete('/maps/:mapId', requireAuth, async (req, res) => {
  try {
    const mapId = req.params.mapId;
    if (mapId === SYSTEM_MAP) {
      return res.status(400).json({ error: 'The System Map is built in and cannot be deleted.' });
    }
    const r = await query(`DELETE FROM neural_maps WHERE map_id = $1 AND user_id = $2 RETURNING map_id`,
      [mapId, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Map not found' });
    // map_id has no FK (it carries a 'system' sentinel default), so clean up here.
    for (const t of ['neural_map_nodes', 'neural_map_edges', 'neural_map_node_meta', 'neural_map_edge_meta']) {
      await query(`DELETE FROM ${t} WHERE user_id = $1 AND map_id = $2`, [req.user.id, mapId]);
    }
    res.json({ ok: true, deleted: mapId });
  } catch (err) {
    console.error('Delete map error:', err);
    res.status(500).json({ error: 'Failed to delete map' });
  }
});

/** GET /api/neural-map/maps/:mapId/network — config, weights and metrics. */
router.get('/maps/:mapId/network', requireAuth, async (req, res) => {
  try {
    const map = await resolveMap(req.user.id, req.params.mapId);
    if (!map) return res.status(404).json({ error: 'Map not found' });
    if (map.kind !== 'network') return res.status(400).json({ error: 'That map is not a neural network' });
    res.json({
      mapId: map.map_id, name: map.name,
      config: NN.normalizeConfig(map.config),
      weights: map.weights || null,
      metrics: map.metrics || {},
      layers: NN.layerSizes(NN.normalizeConfig(map.config)),
      paramCount: NN.paramCount(NN.normalizeConfig(map.config))
    });
  } catch (err) {
    console.error('Get network error:', err);
    res.status(500).json({ error: 'Failed to load network' });
  }
});

/**
 * PUT /api/neural-map/maps/:mapId/network — persist architecture, learned
 * weights and the latest evaluation, so a trained network survives a reload.
 */
router.put('/maps/:mapId/network', requireAuth, async (req, res) => {
  try {
    const map = await resolveMap(req.user.id, req.params.mapId);
    if (!map) return res.status(404).json({ error: 'Map not found' });
    if (map.kind !== 'network') return res.status(400).json({ error: 'That map is not a neural network' });

    const config = NN.normalizeConfig(req.body?.config ?? map.config);
    const weights = req.body?.weights ?? null;
    const metrics = req.body?.metrics && typeof req.body.metrics === 'object' ? req.body.metrics : {};

    await query(
      `UPDATE neural_maps SET config = $3, weights = $4, metrics = $5, updated_at = now()
       WHERE map_id = $1 AND user_id = $2`,
      [map.map_id, req.user.id, JSON.stringify(config),
        weights ? JSON.stringify(weights) : null, JSON.stringify(metrics)]
    );
    res.json({ ok: true, config });
  } catch (err) {
    console.error('Save network error:', err);
    res.status(500).json({ error: 'Failed to save network' });
  }
});

/**
 * POST /api/neural-map/maps/:mapId/evaluate — train server-side and report
 * every metric. Runs the same nn_core the browser uses, so this doubles as an
 * independent check that what the UI shows is real.
 * Body: { epochs }
 */
router.post('/maps/:mapId/evaluate', requireAuth, async (req, res) => {
  try {
    const map = await resolveMap(req.user.id, req.params.mapId);
    if (!map) return res.status(404).json({ error: 'Map not found' });
    if (map.kind !== 'network') return res.status(400).json({ error: 'That map is not a neural network' });

    const epochs = Math.max(0, Math.min(20000, parseInt(req.body?.epochs) || 0));
    const config = NN.normalizeConfig(map.config);
    const net = NN.hydrate(config, map.weights);
    const data = NN.buildData(config);
    for (let i = 0; i < epochs; i++) NN.trainEpoch(net, data.train);

    const trainM = NN.evaluate(net, data.train);
    const testM = NN.evaluate(net, data.test);
    const truthM = NN.evaluateAgainstTruth(net);
    const diag = NN.diagnose(trainM, testM);
    const metrics = {
      epoch: net.epoch, train: trainM, test: testM, truth: truthM,
      bias: diag.bias, variance: diag.variance, gap: diag.gap,
      verdict: diag.verdict, tone: diag.tone,
      paramCount: NN.paramCount(config), layers: NN.layerSizes(config),
      evaluatedAt: new Date().toISOString()
    };
    await query(
      `UPDATE neural_maps SET weights = $3, metrics = $4, updated_at = now()
       WHERE map_id = $1 AND user_id = $2`,
      [map.map_id, req.user.id, JSON.stringify(NN.serialize(net)), JSON.stringify(metrics)]
    );
    res.json({ ok: true, metrics });
  } catch (err) {
    console.error('Evaluate network error:', err);
    res.status(500).json({ error: 'Failed to evaluate network' });
  }
});

/**
 * GET /api/neural-map — the whole graph: derived nodes + edges, merged with
 * this user's annotations, custom nodes and custom edges.
 * ?mapId= selects a map; omitted means the built-in System Map.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const map = await resolveMap(userId, req.query.mapId);
    if (!map) return res.status(404).json({ error: 'Map not found' });
    if (map.kind === 'network') {
      return res.status(400).json({ error: 'That map is a neural network — use /maps/:mapId/network' });
    }
    const mapId = map.map_id;
    // Only the built-in map carries the derived system graph; a map you made
    // starts blank so it's yours to build.
    const isSystem = mapId === SYSTEM_MAP;

    const [agentsQ, entsQ, entEdgesQ, chainQ, customNodesQ, customEdgesQ, nodeMetaQ, edgeMetaQ, userQ] =
      await Promise.all([
        query(`SELECT ac.agent_id, a.name, ac.capabilities, ac.tools, ac.runtime_settings, ac.memory_namespace
               FROM agent_configs ac JOIN agents a ON a.agent_id = ac.agent_id
               ORDER BY ac.agent_id`),
        // The knowledge layer is PER USER. This used to select every active entity
        // with no owner filter, which is why every account opened the identical
        // "master" map and saw topics mined from other people's chats. Rows with a
        // NULL user_id are pre-ownership legacy data and belong to nobody, so they
        // stay hidden rather than being shown to everyone.
        query(`SELECT entity_id, canonical_name, entity_type, mention_count,
                      summary, importance, confidence, activation_count, last_activated_at, owner_agent, community_id
               FROM entities WHERE status = 'active' AND user_id = $1
               ORDER BY importance DESC, mention_count DESC LIMIT 120`, [userId]),
        // Edges are constrained to those whose BOTH endpoints belong to this user,
        // so a legacy cross-user edge cannot drag a foreign node onto the map.
        query(`SELECT ee.from_entity_id, ee.to_entity_id, ee.edge_type, ee.weight, ee.strength, ee.reason, ee.source
               FROM entity_edges ee
               JOIN entities ef ON ef.entity_id = ee.from_entity_id AND ef.user_id = $1
               JOIN entities et ON et.entity_id = ee.to_entity_id   AND et.user_id = $1
               ORDER BY ee.strength DESC, ee.weight DESC LIMIT 400`, [userId]),
        query(`SELECT COUNT(*)::int AS total_blocks,
                      COUNT(*) FILTER (WHERE solana_confirmed = 1)::int AS anchored,
                      COALESCE(MAX(chain_height), 0) AS max_height
               FROM proof_chain`),
        query(`SELECT node_key, label, node_type, note, meta, apis FROM neural_map_nodes WHERE user_id = $1 AND map_id = $2`, [userId, mapId]),
        query(`SELECT edge_key, from_key, to_key FROM neural_map_edges WHERE user_id = $1 AND map_id = $2`, [userId, mapId]),
        query(`SELECT node_key, note, label_override, pos_x, pos_y, hidden, color FROM neural_map_node_meta WHERE user_id = $1 AND map_id = $2`, [userId, mapId]),
        query(`SELECT edge_key, note, api, flow, payload, style FROM neural_map_edge_meta WHERE user_id = $1 AND map_id = $2`, [userId, mapId]),
        query(`SELECT name, role, token_balance FROM users WHERE user_id = $1`, [userId])
      ]);

    const nodes = [];
    const edges = [];
    const pushEdge = (from, to, note, api, flow) => {
      edges.push({ key: edgeKeyFor(from, to), from, to, note: note || '', api: api || '', flow: flow || '', payload: '', derived: true });
    };

    const toolsSeen = new Set();
    let ch = {};
    let communities = [];

    if (isSystem) {
    // ── you ────────────────────────────────────────────────
    const me = userQ.rows[0] || {};
    nodes.push({
      key: 'user:me',
      label: me.name || 'You',
      type: 'idea',
      note: 'That’s you — the root of your map. Everything you own hangs off here.',
      meta: [['Role', me.role || 'staff'], ['Balance', String(me.token_balance ?? '—')]],
      apis: [],
      derived: true
    });

    // ── agents + the tools they are actually wired to ──────
    for (const a of agentsQ.rows) {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [];
      const tools = Array.isArray(a.tools) ? a.tools : [];
      const rs = a.runtime_settings || {};
      const meta = [['Tools', String(tools.length)], ['Capabilities', String(caps.length)]];
      if (rs.risk) meta.push(['Risk', String(rs.risk)]);
      if (rs.model) meta.push(['Model', String(rs.model)]);

      nodes.push({
        key: `agent:${a.agent_id}`,
        label: a.name || a.agent_id,
        type: 'agent',
        note: `Capabilities: ${caps.slice(0, 8).join(', ') || 'none declared'}.`,
        meta,
        apis: a.memory_namespace ? [`memory: ${a.memory_namespace}`] : [],
        derived: true
      });

      for (const tname of tools) {
        const tkey = `tool:${tname}`;
        if (!toolsSeen.has(tkey)) {
          toolsSeen.add(tkey);
          const md = getToolMeta(tname);
          nodes.push({
            key: tkey,
            label: tname,
            type: 'tool',
            note: md?.description || `The "${tname}" tool.`,
            meta: [
              ['Cache', md?.cacheTTLSeconds ? `${md.cacheTTLSeconds}s` : '—'],
              ['Rate limit', md?.rateLimitPerMinute ? `${md.rateLimitPerMinute}/min` : '—']
            ],
            apis: [],
            derived: true
          });
        }
        pushEdge(`agent:${a.agent_id}`, tkey, `${a.name || a.agent_id} calls the ${tname} tool.`, '', 'agent → tool');
      }

      if (a.agent_id !== 'plato') {
        pushEdge('agent:plato', `agent:${a.agent_id}`, `Plato delegates to ${a.name || a.agent_id}.`, '', 'Plato → specialist');
      }
    }
    if (agentsQ.rows.some(a => a.agent_id === 'plato')) {
      pushEdge('user:me', 'agent:plato', 'You talk to Plato in chat.', '/api/ai-chat/send', 'you ↔ Plato');
    }

    // ── proof chain + ledger ───────────────────────────────
    ch = chainQ.rows[0] || {};
    nodes.push({
      key: 'sys:proofchain',
      label: 'Proof Chain',
      type: 'chain',
      note: 'Append-only SHA-256 hash chain anchoring every message. Every 10th block is anchored to Solana devnet.',
      meta: [['Height', String(ch.max_height ?? 0)], ['Blocks', String(ch.total_blocks ?? 0)], ['Anchored', String(ch.anchored ?? 0)]],
      apis: ['/api/agents/integrity'],
      derived: true
    });
    nodes.push({
      key: 'sys:ledger',
      label: 'Token Ledger',
      type: 'chain',
      note: 'Tracks the 5-token-per-message accounting, penalties and freezes.',
      meta: [['Rate', '5 / msg']],
      apis: ['/api/tokens/balance'],
      derived: true
    });
    nodes.push({
      key: 'sys:solana',
      label: 'Solana Devnet',
      type: 'chain',
      note: 'Memo-program anchoring target. Each checkpoint block gets a real devnet transaction.',
      meta: [['Network', 'devnet'], ['Interval', 'every 10 blocks']],
      apis: ['https://api.devnet.solana.com'],
      derived: true
    });
    pushEdge('sys:proofchain', 'sys:solana', 'Checkpoint blocks are anchored on Solana devnet.', '', 'chain → Solana');
    pushEdge('user:me', 'sys:ledger', 'Your messages burn tokens from the ledger.', '', 'you → ledger');
    pushEdge('user:me', 'sys:proofchain', 'Every message you send is hashed into the chain.', '', 'you → chain');

    // ── Sprint 5C knowledge graph ──────────────────────────
    // Named neighborhoods (Stage 4b) — color/group the living nodes by cluster.
    const communityQ = await query(`SELECT community_id, label, summary, color, size FROM graph_communities ORDER BY size DESC`);
    const communityById = new Map(communityQ.rows.map(c => [c.community_id, c]));
    communities = communityQ.rows.map(c => ({
      id: c.community_id, label: c.label, summary: c.summary || '', color: c.color, size: c.size
    }));

    const entKeys = new Set();
    for (const e of entsQ.rows) {
      const k = `entity:${e.entity_id}`;
      entKeys.add(e.entity_id);
      const meta = [['Type', e.entity_type], ['Mentions', String(e.mention_count)],
        ['Importance', `${Math.round(e.importance * 10) / 10}/10`],
        ['Confidence', `${Math.round(e.confidence * 100)}%`]];
      if (e.activation_count > 0) meta.push(['Activations', String(e.activation_count)]);
      if (e.owner_agent) meta.push(['Agent', e.owner_agent]);
      const community = e.community_id ? communityById.get(e.community_id) : null;
      if (community) meta.push(['Neighborhood', community.label]);
      nodes.push({
        key: k,
        label: e.canonical_name,
        type: 'entity',
        note: e.summary || `Learned from your conversations. Mentioned ${e.mention_count} time${e.mention_count === 1 ? '' : 's'}.`,
        meta,
        apis: [],
        derived: true,
        // Living-node payload for the Cognitive Memory Engine UI
        living: {
          entityId: e.entity_id,
          importance: e.importance,
          confidence: e.confidence,
          activationCount: e.activation_count,
          lastActivatedAt: e.last_activated_at,
          community: community ? { id: community.community_id, label: community.label, color: community.color } : null
        }
      });
    }
    for (const ed of entEdgesQ.rows) {
      if (!entKeys.has(ed.from_entity_id) || !entKeys.has(ed.to_entity_id)) continue;
      pushEdge(
        `entity:${ed.from_entity_id}`,
        `entity:${ed.to_entity_id}`,
        ed.reason || `${ed.edge_type.replace(/_/g, ' ')} · weight ${ed.weight}`,
        '',
        ed.edge_type
      );
      // strength drives edge thickness in the living-graph render
      edges[edges.length - 1].strength = ed.strength;
    }

    } // end derived block — a user-made knowledge map holds only its own nodes

    // ── the user's own nodes / edges ───────────────────────
    for (const n of customNodesQ.rows) {
      nodes.push({
        key: n.node_key,
        label: n.label,
        type: n.node_type,
        note: n.note || '',
        meta: Array.isArray(n.meta) ? n.meta : [],
        apis: Array.isArray(n.apis) ? n.apis : [],
        derived: false
      });
    }
    for (const e of customEdgesQ.rows) {
      edges.push({ key: e.edge_key, from: e.from_key, to: e.to_key, note: '', api: '', flow: '', payload: '', derived: false });
    }

    // ── merge annotations ──────────────────────────────────
    const nodeMeta = new Map(nodeMetaQ.rows.map(r => [r.node_key, r]));
    const visible = [];
    for (const n of nodes) {
      const m = nodeMeta.get(n.key);
      if (m) {
        if (m.hidden) continue;
        if (m.note != null) n.note = m.note;
        if (m.label_override) n.label = m.label_override;
        if (m.pos_x != null && m.pos_y != null) { n.x = m.pos_x; n.y = m.pos_y; }
        if (m.color) n.color = m.color;
      }
      visible.push(n);
    }
    const liveKeys = new Set(visible.map(n => n.key));

    const edgeMeta = new Map(edgeMetaQ.rows.map(r => [r.edge_key, r]));
    const liveEdges = edges.filter(e => liveKeys.has(e.from) && liveKeys.has(e.to));
    for (const e of liveEdges) {
      const m = edgeMeta.get(e.key);
      if (!m) continue;
      if (m.note != null) e.note = m.note;
      if (m.api != null) e.api = m.api;
      if (m.flow != null) e.flow = m.flow;
      if (m.payload != null) e.payload = m.payload;
      if (m.style) e.style = m.style;
    }

    // Per-type counts of what is actually visible, computed server-side so the
    // legend can't drift from the data (and so tests can assert the math).
    const typeCounts = {};
    for (const n of visible) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    res.json({
      nodes: visible,
      edges: liveEdges,
      communities,
      map: { mapId, name: map.name, kind: map.kind, builtIn: isSystem },
      stats: {
        agents: isSystem ? agentsQ.rows.length : 0,
        tools: toolsSeen.size,
        entities: isSystem ? entsQ.rows.length : 0,
        chainHeight: isSystem ? (parseInt(ch.max_height) || 0) : 0,
        custom: customNodesQ.rows.length,
        nodes: visible.length,
        edges: liveEdges.length,
        typeCounts
      }
    });
  } catch (err) {
    console.error('Neural map load error:', err);
    res.status(500).json({ error: 'Failed to load neural map' });
  }
});

/**
 * Every mutation below is scoped to a map the caller owns. Without this, an
 * edit made in one map would bleed into all of them.
 */
async function requireOwnedMap(req, res) {
  const mapId = req.body?.mapId || req.query.mapId || SYSTEM_MAP;
  const map = await resolveMap(req.user.id, mapId);
  if (!map) { res.status(404).json({ error: 'Map not found' }); return null; }
  if (map.kind === 'network') {
    res.status(400).json({ error: 'That map is a neural network, not a graph' });
    return null;
  }
  return map.map_id;
}

/** PUT /api/neural-map/nodes/:key — save a note / rename / pinned position. */
router.put('/nodes/:key', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const { note, label, x, y, hidden, color } = req.body || {};
    // color: undefined → untouched, '' → reset to the type palette, '#rrggbb' → set.
    if (color !== undefined && color !== '' && !/^#[0-9a-fA-F]{6}$/.test(String(color))) {
      return res.status(400).json({ error: 'color must be a #rrggbb hex value' });
    }
    await query(
      `INSERT INTO neural_map_node_meta (user_id, map_id, node_key, note, label_override, pos_x, pos_y, hidden, color, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, now())
       ON CONFLICT (user_id, map_id, node_key) DO UPDATE SET
         note           = COALESCE(EXCLUDED.note, neural_map_node_meta.note),
         label_override = COALESCE(EXCLUDED.label_override, neural_map_node_meta.label_override),
         pos_x          = COALESCE(EXCLUDED.pos_x, neural_map_node_meta.pos_x),
         pos_y          = COALESCE(EXCLUDED.pos_y, neural_map_node_meta.pos_y),
         hidden         = EXCLUDED.hidden,
         color          = CASE WHEN $9::boolean THEN EXCLUDED.color ELSE neural_map_node_meta.color END,
         updated_at     = now()`,
      [req.user.id, mapId, req.params.key, note ?? null, label ?? null,
        Number.isFinite(x) ? x : null, Number.isFinite(y) ? y : null, hidden ? 1 : 0,
        color !== undefined, color ? String(color) : null]
    );
    // Keep a custom node's own row in sync so it survives independently of the annotation.
    if (req.params.key.startsWith('custom:') && (label != null || note != null)) {
      await query(
        `UPDATE neural_map_nodes SET label = COALESCE($4, label), note = COALESCE($5, note)
         WHERE node_key = $1 AND user_id = $2 AND map_id = $3`,
        [req.params.key, req.user.id, mapId, label ?? null, note ?? null]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Neural map node save error:', err);
    res.status(500).json({ error: 'Failed to save node' });
  }
});

/**
 * POST /api/neural-map/positions — pin a batch of nodes in one round-trip.
 * Used when you select several nodes and drag them somewhere as a group;
 * a PUT per node would be dozens of requests.
 * Pass { positions: [{key, x, y}, ...] }, or { unpin: [key, ...] } to release them.
 */
router.post('/positions', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    const unpin = Array.isArray(req.body?.unpin) ? req.body.unpin : [];
    if (positions.length > 500 || unpin.length > 500) {
      return res.status(400).json({ error: 'Too many nodes in one request' });
    }

    // Select-all can be 40+ nodes. One statement, not one round-trip per node —
    // sequential awaits here are slow enough that a drag finishes before the
    // writes do, and positions get silently lost.
    // Dedupe by key: a single INSERT ... ON CONFLICT cannot touch the same row
    // twice, so a repeated key would abort the whole batch. Last one wins.
    const byNodeKey = new Map();
    for (const p of positions) {
      if (!p || typeof p.key !== 'string' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      byNodeKey.set(p.key, p);
    }
    const valid = [...byNodeKey.values()];
    const written = valid.length;
    if (written) {
      await query(
        `INSERT INTO neural_map_node_meta (user_id, map_id, node_key, pos_x, pos_y, updated_at)
         SELECT $1, $2, k, x, y, now()
         FROM unnest($3::text[], $4::real[], $5::real[]) AS t(k, x, y)
         ON CONFLICT (user_id, map_id, node_key) DO UPDATE SET
           pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, updated_at = now()`,
        [req.user.id, mapId, valid.map(p => p.key), valid.map(p => p.x), valid.map(p => p.y)]
      );
    }
    if (unpin.length) {
      await query(
        `UPDATE neural_map_node_meta SET pos_x = NULL, pos_y = NULL, updated_at = now()
         WHERE user_id = $1 AND map_id = $2 AND node_key = ANY($3::text[])`,
        [req.user.id, mapId, unpin]
      );
    }
    res.json({ ok: true, pinned: written, skipped: positions.length - written, unpinned: unpin.length });
  } catch (err) {
    console.error('Neural map bulk position error:', err);
    res.status(500).json({ error: 'Failed to save positions' });
  }
});

/**
 * GET /api/neural-map/documents — the signed-in user's uploaded files, so they
 * can be dropped onto the map as Document nodes and then connected like any node.
 */
router.get('/documents', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT file_id AS id, filename, mimetype, size_bytes AS size, created_at
         FROM files
        WHERE uploader_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.user.id]
    );
    res.json({ documents: r.rows });
  } catch (err) {
    console.error('Neural map documents error:', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

/** POST /api/neural-map/nodes — create a node of your own. */
router.post('/nodes', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const label = (req.body?.label || 'New node').toString().slice(0, 120);
    const type = NODE_TYPES.includes(req.body?.type) ? req.body.type : 'idea';
    const key = `custom:${randomUUID()}`;
    await query(
      `INSERT INTO neural_map_nodes (node_key, user_id, map_id, label, node_type, note) VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, req.user.id, mapId, label, type, (req.body?.note || '').toString()]
    );
    res.json({ ok: true, key, label, type });
  } catch (err) {
    console.error('Neural map node create error:', err);
    res.status(500).json({ error: 'Failed to create node' });
  }
});

/**
 * DELETE /api/neural-map/nodes/:key — remove a custom node, or hide a derived
 * one. Derived nodes come from real system state, so we can't delete them —
 * hiding keeps the user's map tidy without lying about what exists.
 */
router.delete('/nodes/:key', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const key = req.params.key;
    if (key.startsWith('custom:')) {
      await query(`DELETE FROM neural_map_edges WHERE user_id = $1 AND map_id = $2 AND (from_key = $3 OR to_key = $3)`, [req.user.id, mapId, key]);
      await query(`DELETE FROM neural_map_node_meta WHERE user_id = $1 AND map_id = $2 AND node_key = $3`, [req.user.id, mapId, key]);
      const r = await query(`DELETE FROM neural_map_nodes WHERE node_key = $1 AND user_id = $2 AND map_id = $3`, [key, req.user.id, mapId]);
      return res.json({ ok: true, deleted: r.rowCount > 0, mode: 'deleted' });
    }
    await query(
      `INSERT INTO neural_map_node_meta (user_id, map_id, node_key, hidden, updated_at)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (user_id, map_id, node_key) DO UPDATE SET hidden = 1, updated_at = now()`,
      [req.user.id, mapId, key]
    );
    res.json({ ok: true, mode: 'hidden' });
  } catch (err) {
    console.error('Neural map node delete error:', err);
    res.status(500).json({ error: 'Failed to delete node' });
  }
});

/** POST /api/neural-map/edges — draw a connection of your own. */
router.post('/edges', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const { from, to } = req.body || {};
    if (!from || !to || from === to) return res.status(400).json({ error: 'from and to must be two different nodes' });
    const key = `custom:${randomUUID()}`;
    const r = await query(
      `INSERT INTO neural_map_edges (edge_key, user_id, map_id, from_key, to_key) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, map_id, from_key, to_key) DO NOTHING
       RETURNING edge_key`,
      [key, req.user.id, mapId, from, to]
    );
    if (!r.rows[0]) return res.status(409).json({ error: 'That connection already exists' });
    res.json({ ok: true, key: r.rows[0].edge_key });
  } catch (err) {
    console.error('Neural map edge create error:', err);
    res.status(500).json({ error: 'Failed to create connection' });
  }
});

/** PUT /api/neural-map/edges/:key — annotate a connection. */
router.put('/edges/:key', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const { note, api, flow, payload, style } = req.body || {};
    // style: undefined → untouched, '' → reset to default (solid), else solid|dashed.
    if (style !== undefined && style !== '' && !['solid', 'dashed'].includes(style)) {
      return res.status(400).json({ error: 'style must be "solid" or "dashed"' });
    }
    await query(
      `INSERT INTO neural_map_edge_meta (user_id, map_id, edge_key, note, api, flow, payload, style, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $9, now())
       ON CONFLICT (user_id, map_id, edge_key) DO UPDATE SET
         note    = COALESCE(EXCLUDED.note, neural_map_edge_meta.note),
         api     = COALESCE(EXCLUDED.api, neural_map_edge_meta.api),
         flow    = COALESCE(EXCLUDED.flow, neural_map_edge_meta.flow),
         payload = COALESCE(EXCLUDED.payload, neural_map_edge_meta.payload),
         style   = CASE WHEN $8::boolean THEN EXCLUDED.style ELSE neural_map_edge_meta.style END,
         updated_at = now()`,
      [req.user.id, mapId, req.params.key, note ?? null, api ?? null, flow ?? null, payload ?? null,
        style !== undefined, style ? style : null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Neural map edge save error:', err);
    res.status(500).json({ error: 'Failed to save connection' });
  }
});

/** DELETE /api/neural-map/edges/:key — only user-drawn edges can be removed. */
router.delete('/edges/:key', requireAuth, async (req, res) => {
  try {
    const mapId = await requireOwnedMap(req, res);
    if (!mapId) return;
    const key = req.params.key;
    if (!key.startsWith('custom:')) {
      return res.status(400).json({ error: 'This connection is derived from real system state and cannot be removed.' });
    }
    await query(`DELETE FROM neural_map_edge_meta WHERE user_id = $1 AND map_id = $2 AND edge_key = $3`, [req.user.id, mapId, key]);
    const r = await query(`DELETE FROM neural_map_edges WHERE edge_key = $1 AND user_id = $2 AND map_id = $3`, [key, req.user.id, mapId]);
    res.json({ ok: true, deleted: r.rowCount > 0 });
  } catch (err) {
    console.error('Neural map edge delete error:', err);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

module.exports = router;
