// routes/knowledge.js — Sprint X · Cognitive Memory Engine API
//
// The living knowledge graph, readable and operable:
//   GET  /nodes/:entityId        — full living-node profile (Phase 1)
//   GET  /activity               — recent activations for the thinking view / heatmap (Phases 4-5)
//   GET  /insights               — open gaps / contradictions / dream reports (Phase 7)
//   POST /insights/:id/resolve   — accept or dismiss an insight
//   POST /dream                  — run a consolidation cycle now (Phase 8)
//   POST /gaps                   — run gap detection now
//   GET  /stats                  — graph vitals for dashboards

const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { dream, detectGaps, ingestDocument } = require('../services/cognitive/MemoryEngine');

// ── GET /api/knowledge/nodes/:entityId ─────────────────────
// Everything known about one node: identity, vitals, connections (with the
// reason each link exists), provenance, and its full timeline.
router.get('/nodes/:entityId', requireAuth, async (req, res) => {
  try {
    const { entityId } = req.params;
    const entQ = await query(`SELECT * FROM entities WHERE entity_id = $1`, [entityId]);
    if (entQ.rows.length === 0) return res.status(404).json({ error: 'Node not found' });
    const ent = entQ.rows[0];

    // If this node was merged away, follow the pointer so old links keep working.
    if (ent.status === 'merged' && ent.merged_into) {
      return res.redirect(`/api/knowledge/nodes/${encodeURIComponent(ent.merged_into)}`);
    }

    const [edgesQ, eventsQ, linksQ] = await Promise.all([
      query(`
        SELECT e.edge_id, e.edge_type, e.weight, e.strength, e.confidence, e.reason,
               e.source, e.agent_id, e.activation_count, e.last_activated_at, e.updated_at,
               CASE WHEN e.from_entity_id = $1 THEN 'out' ELSE 'in' END AS direction,
               n.entity_id AS other_id, n.canonical_name AS other_name, n.entity_type AS other_type
        FROM entity_edges e
        JOIN entities n ON n.entity_id = CASE WHEN e.from_entity_id = $1 THEN e.to_entity_id ELSE e.from_entity_id END
        WHERE (e.from_entity_id = $1 OR e.to_entity_id = $1) AND n.status = 'active'
        ORDER BY e.strength DESC, e.weight DESC
        LIMIT 30
      `, [entityId]),
      query(`
        SELECT event_type, detail, source_type, source_id, agent_id, created_at
        FROM node_events WHERE entity_id = $1
        ORDER BY created_at DESC LIMIT 40
      `, [entityId]),
      query(`
        SELECT link_type, link_ref, label, count, last_seen_at
        FROM entity_links WHERE entity_id = $1
        ORDER BY last_seen_at DESC LIMIT 20
      `, [entityId])
    ]);

    res.json({
      node: {
        entityId: ent.entity_id,
        name: ent.canonical_name,
        type: ent.entity_type,
        summary: ent.summary || '',
        importance: ent.importance,
        confidence: ent.confidence,
        mentionCount: ent.mention_count,
        activationCount: ent.activation_count,
        lastActivatedAt: ent.last_activated_at,
        lastSeenAt: ent.last_seen_at,
        createdAt: ent.created_at,
        ownerAgent: ent.owner_agent,
        aliases: ent.aliases || [],
        status: ent.status
      },
      connections: edgesQ.rows.map(e => ({
        direction: e.direction,
        type: e.edge_type,
        reason: e.reason || '',
        strength: e.strength,
        confidence: e.confidence,
        weight: e.weight,
        source: e.source,
        agentId: e.agent_id,
        activationCount: e.activation_count,
        lastActivatedAt: e.last_activated_at,
        other: { entityId: e.other_id, name: e.other_name, type: e.other_type }
      })),
      timeline: eventsQ.rows,
      provenance: linksQ.rows
    });
  } catch (err) {
    console.error('Knowledge node profile error:', err);
    res.status(500).json({ error: 'Failed to load node profile' });
  }
});

