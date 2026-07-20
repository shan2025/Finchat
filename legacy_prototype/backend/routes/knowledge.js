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

// ── POST /api/knowledge/dream/digest — run the nightly digest now ──
// Consolidate + notify active users. Useful for demoing "While you were away".
router.post('/dream/digest', requireAuth, async (req, res) => {
  try {
    const { runNightlyDigest } = require('../services/cognitive/DreamDigest');
    const notify = req.body?.notify !== false;
    const result = await runNightlyDigest({ notify, windowHours: req.body?.windowHours || 24 });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Dream digest error:', err);
    res.status(500).json({ error: 'Dream digest failed', details: err.message });
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

// ── GET /api/knowledge/communities ─────────────────────────
// Named neighborhoods of the graph (Stage 4b). Each carries its label, color,
// size, representative nodes and — once the dream summarizer runs — a paragraph.
router.get('/communities', requireAuth, async (req, res) => {
  try {
    const q = await query(`
      SELECT community_id, label, summary, color, size, top_nodes, summarized_at, updated_at
      FROM graph_communities
      ORDER BY size DESC, updated_at DESC
      LIMIT 50
    `);
    res.json({
      communities: q.rows.map(c => ({
        communityId: c.community_id,
        label: c.label,
        summary: c.summary || '',
        color: c.color,
        size: c.size,
        topNodes: Array.isArray(c.top_nodes) ? c.top_nodes : [],
        summarizedAt: c.summarized_at,
        updatedAt: c.updated_at
      }))
    });
  } catch (err) {
    console.error('Communities list error:', err);
    res.status(500).json({ error: 'Failed to load communities' });
  }
});

// ── POST /api/knowledge/communities/detect — re-cluster now ─
router.post('/communities/detect', requireAuth, async (req, res) => {
  try {
    const { detectCommunities } = require('../services/cognitive/Communities');
    const result = await detectCommunities({
      minSize: Math.max(2, parseInt(req.body?.minSize) || 3),
      name: req.body?.name !== false
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Community detection error:', err);
    res.status(500).json({ error: 'Community detection failed', details: err.message });
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

// ═══════════════════════════════════════════════════════════
// Sprint Y — Knowledge Center aggregation
// ═══════════════════════════════════════════════════════════

// Scalar count that never throws — a missing table/column returns null so one
// absent store can't 500 the whole dashboard.
async function safeScalar(sql, params = []) {
  try {
    const r = await query(sql, params);
    const v = r.rows[0] ? Object.values(r.rows[0])[0] : null;
    return v == null ? null : Number(v);
  } catch (err) {
    return null;
  }
}

// ── GET /api/knowledge/memory/overview ─────────────────────
// One number + honest status per memory store, for the taxonomy quadrant.
// Every store below is REAL and already wired; status reflects whether it
// currently holds data, not whether the feature exists.
router.get('/memory/overview', requireAuth, async (req, res) => {
  try {
    const [
      graphNodes, graphEdges, graphEvents,
      episodicExec, episodicMem,
      procedural, recipes,
      semantic, knowledgeDocs, embeddings, reflections
    ] = await Promise.all([
      safeScalar(`SELECT COUNT(*) FROM entities WHERE status = 'active'`),
      safeScalar(`SELECT COUNT(*) FROM entity_edges`),
      safeScalar(`SELECT COUNT(*) FROM node_events`),
      safeScalar(`SELECT COUNT(*) FROM executions WHERE current_state = 'completed'`),
      safeScalar(`SELECT COUNT(*) FROM memories WHERE memory_type = 'episodic'`),
      safeScalar(`SELECT COUNT(*) FROM memories WHERE memory_type = 'procedural'`),
      safeScalar(`SELECT COUNT(*) FROM skill_recipes`),
      safeScalar(`SELECT COUNT(*) FROM memories WHERE memory_type = 'semantic'`),
      safeScalar(`SELECT COUNT(*) FROM knowledge`),
      safeScalar(`SELECT COUNT(*) FROM knowledge_embeddings`),
      safeScalar(`SELECT COUNT(*) FROM reflections`)
    ]);

    const status = (n) => (n == null ? 'roadmap' : n > 0 ? 'live' : 'instrumented');
    const num = (n) => (n == null ? 0 : n);

    res.json({
      stores: [
        {
          key: 'semantic_graph', label: 'Semantic — Knowledge Graph', icon: 'hub',
          primary: num(graphNodes), unit: 'concepts',
          detail: { nodes: num(graphNodes), edges: num(graphEdges), events: num(graphEvents) },
          status: status(graphNodes),
          blurb: 'Living concepts and the reasoned links between them.'
        },
        {
          key: 'episodic', label: 'Episodic — Experiences', icon: 'history',
          primary: num(episodicExec) + num(episodicMem), unit: 'episodes',
          detail: { completedExecutions: num(episodicExec), episodicMemories: num(episodicMem) },
          status: status((num(episodicExec) + num(episodicMem)) || null),
          blurb: 'What happened and when — past executions and recalled events.'
        },
        {
          key: 'procedural', label: 'Procedural — Know-how', icon: 'construction',
          primary: num(procedural) + num(recipes), unit: 'procedures',
          detail: { proceduralMemories: num(procedural), skillRecipes: num(recipes) },
          status: status((num(procedural) + num(recipes)) || null),
          blurb: 'Reusable workflows and skill recipes distilled from success.'
        },
        {
          key: 'rag', label: 'RAG — Vector Recall', icon: 'search',
          primary: num(embeddings), unit: 'embedded chunks',
          detail: { documents: num(knowledgeDocs), embeddings: num(embeddings), semanticMemories: num(semantic) },
          status: status(embeddings),
          blurb: 'Documents embedded (768-dim) for cosine-similarity retrieval.'
        },
        {
          key: 'reflective', label: 'Reflective — Learnings', icon: 'lightbulb',
          primary: num(reflections), unit: 'reflections',
          detail: { reflections: num(reflections) },
          status: status(reflections),
          blurb: 'Post-execution learnings the system wrote about itself.'
        }
      ]
    });
  } catch (err) {
    console.error('Memory overview error:', err);
    res.status(500).json({ error: 'Failed to load memory overview' });
  }
});

// ── GET /api/knowledge/stats/growth?days=30 ────────────────
// Daily new-learning counts from node_events → the growth sparkline.
router.get('/stats/growth', requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days) || 30));
    const q = await query(`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             COALESCE(c.created, 0)::int   AS created,
             COALESCE(c.activated, 0)::int AS activated,
             COALESCE(c.total, 0)::int     AS total
      FROM generate_series(
             (now() - ($1 || ' days')::interval)::date, now()::date, interval '1 day'
           ) AS d(day)
      LEFT JOIN (
        SELECT date_trunc('day', created_at)::date AS day,
               COUNT(*) FILTER (WHERE event_type = 'created')   AS created,
               COUNT(*) FILTER (WHERE event_type = 'activated') AS activated,
               COUNT(*) AS total
        FROM node_events
        WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY 1
      ) c ON c.day = d.day
      ORDER BY d.day
    `, [String(days)]);
    res.json({ days, series: q.rows });
  } catch (err) {
    console.error('Growth stats error:', err);
    res.status(500).json({ error: 'Failed to load growth' });
  }
});

// ── GET /api/knowledge/agents/overview ─────────────────────
// Per-agent learning footprint — how much each agent knows and how active it is.
router.get('/agents/overview', requireAuth, async (req, res) => {
  try {
    const q = await query(`
      SELECT owner_agent AS agent_id,
             COUNT(*)::int                       AS node_count,
             COALESCE(SUM(activation_count), 0)::int AS activations,
             ROUND(AVG(importance)::numeric, 1)  AS avg_importance,
             MAX(last_activated_at)              AS last_active
      FROM entities
      WHERE status = 'active' AND owner_agent IS NOT NULL
      GROUP BY owner_agent
      ORDER BY node_count DESC
      LIMIT 20
    `);
    // Top concept per agent (best-effort, one extra query per agent is fine at ≤20).
    const agents = [];
    for (const row of q.rows) {
      const topQ = await query(`
        SELECT canonical_name FROM entities
        WHERE owner_agent = $1 AND status = 'active'
        ORDER BY activation_count DESC, importance DESC LIMIT 3
      `, [row.agent_id]);
      agents.push({ ...row, topConcepts: topQ.rows.map(r => r.canonical_name) });
    }
    const totalNodes = agents.reduce((s, a) => s + a.node_count, 0) || 1;
    agents.forEach(a => { a.share = Math.round((a.node_count / totalNodes) * 100); });
    res.json({ agents, totalNodes });
  } catch (err) {
    console.error('Agents overview error:', err);
    res.status(500).json({ error: 'Failed to load agents overview' });
  }
});

// ── GET /api/knowledge/inference/stats?days=7 ──────────────
// Tokens, latency and per-feature breakdown — the honest inference/cost panel.
router.get('/inference/stats', requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days) || 7));
    const [totals, byFeature, byProvider] = await Promise.all([
      query(`
        SELECT COUNT(*)::int AS calls,
               COALESCE(SUM(prompt_tokens), 0)::bigint     AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
               COALESCE(ROUND(AVG(latency_ms)), 0)::int    AS avg_latency_ms,
               COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms
        FROM inference_metrics WHERE created_at > now() - ($1 || ' days')::interval
      `, [String(days)]),
      query(`
        SELECT feature, COUNT(*)::int AS calls,
               COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS tokens
        FROM inference_metrics WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY feature ORDER BY tokens DESC
      `, [String(days)]),
      query(`
        SELECT provider, COUNT(*)::int AS calls
        FROM inference_metrics WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY provider ORDER BY calls DESC
      `, [String(days)])
    ]);
    res.json({
      days,
      totals: totals.rows[0],
      byFeature: byFeature.rows,
      byProvider: byProvider.rows
    });
  } catch (err) {
    console.error('Inference stats error:', err);
    res.status(500).json({ error: 'Failed to load inference stats' });
  }
});

// ── GET /api/knowledge/patterns ────────────────────────────
// "What the system thinks you care about" — strongest user-scoped preferences.
router.get('/patterns', requireAuth, async (req, res) => {
  try {
    const q = await query(`
      SELECT f.canonical_name AS from_name, t.canonical_name AS to_name,
             t.entity_type AS to_type, e.strength, e.weight, e.reason
      FROM entity_edges e
      JOIN entities f ON f.entity_id = e.from_entity_id
      JOIN entities t ON t.entity_id = e.to_entity_id
      WHERE e.edge_type = 'prefers' AND e.user_id = $1
        AND f.status = 'active' AND t.status = 'active'
      ORDER BY e.strength DESC, e.weight DESC
      LIMIT 15
    `, [req.user.id]);
    res.json({ patterns: q.rows });
  } catch (err) {
    console.error('Patterns error:', err);
    res.status(500).json({ error: 'Failed to load patterns' });
  }
});

module.exports = router;
