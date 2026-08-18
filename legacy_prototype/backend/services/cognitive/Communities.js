// services/cognitive/Communities.js — Sprint X · Stage 4b
//
// Community detection: cluster the living knowledge graph into named
// neighborhoods so the Neural Map reads as territories ("DeFi", "ML tooling")
// instead of one hairball.
//
//   detectCommunities()  →  label propagation over strength-weighted edges,
//                           short LLM name per cluster, persisted to
//                           graph_communities + entities.community_id
//
// Runs inside the dream cycle. Best-effort: never throws to the dreamer.
// Community ids are content-addressed (hash of sorted member ids) so an
// unchanged cluster keeps its id — and its Stage-2 summary — across runs.

const crypto = require('crypto');
const { query } = require('../../database');
const { runInference } = require('../inference');

// Territory colors — warm, distinct, cycled by cluster index.
const PALETTE = [
  '#c2703d', '#4f7a8c', '#8b6f47', '#6a8f6b', '#9c5b7a',
  '#b08968', '#5c7a99', '#a67c52', '#7d8471', '#98586f',
  '#557a95', '#c08552'
];

const communityIdFor = (memberIds) =>
  'com_' + crypto.createHash('sha1').update([...memberIds].sort().join('|')).digest('hex').slice(0, 12);

