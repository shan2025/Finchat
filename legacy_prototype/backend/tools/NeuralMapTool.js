// tools/NeuralMapTool.js — read the signed-in user's own neural maps.
// Lets any persona reference what the user has drawn/organised on their maps to
// understand how they think ("read my map", "what's on my DeFi map", "use my
// maps to understand me"). Receives the executing user's id via the tool context
// (second execute arg), same pattern as WatchlistTool / NotificationsTool.
//
// Read-only: it lists maps and reads their contents but never creates, edits or
// deletes anything — map authoring stays a deliberate action in the Neural Map UI.
const { query } = require('../database');

const SYSTEM_MAP = 'system';

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  const m = s.match(/^(list|read|get)\b\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase() === 'get' ? 'read' : m[1].toLowerCase(), map: m[2].trim() || undefined };
  return { action: 'list' };
}

// Resolve a map reference (id OR name, case-insensitive) to a map this user owns.
async function resolveMap(userId, ref) {
  if (!ref || ref === SYSTEM_MAP) return { map_id: SYSTEM_MAP, name: 'System Map', kind: 'knowledge', builtIn: true };
  const byId = await query(
    'SELECT map_id, name, kind, config, metrics FROM neural_maps WHERE map_id = $1 AND user_id = $2',
    [ref, userId]
  );
  if (byId.rows[0]) return { ...byId.rows[0], builtIn: false };
  const byName = await query(
    'SELECT map_id, name, kind, config, metrics FROM neural_maps WHERE LOWER(name) = LOWER($1) AND user_id = $2 ORDER BY created_at ASC LIMIT 1',
    [ref, userId]
  );
  return byName.rows[0] ? { ...byName.rows[0], builtIn: false } : null;
}

async function listMaps(userId) {
  const maps = await query(
    `SELECT map_id, name, kind, created_at, updated_at FROM neural_maps
     WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  const counts = await query(
    `SELECT map_id, COUNT(*)::int AS c FROM neural_map_nodes WHERE user_id = $1 GROUP BY map_id`,
    [userId]
  );
  const byMap = new Map(counts.rows.map(x => [x.map_id, x.c]));
  return {
    action: 'list',
    count: maps.rows.length,
    maps: [
      { mapId: SYSTEM_MAP, name: 'System Map', kind: 'knowledge', builtIn: true,
        subtitle: 'Live graph of the user\'s agents, tools and memory' },
      ...maps.rows.map(m => ({
        mapId: m.map_id, name: m.name, kind: m.kind, builtIn: false,
        nodeCount: byMap.get(m.map_id) || 0,
        createdAt: m.created_at, updatedAt: m.updated_at
      }))
    ],
    note: maps.rows.length === 0
      ? 'The user has not created any maps of their own yet — only the built-in System Map exists. Do not invent map contents.'
      : 'To read a map, call this tool again with {"action":"read","map":"<name or id>"}.'
  };
}

async function readMap(userId, ref) {
  const map = await resolveMap(userId, ref);
  if (!map) {
    return { action: 'read', error: `No map named "${ref}" belongs to this user. Use {"action":"list"} to see their maps.` };
  }

  // A trained neural-network map: report its architecture + latest evaluation.
  if (map.kind === 'network') {
    return {
      action: 'read',
      map: { mapId: map.map_id, name: map.name, kind: 'network' },
      config: map.config || {},
      metrics: map.metrics || {},
      note: 'This is a neural-network map — architecture and last evaluation, not a concept graph.'
    };
  }

  // A knowledge map: the user's own nodes, connections and annotations. These
  // are what the user chose to lay out, so they reveal how they think.
  const [nodesQ, edgesQ, nodeMetaQ, edgeMetaQ] = await Promise.all([
    query(`SELECT node_key, label, node_type, note FROM neural_map_nodes WHERE user_id = $1 AND map_id = $2`, [userId, map.map_id]),
    query(`SELECT edge_key, from_key, to_key FROM neural_map_edges WHERE user_id = $1 AND map_id = $2`, [userId, map.map_id]),
    query(`SELECT node_key, note, label_override, hidden FROM neural_map_node_meta WHERE user_id = $1 AND map_id = $2`, [userId, map.map_id]),
    query(`SELECT edge_key, note, flow FROM neural_map_edge_meta WHERE user_id = $1 AND map_id = $2`, [userId, map.map_id])
  ]);

  const nodeMeta = new Map(nodeMetaQ.rows.map(r => [r.node_key, r]));
  const nodes = [];
  const labelByKey = new Map();
  for (const n of nodesQ.rows) {
    const m = nodeMeta.get(n.node_key);
    if (m && m.hidden) continue;
    const label = (m && m.label_override) || n.label;
    const note = (m && m.note != null) ? m.note : (n.note || '');
    labelByKey.set(n.node_key, label);
    nodes.push({ label, type: n.node_type, note });
  }

  const edgeMeta = new Map(edgeMetaQ.rows.map(r => [r.edge_key, r]));
  const edges = edgesQ.rows
    .filter(e => labelByKey.has(e.from_key) && labelByKey.has(e.to_key))
    .map(e => {
      const m = edgeMeta.get(e.edge_key);
      return {
        from: labelByKey.get(e.from_key),
        to: labelByKey.get(e.to_key),
        note: (m && m.note) || '',
        flow: (m && m.flow) || ''
      };
    });

  return {
    action: 'read',
    map: { mapId: map.map_id, name: map.name, kind: 'knowledge', builtIn: !!map.builtIn },
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    note: nodes.length === 0
      ? (map.builtIn
          ? 'The System Map is the live derived graph; the user has added no custom nodes to it. Direct them to the Neural Map page for the full system view.'
          : 'This map is empty — the user has not added nodes to it yet.')
      : undefined
  };
}

async function execute(input, context = {}) {
  const { action = 'list', map } = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Neural maps require a signed-in user context');
  }
  if (action === 'read') return readMap(userId, map);
  return listMaps(userId);
}

module.exports = { execute };