// ── GET /api/knowledge/activity?sinceSeconds=60 ────────────
// Recently activated nodes — the "AI is thinking about these" feed.
router.get('/activity', requireAuth, async (req, res) => {
  try {
    const since = Math.max(5, Math.min(3600, parseInt(req.query.sinceSeconds) || 90));
    // Grouped by (entity, source) so the map can animate nodes that were
    // activated TOGETHER (same retrieval / same chat turn) as one thinking path.
    const q = await query(`
      SELECT ne.entity_id, ne.source_id, MAX(ne.created_at) AS at, COUNT(*)::int AS hits,
             MAX(ne.agent_id) AS agent_id, e.canonical_name AS name
      FROM node_events ne
      JOIN entities e ON e.entity_id = ne.entity_id
      WHERE ne.event_type IN ('activated', 'mentioned', 'created')
        AND ne.created_at > now() - ($1 || ' seconds')::interval
      GROUP BY ne.entity_id, ne.source_id, e.canonical_name
      ORDER BY at DESC LIMIT 50
    `, [String(since)]);
    res.json({ activations: q.rows });
  } catch (err) {
    console.error('Knowledge activity error:', err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// ── GET /api/knowledge/insights ────────────────────────────
router.get('/insights', requireAuth, async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const q = await query(`
      SELECT insight_id, kind, title, detail, payload, status, created_at
      FROM graph_insights
      WHERE status = $1 AND (user_id IS NULL OR user_id = $2)
      ORDER BY created_at DESC LIMIT 30
    `, [status, req.user.id]);
    res.json({ insights: q.rows });
  } catch (err) {
    console.error('Knowledge insights error:', err);
    res.status(500).json({ error: 'Failed to load insights' });
  }
});

// ── POST /api/knowledge/insights/:id/resolve  {action: accepted|dismissed} ──
router.post('/insights/:id/resolve', requireAuth, async (req, res) => {
  try {
    const action = req.body.action === 'accepted' ? 'accepted' : 'dismissed';
    const q = await query(`
      UPDATE graph_insights SET status = $2, resolved_at = now()
      WHERE insight_id = $1 AND status = 'open'
      RETURNING insight_id
    `, [req.params.id, action]);
    if (q.rowCount === 0) return res.status(404).json({ error: 'Insight not found or already resolved' });
    res.json({ ok: true, insightId: req.params.id, status: action });
  } catch (err) {
    console.error('Knowledge insight resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve insight' });
  }
});

// ── POST /api/knowledge/insights/:id/learn ─────────────────
// "Learn it" on a gap insight: create the missing concept as a real node,
// wire it to the neighbors the gap sat between, accept the insight.
router.post('/insights/:id/learn', requireAuth, async (req, res) => {
  try {
    const insQ = await query(`
      SELECT insight_id, kind, payload FROM graph_insights
      WHERE insight_id = $1 AND status = 'open'
    `, [req.params.id]);
    if (insQ.rows.length === 0) return res.status(404).json({ error: 'Insight not found or already resolved' });
    const ins = insQ.rows[0];
    if (ins.kind !== 'gap') return res.status(400).json({ error: 'Only gap insights can be learned' });

    const payload = ins.payload || {};
    const concept = String(payload.concept || '').trim();
    if (!concept) return res.status(400).json({ error: 'Gap has no concept name' });

    const { upsertLivingEntity, upsertLivingEdge, findExisting } = require('../services/cognitive/MemoryEngine');
    const ctx = { sourceType: 'gap_fill', sourceId: ins.insight_id, userId: req.user.id };
    const { entityId } = await upsertLivingEntity({
      name: concept,
      type: 'topic',
      summary: payload.why || `Added from a knowledge-gap suggestion.`,
      importance: 6,
      confidence: 0.6
    }, ctx);
    if (!entityId) return res.status(500).json({ error: 'Could not create node' });

    const wired = [];
    for (const neighborName of (Array.isArray(payload.between) ? payload.between : [])) {
      const neighbor = await findExisting(String(neighborName));
      if (!neighbor) continue;
      await upsertLivingEdge({
        fromId: neighbor.entity_id, toId: entityId, edgeType: 'related_to',
        reason: payload.why || `Bridges a knowledge gap near ${neighborName}.`,
        strength: 0.6, source: 'gap_fill'
      });
      wired.push(neighbor.canonical_name);
    }

    await query(`
      UPDATE graph_insights SET status = 'accepted', resolved_at = now() WHERE insight_id = $1
    `, [ins.insight_id]);

    res.json({ ok: true, entityId, concept, wiredTo: wired });
  } catch (err) {
    console.error('Learn gap error:', err);
    res.status(500).json({ error: 'Failed to learn gap', details: err.message });
  }
});

// ── POST /api/knowledge/ingest-document ────────────────────
// Feed raw text (paste, upload, etc.) through the same learning pipeline.
// Body: { text, title, agentId?, docId? }
router.post('/ingest-document', requireAuth, async (req, res) => {
  try {
    const { text, title, agentId, docId } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'text must be at least 20 characters' });
    }
    const report = await ingestDocument({
      text,
      title: title || 'Untitled Document',
      userId: req.user.id,
      agentId: agentId || null,
      docId: docId || null
    });
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('Document ingest error:', err);
    res.status(500).json({ error: 'Document ingestion failed', details: err.message });
  }
});