// ── Label propagation ──────────────────────────────────────────
// Each node adopts the strongest-weighted label among its neighbors; iterate to
// a fixed point. O(iters · edges), no dependencies, deterministic tie-break.
function labelPropagation(nodeIds, adjacency, maxIter = 25) {
  const label = new Map(nodeIds.map(id => [id, id]));
  // Seeded shuffle for reproducible-enough runs without a full RNG.
  const order = [...nodeIds];
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    // Rotate the visit order each iteration to break sync oscillation.
    order.push(order.shift());
    for (const id of order) {
      const neigh = adjacency.get(id);
      if (!neigh || neigh.size === 0) continue;
      const tally = new Map();
      for (const [nb, w] of neigh) {
        const l = label.get(nb);
        tally.set(l, (tally.get(l) || 0) + w);
      }
      let best = label.get(id), bestW = -1;
      for (const [l, w] of tally) {
        if (w > bestW || (w === bestW && String(l) < String(best))) { bestW = w; best = l; }
      }
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  return label;
}

// Ask the LLM for a 1-3 word name for a cluster from its member names.
// Best-effort — falls back to the most-important member's name.
async function nameCluster(memberNames, fallback, userId = null) {
  const names = memberNames.slice(0, 15).join(', ');
  try {
    const res = await runInference({
      messages: [
        { role: 'system', content: 'You name a cluster of related concepts. Given a list of member names, reply with ONLY a short 1-3 word label for what they have in common (e.g. "DeFi", "ML Tooling", "Career"). No quotes, no punctuation, no explanation.' },
        { role: 'user', content: names }
      ],
      temperature: 0.2,
      feature: 'community_name',
      // Clustering runs over ONE user's graph, so its tokens belong to them.
      userId
    });
    const label = (res.content || '').trim().split('\n')[0].replace(/^["']|["']$/g, '').slice(0, 40);
    return label.length >= 2 ? label : fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * Detect, name and persist communities over the current active graph.
 *
 * @param {object}  opts
 * @param {number}  [opts.minSize=3]   - clusters smaller than this stay unlabeled
 * @param {boolean} [opts.name=true]   - run the LLM naming pass
 * @returns {Promise<{communities, clustered, singletons}>}
 */
/**
 * Drop community rows no entity points at any more. This replaces the old
 * `DELETE FROM graph_communities`, which was safe only while the graph was
 * global and destroys other users' clusters once it is not.
 */
async function pruneOrphanCommunities() {
  await query(`
    DELETE FROM graph_communities gc
    WHERE NOT EXISTS (
      SELECT 1 FROM entities e WHERE e.community_id = gc.community_id
    )
  `);
}

/**
 * Clusters ONE user's graph. Previously this ran over every entity on the
 * instance, so clusters spanned accounts and one person's topics coloured
 * another person's map. Every read and every reset below is user-scoped.
 */
async function detectCommunities({ minSize = 3, name = true, userId = null } = {}) {
  const entsQ = await query(`
    SELECT entity_id, canonical_name, importance
    FROM entities WHERE status = 'active' AND user_id IS NOT DISTINCT FROM $1
  `, [userId]);
  const nodes = entsQ.rows;
  if (nodes.length < minSize) {
    // Not enough graph to cluster — clear this user's stale assignments and bail.
    await query(
      `UPDATE entities SET community_id = NULL WHERE community_id IS NOT NULL AND user_id IS NOT DISTINCT FROM $1`,
      [userId]);
    await pruneOrphanCommunities();
    return { communities: [], clustered: 0, singletons: nodes.length };
  }

  const nodeIds = nodes.map(n => n.entity_id);
  const nameById = new Map(nodes.map(n => [n.entity_id, n.canonical_name]));
  const impById = new Map(nodes.map(n => [n.entity_id, Number(n.importance) || 0]));
  const idSet = new Set(nodeIds);

  // Only edges whose endpoints are both in this user's node set matter; addEdge
  // drops anything outside idSet anyway, but filtering here keeps the scan small.
  const edgesQ = await query(`
    SELECT ee.from_entity_id, ee.to_entity_id, ee.strength, ee.weight
    FROM entity_edges ee
    JOIN entities ef ON ef.entity_id = ee.from_entity_id AND ef.user_id IS NOT DISTINCT FROM $1
    JOIN entities et ON et.entity_id = ee.to_entity_id   AND et.user_id IS NOT DISTINCT FROM $1
  `, [userId]);
  const adjacency = new Map(nodeIds.map(id => [id, new Map()]));
  const addEdge = (a, b, w) => {
    if (!idSet.has(a) || !idSet.has(b) || a === b) return;
    const m = adjacency.get(a);
    m.set(b, (m.get(b) || 0) + w);
  };
  for (const e of edgesQ.rows) {
    // Weight blends strength (0..1) with a small log of raw co-mention weight.
    const w = Math.max(0.05, (Number(e.strength) || 0.5)) + Math.log1p(Number(e.weight) || 1) * 0.1;
    addEdge(e.from_entity_id, e.to_entity_id, w);
    addEdge(e.to_entity_id, e.from_entity_id, w); // undirected
  }

  const label = labelPropagation(nodeIds, adjacency);

  // Group by final label.
  const groups = new Map();
  for (const id of nodeIds) {
    const l = label.get(id);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(id);
  }

  // Keep only clusters >= minSize; sort largest first for stable coloring.
  const kept = [...groups.values()].filter(g => g.length >= minSize)
    .sort((a, b) => b.length - a.length);

  // Rebuild persistence for THIS user (idempotent; content-addressed ids).
  // The old code wiped entities.community_id and the whole graph_communities
  // table globally, so running detection for one user destroyed every other
  // user's clusters. Reset only this user's rows, then drop rows nobody points at.
  await query(
    `UPDATE entities SET community_id = NULL WHERE community_id IS NOT NULL AND user_id IS NOT DISTINCT FROM $1`,
    [userId]);
  await pruneOrphanCommunities();

  // Community ids are content-addressed over their member set, so a cluster
  // whose membership has not changed keeps its id — and therefore its label.
  // Look those up once and reuse them: naming costs one LLM call per cluster,
  // and the scheduled dream cycle re-clusters every user's graph four times a
  // day, where the overwhelming majority of clusters are unchanged. Without
  // this, that sweep re-buys every label it already owns.
  const candidateIds = kept.map(members => communityIdFor(members));
  const existingLabels = new Map();
  if (candidateIds.length > 0) {
    const known = await query(
      `SELECT community_id, label FROM graph_communities WHERE community_id = ANY($1)`,
      [candidateIds]
    );
    for (const row of known.rows) {
      if (row.label) existingLabels.set(row.community_id, row.label);
    }
  }

  const communities = [];
  let clustered = 0;
  for (let i = 0; i < kept.length; i++) {
    const members = kept[i];
    const communityId = candidateIds[i];
    const color = PALETTE[i % PALETTE.length];
    // Representative nodes: highest importance first.
    const topIds = [...members].sort((a, b) => impById.get(b) - impById.get(a)).slice(0, 6);
    const topNames = topIds.map(id => nameById.get(id));
    const fallback = topNames[0] || 'Cluster';
    const label = existingLabels.get(communityId)
      || (name ? await nameCluster(members.map(id => nameById.get(id)), fallback, userId) : fallback);

    await query(`
      INSERT INTO graph_communities (community_id, label, color, size, top_nodes, algo, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'label_propagation', now())
      ON CONFLICT (community_id) DO UPDATE
        SET label = EXCLUDED.label, color = EXCLUDED.color, size = EXCLUDED.size,
            top_nodes = EXCLUDED.top_nodes, updated_at = now()
    `, [communityId, label, color, members.length, JSON.stringify(topNames)]);

    // Assign membership.
    const ph = members.map((_, j) => `$${j + 2}`).join(',');
    await query(`UPDATE entities SET community_id = $1 WHERE entity_id IN (${ph})`, [communityId, ...members]);

    clustered += members.length;
    communities.push({ communityId, label, color, size: members.length, topNodes: topNames });
  }

  return { communities, clustered, singletons: nodes.length - clustered };
}

module.exports = { detectCommunities, communityIdFor, labelPropagation };