// ── GET /api/knowledge/cortex/:agentId ─────────────────────
// Per-agent subgraph: nodes owned by this agent + their top connections.
router.get('/cortex/:agentId', requireAuth, async (req, res) => {
  try {
    const { agentId } = req.params;
    const [nodesQ, topQ] = await Promise.all([
      query(`
        SELECT entity_id, canonical_name, entity_type, importance, confidence,
               activation_count, last_activated_at, mention_count
        FROM entities
        WHERE owner_agent = $1 AND status = 'active'
        ORDER BY importance DESC, activation_count DESC
        LIMIT 50
      `, [agentId]),
      query(`
        SELECT e.canonical_name AS node, COUNT(*) AS connections,
               SUM(ee.weight) AS total_weight
        FROM entities e
        JOIN entity_edges ee ON ee.from_entity_id = e.entity_id
        WHERE e.owner_agent = $1 AND e.status = 'active'
        GROUP BY e.canonical_name
        ORDER BY total_weight DESC
        LIMIT 10
      `, [agentId])
    ]);
    res.json({
      agentId,
      nodeCount: nodesQ.rows.length,
      nodes: nodesQ.rows,
      mostConnected: topQ.rows
    });
  } catch (err) {
    console.error('Cortex subgraph error:', err);
    res.status(500).json({ error: 'Failed to load agent cortex', details: err.message });
  }
});

// ── POST /api/knowledge/dream — consolidate now ────────────
router.post('/dream', requireAuth, async (req, res) => {
  try {
    const report = await dream({ userId: req.user.id });
    res.json({ ok: true, report });
  } catch (err) {
    console.error('Dream cycle error:', err);
    res.status(500).json({ error: 'Dream cycle failed', details: err.message });
  }
});

// ── POST /api/knowledge/gaps — hunt for missing concepts ───
router.post('/gaps', requireAuth, async (req, res) => {
  try {
    const gaps = await detectGaps({ userId: req.user.id });
    res.json({ ok: true, gaps });
  } catch (err) {
    console.error('Gap detection error:', err);
    res.status(500).json({ error: 'Gap detection failed', details: err.message });
  }
});

// ── GET /api/knowledge/stats ───────────────────────────────
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const [nodesQ, edgesQ, eventsQ, hotQ, freshQ] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM entities WHERE status = 'active'`),
      query(`SELECT COUNT(*)::int AS n FROM entity_edges`),
      query(`SELECT COUNT(*)::int AS n FROM node_events`),
      query(`
        SELECT entity_id, canonical_name, activation_count FROM entities
        WHERE status = 'active' AND activation_count > 0
        ORDER BY activation_count DESC LIMIT 5
      `),
      query(`
        SELECT entity_id, canonical_name, created_at FROM entities
        WHERE status = 'active' ORDER BY created_at DESC LIMIT 5
      `)
    ]);
    res.json({
      nodes: nodesQ.rows[0].n,
      edges: edgesQ.rows[0].n,
      events: eventsQ.rows[0].n,
      mostActive: hotQ.rows,
      recentlyLearned: freshQ.rows
    });
  } catch (err) {
    console.error('Knowledge stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
