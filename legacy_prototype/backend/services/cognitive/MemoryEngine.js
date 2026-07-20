// services/cognitive/MemoryEngine.js — Sprint X · Cognitive Memory Engine
//
// The learning pipeline that turns conversations into a living knowledge graph:
//
//   chat → extraction → relationship detection → importance scoring →
//   duplicate detection → contradiction detection → merge → graph
//
// Also owns:
//   recordActivation : nodes "light up" when retrieval uses them (heatmap +
//                      thinking-visualization data)
//   detectGaps       : finds missing concepts in graph neighborhoods
//   dream            : offline consolidation — merge duplicates, decay unused
//                      edges, surface gaps (how humans consolidate in sleep)
//
// Every write is best-effort: memory must never break chat.

const { randomUUID } = require('crypto');
const { query } = require('../../database');
const { runInference } = require('../inference');
const { eventBus } = require('./EventBus');

const ENTITY_TYPES = ['ticker', 'technology', 'company', 'person', 'topic', 'preference', 'project', 'document'];
const RELATION_TYPES = ['related_to', 'part_of', 'uses', 'prefers', 'works_on', 'causes', 'instance_of', 'compares_to', 'co_mentioned'];

const INGEST_PROMPT = `You maintain the long-term knowledge graph memory of an AI assistant.
Given one conversation exchange (user message + assistant reply), extract what is worth remembering.

Respond ONLY with JSON:
{
  "entities": [
    {"name": "<canonical name>", "type": "<ticker|technology|company|person|topic|preference|project|document>",
     "summary": "<ONE factual sentence about it, learned from this exchange>",
     "importance": <1-10, how central to the user's interests>,
     "confidence": <0-1, how certain the fact is>}
  ],
  "relations": [
    {"from": "<entity name>", "to": "<entity name>",
     "type": "<related_to|part_of|uses|prefers|works_on|causes|instance_of|compares_to>",
     "reason": "<one short sentence: why this link exists>",
     "strength": <0-1>}
  ],
  "contradictions": [
    {"statement": "<claim made in this exchange>",
     "conflicts_with": "<the earlier/known fact it contradicts>",
     "explanation": "<one sentence>"}
  ]
}

Rules: at most 6 entities and 8 relations. Skip greetings, small talk and generic words.
"contradictions" is usually empty. Return {"entities":[],"relations":[],"contradictions":[]} if nothing significant.`;

function parseJsonLoose(text) {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// ═══════════════════════════════════════════════════════════
// Extraction
// ═══════════════════════════════════════════════════════════

/** LLM pass over one exchange. Returns {entities, relations, contradictions}; empty on failure. */
async function extractFromExchange(userText, aiText) {
  const empty = { entities: [], relations: [], contradictions: [] };
  const text = `USER: ${(userText || '').slice(0, 2500)}\n\nASSISTANT: ${(aiText || '').slice(0, 2500)}`;
  if (text.length < 30) return empty;
  try {
    const res = await runInference({
      messages: [
        { role: 'system', content: INGEST_PROMPT },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      jsonMode: true
    });
    const parsed = parseJsonLoose(res.content);
    const entities = (Array.isArray(parsed.entities) ? parsed.entities : [])
      .filter(e => e && typeof e.name === 'string' && e.name.trim().length > 0 && e.name.length < 80)
      .slice(0, 6)
      .map(e => ({
        name: e.name.trim(),
        type: ENTITY_TYPES.includes(String(e.type || '').toLowerCase()) ? String(e.type).toLowerCase() : 'topic',
        summary: typeof e.summary === 'string' ? e.summary.trim().slice(0, 400) : '',
        importance: clamp(e.importance, 1, 10, 5),
        confidence: clamp(e.confidence, 0, 1, 0.7)
      }));
    const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
      .filter(r => r && typeof r.from === 'string' && typeof r.to === 'string' && r.from !== r.to)
      .slice(0, 8)
      .map(r => ({
        from: r.from.trim(),
        to: r.to.trim(),
        type: RELATION_TYPES.includes(String(r.type || '').toLowerCase()) ? String(r.type).toLowerCase() : 'related_to',
        reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 300) : '',
        strength: clamp(r.strength, 0, 1, 0.5)
      }));
    const contradictions = (Array.isArray(parsed.contradictions) ? parsed.contradictions : [])
      .filter(c => c && typeof c.statement === 'string' && c.statement.trim())
      .slice(0, 3);
    return { entities, relations, contradictions };
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.extractFromExchange failed: ${err.message}`);
    return empty;
  }
}

// ═══════════════════════════════════════════════════════════
// Upserts (duplicate detection + merge live here)
// ═══════════════════════════════════════════════════════════

/**
 * Find an existing ACTIVE entity by case-insensitive canonical name or alias,
 * any type. This is the duplicate gate: "python" (topic) and "Python"
 * (technology) resolve to the same node instead of forking.
 */
async function findExisting(name) {
  const r = await query(`
    SELECT entity_id, canonical_name, entity_type, summary, importance, confidence
    FROM entities
    WHERE status = 'active'
      AND (LOWER(canonical_name) = LOWER($1) OR aliases @> to_jsonb(ARRAY[LOWER($1)]))
    ORDER BY mention_count DESC
    LIMIT 1
  `, [name.trim()]);
  return r.rows[0] || null;
}

async function recordEvent(entityId, eventType, detail, ctx = {}) {
  try {
    await query(`
      INSERT INTO node_events (entity_id, event_type, detail, source_type, source_id, agent_id, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [entityId, eventType, detail || '', ctx.sourceType || null, ctx.sourceId || null, ctx.agentId || null, ctx.userId || null]);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.recordEvent failed: ${err.message}`);
  }
}

async function recordLink(entityId, linkType, linkRef, label) {
  if (!linkRef) return;
  try {
    await query(`
      INSERT INTO entity_links (entity_id, link_type, link_ref, label)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (entity_id, link_type, link_ref) DO UPDATE
        SET count = entity_links.count + 1, last_seen_at = now(), label = EXCLUDED.label
    `, [entityId, linkType, linkRef, label || '']);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.recordLink failed: ${err.message}`);
  }
}

/**
 * Insert a new living node, or grow an existing one: mentions +1, importance
 * ratchets up, confidence blends toward the new observation, a better summary
 * replaces an empty/shorter one. Returns { entityId, isNew }.
 */
async function upsertLivingEntity(e, ctx = {}) {
  const existing = await findExisting(e.name);
  if (existing) {
    const newSummary = (e.summary && e.summary.length > (existing.summary || '').length) ? e.summary : existing.summary;
    await query(`
      UPDATE entities SET
        mention_count = mention_count + 1,
        last_seen_at = now(),
        summary = $2,
        importance = GREATEST(importance, $3),
        confidence = LEAST(1.0, (confidence * 0.7) + ($4 * 0.3) + 0.02),
        owner_agent = COALESCE(owner_agent, $5)
      WHERE entity_id = $1
    `, [existing.entity_id, newSummary || '', e.importance, e.confidence, ctx.agentId || null]);
    await recordEvent(existing.entity_id, 'mentioned', e.summary ? `Learned: ${e.summary}` : 'Mentioned again in conversation.', ctx);
    return { entityId: existing.entity_id, isNew: false };
  }

  const id = `ent_${e.type}_${e.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${randomUUID().slice(0, 6)}`;
  try {
    await query(`
      INSERT INTO entities (entity_id, canonical_name, entity_type, mention_count, last_seen_at,
                            summary, importance, confidence, owner_agent)
      VALUES ($1, $2, $3, 1, now(), $4, $5, $6, $7)
      ON CONFLICT (canonical_name, entity_type) DO UPDATE
        SET mention_count = entities.mention_count + 1, last_seen_at = now()
    `, [id, e.name, e.type, e.summary || '', e.importance, e.confidence, ctx.agentId || null]);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.upsertLivingEntity insert failed for "${e.name}": ${err.message}`);
    return { entityId: null, isNew: false };
  }
  // Re-read: on a (name,type) conflict the surviving id is the old row's.
  const r = await query(`SELECT entity_id FROM entities WHERE canonical_name = $1 AND entity_type = $2`, [e.name, e.type]);
  const entityId = r.rows[0]?.entity_id || id;
  await recordEvent(entityId, 'created', e.summary || `Learned about ${e.name}.`, ctx);
  return { entityId, isNew: true };
}

/**
 * Add or strengthen a living edge. Manual find-then-update (the table's unique
 * constraint treats NULL user_id rows as distinct, so ON CONFLICT can't be
 * trusted to dedupe them).
 */
async function upsertLivingEdge({ fromId, toId, edgeType, reason = '', strength = 0.5, source = 'chat', agentId = null, userId = null }) {
  if (!fromId || !toId || fromId === toId) return;
  try {
    const existing = await query(`
      SELECT edge_id FROM entity_edges
      WHERE from_entity_id = $1 AND to_entity_id = $2 AND edge_type = $3
      ORDER BY edge_id LIMIT 1
    `, [fromId, toId, edgeType]);
    if (existing.rows.length > 0) {
      await query(`
        UPDATE entity_edges SET
          weight = weight + 1,
          strength = LEAST(1.0, GREATEST(strength, $2) + 0.05),
          confidence = LEAST(1.0, confidence + 0.03),
          reason = CASE WHEN $3 <> '' THEN $3 ELSE reason END,
          source = $4, agent_id = COALESCE($5, agent_id), updated_at = now()
        WHERE edge_id = $1
      `, [existing.rows[0].edge_id, strength, reason, source, agentId]);
    } else {
      await query(`
        INSERT INTO entity_edges (from_entity_id, to_entity_id, edge_type, weight, user_id,
                                  strength, confidence, reason, source, agent_id, updated_at)
        VALUES ($1, $2, $3, 1, $4, $5, 0.7, $6, $7, $8, now())
      `, [fromId, toId, edgeType, userId, strength, reason, source, agentId]);
    }
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.upsertLivingEdge failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// The pipeline
// ═══════════════════════════════════════════════════════════

/**
 * Learn from one chat exchange. Fire-and-forget from the chat route.
 * Returns a report { learned, linked, contradictions } for tests/logging.
 */
async function ingestChat({ userId, sessionId, agentId, userText, aiText, sourceLabel = '' }) {
  const report = { learned: [], linked: [], contradictions: [] };
  const extracted = await extractFromExchange(userText, aiText);
  if (extracted.entities.length === 0 && extracted.contradictions.length === 0) return report;

  const ctx = { sourceType: 'chat', sourceId: sessionId || null, agentId: agentId || null, userId: userId || null };

  // entities → nodes (dedup happens inside upsertLivingEntity)
  const idByName = new Map();
  for (const e of extracted.entities) {
    const { entityId, isNew } = await upsertLivingEntity(e, ctx);
    if (!entityId) continue;
    idByName.set(e.name.toLowerCase(), entityId);
    report.learned.push({ name: e.name, entityId, isNew });
    await recordLink(entityId, 'chat_session', sessionId, sourceLabel || 'Chat conversation');
    if (agentId) await recordLink(entityId, 'agent', agentId, `Learned via ${agentId}`);
  }

  // relations → typed, reasoned edges
  for (const r of extracted.relations) {
    let fromId = idByName.get(r.from.toLowerCase());
    let toId = idByName.get(r.to.toLowerCase());
    // A relation may reference an entity already in the graph but not in this exchange's list.
    if (!fromId) fromId = (await findExisting(r.from))?.entity_id;
    if (!toId) toId = (await findExisting(r.to))?.entity_id;
    if (!fromId || !toId) continue;
    await upsertLivingEdge({
      fromId, toId, edgeType: r.type, reason: r.reason, strength: r.strength,
      source: 'chat', agentId: agentId || null,
      userId: r.type === 'prefers' ? (userId || null) : null
    });
    report.linked.push({ from: r.from, to: r.to, type: r.type });
  }

  // contradictions → insights for the user to resolve
  for (const c of extracted.contradictions) {
    try {
      const id = `ins_${randomUUID().slice(0, 12)}`;
      await query(`
        INSERT INTO graph_insights (insight_id, user_id, kind, title, detail, payload)
        VALUES ($1, $2, 'contradiction', $3, $4, $5)
      `, [id, userId || null, `Contradiction: ${String(c.statement).slice(0, 80)}`,
        `"${c.statement}" conflicts with "${c.conflicts_with || 'earlier knowledge'}". ${c.explanation || ''}`.trim(),
        JSON.stringify(c)]);
      report.contradictions.push(c);
    } catch (err) {
      console.warn(`⚠️ MemoryEngine contradiction insert failed: ${err.message}`);
    }
  }

  eventBus.emit('memory:ingested', { userId, sessionId, learned: report.learned.length, linked: report.linked.length });
  return report;
}

/**
 * Ingest an uploaded document (or any raw text block) into the living graph.
 * The text is split into ~1 000-char overlapping chunks; each chunk is treated
 * as a "user turn" with no AI reply so the extractor focuses on raw content.
 *
 * @param {object} opts
 * @param {string} opts.text       - Full document text
 * @param {string} opts.title      - Human-readable document label (stored in provenance)
 * @param {string} [opts.userId]
 * @param {string} [opts.agentId]  - Agent that owns the learned nodes (cortex assignment)
 * @param {string} [opts.docId]    - Stable document ID for deduplication
 * Returns { chunks, learned, linked, contradictions } summary.
 */
async function ingestDocument({ text, title, userId = null, agentId = null, docId = null }) {
  const CHUNK_SIZE  = 1000;
  const CHUNK_STEP  = 750;   // 250-char overlap between chunks
  const fullText    = (text || '').trim();
  if (!fullText) return { chunks: 0, learned: 0, linked: 0, contradictions: 0 };

  const stableDocId = docId || `doc_${randomUUID().slice(0, 12)}`;
  const chunks = [];
  for (let i = 0; i < fullText.length; i += CHUNK_STEP) {
    chunks.push(fullText.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE >= fullText.length) break;
  }

  let totalLearned = 0, totalLinked = 0, totalContradictions = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    try {
      const r = await ingestChat({
        userId, agentId,
        sessionId: stableDocId,
        userText: `[Document: ${title || 'Untitled'}, chunk ${ci + 1}/${chunks.length}]\n\n${chunks[ci]}`,
        aiText: '',
        sourceLabel: title || 'Document'
      });
      totalLearned += r.learned.length;
      totalLinked  += r.linked.length;
      totalContradictions += r.contradictions.length;
    } catch (err) {
      console.warn(`⚠️ MemoryEngine.ingestDocument chunk ${ci} failed: ${err.message}`);
    }
  }

  eventBus.emit('memory:ingested', { userId, docId: stableDocId, title, learned: totalLearned, linked: totalLinked });
  return { chunks: chunks.length, learned: totalLearned, linked: totalLinked, contradictions: totalContradictions, docId: stableDocId };
}

// ═══════════════════════════════════════════════════════════
// Activation — nodes light up when the AI uses them
// ═══════════════════════════════════════════════════════════

/**
 * Record that these nodes were used while answering. Powers the heatmap and
 * the live thinking visualization. Best-effort, cheap (2 queries + 1 insert).
 */
async function recordActivation({ entityIds, userId = null, agentId = null, source = 'retrieval', sourceId = null, detail = '' }) {
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  if (ids.length === 0) return;
  try {
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const updated = await query(`
      UPDATE entities SET activation_count = activation_count + 1, last_activated_at = now()
      WHERE entity_id IN (${ph})
      RETURNING entity_id, canonical_name
    `, ids);
    const values = ids.map((_, i) =>
      `($${i + 1}, 'activated', $${ids.length + 1}, $${ids.length + 2}, $${ids.length + 3}, $${ids.length + 4}, $${ids.length + 5})`).join(',');
    await query(`
      INSERT INTO node_events (entity_id, event_type, detail, source_type, source_id, agent_id, user_id)
      VALUES ${values}
    `, [...ids, detail || 'Used while answering.', source, sourceId, agentId, userId]);
    eventBus.emit('graph:activation', {
      entityIds: ids,
      entities: updated.rows.map(r => ({ entityId: r.entity_id, name: r.canonical_name })),
      agentId, source, sourceId, userId,
      at: new Date().toISOString()
    });
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.recordActivation failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Knowledge gaps (Phase 7)
// ═══════════════════════════════════════════════════════════

const GAP_PROMPT = `You analyze a knowledge graph and point out MISSING concepts.
Given nodes and edges, find up to 3 concepts that clearly should exist between/near
the current nodes but are absent (e.g. graph has CNN and LSTM under Machine Learning
but no "Transformers"; has Ethereum and Smart Contracts but no "Solidity").

Respond ONLY with JSON:
{"gaps": [{"concept": "<missing concept>", "between": ["<node>", "<node>"], "why": "<one sentence>"}]}
Return {"gaps": []} if the graph has no obvious holes.`;

async function detectGaps({ userId = null } = {}) {
  const nodes = await query(`
    SELECT entity_id, canonical_name, entity_type FROM entities
    WHERE status = 'active' ORDER BY importance DESC, mention_count DESC LIMIT 40
  `);
  if (nodes.rows.length < 3) return [];
  const ids = nodes.rows.map(n => n.entity_id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const edges = await query(`
    SELECT f.canonical_name AS from_name, t.canonical_name AS to_name, e.edge_type
    FROM entity_edges e
    JOIN entities f ON f.entity_id = e.from_entity_id
    JOIN entities t ON t.entity_id = e.to_entity_id
    WHERE e.from_entity_id IN (${ph}) AND e.to_entity_id IN (${ph})
    ORDER BY e.strength DESC LIMIT 80
  `, ids);

  const graphText =
    'NODES:\n' + nodes.rows.map(n => `- ${n.canonical_name} (${n.entity_type})`).join('\n') +
    '\n\nEDGES:\n' + edges.rows.map(e => `- ${e.from_name} --${e.edge_type}--> ${e.to_name}`).join('\n');

  let gaps = [];
  try {
    const res = await runInference({
      messages: [
        { role: 'system', content: GAP_PROMPT },
        { role: 'user', content: graphText.slice(0, 6000) }
      ],
      temperature: 0.2,
      jsonMode: true
    });
    const parsed = parseJsonLoose(res.content);
    gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : [])
      .filter(g => g && typeof g.concept === 'string' && g.concept.trim())
      .slice(0, 3);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.detectGaps LLM failed: ${err.message}`);
    return [];
  }

  const saved = [];
  for (const g of gaps) {
    try {
      // Don't re-open a gap that's already open or was dismissed.
      const dupe = await query(`
        SELECT 1 FROM graph_insights
        WHERE kind = 'gap' AND LOWER(title) = LOWER($1) AND status IN ('open', 'dismissed') LIMIT 1
      `, [`Missing concept: ${g.concept}`]);
      if (dupe.rows.length > 0) continue;
      const id = `ins_${randomUUID().slice(0, 12)}`;
      await query(`
        INSERT INTO graph_insights (insight_id, user_id, kind, title, detail, payload)
        VALUES ($1, $2, 'gap', $3, $4, $5)
      `, [id, userId, `Missing concept: ${g.concept}`,
        `${g.why || ''} (near: ${(Array.isArray(g.between) ? g.between : []).join(' ↔ ')})`.trim(),
        JSON.stringify(g)]);
      saved.push({ insightId: id, ...g });
    } catch (err) {
      console.warn(`⚠️ MemoryEngine gap insert failed: ${err.message}`);
    }
  }
  return saved;
}

// ═══════════════════════════════════════════════════════════
// Dream mode (Phase 8) — consolidation while the user is away
// ═══════════════════════════════════════════════════════════

/** Merge duplicate nodes that share a name across types (keeps the most-mentioned). */
async function mergeDuplicates() {
  const dupes = await query(`
    SELECT LOWER(canonical_name) AS lname, array_agg(entity_id ORDER BY mention_count DESC, created_at ASC) AS ids
    FROM entities WHERE status = 'active'
    GROUP BY LOWER(canonical_name) HAVING COUNT(*) > 1
  `);
  const merged = [];
  for (const row of dupes.rows) {
    const [survivor, ...losers] = row.ids;
    for (const loser of losers) {
      try {
        await query(`UPDATE entity_edges SET from_entity_id = $1 WHERE from_entity_id = $2 AND to_entity_id <> $1`, [survivor, loser]);
        await query(`UPDATE entity_edges SET to_entity_id = $1 WHERE to_entity_id = $2 AND from_entity_id <> $1`, [survivor, loser]);
        await query(`DELETE FROM entity_edges WHERE from_entity_id = $1 AND to_entity_id = $1`, [survivor]);
        await query(`UPDATE node_events SET entity_id = $1 WHERE entity_id = $2`, [survivor, loser]);
        await query(`
          UPDATE entities s SET
            mention_count = s.mention_count + l.mention_count,
            importance = GREATEST(s.importance, l.importance),
            summary = CASE WHEN LENGTH(s.summary) >= LENGTH(l.summary) THEN s.summary ELSE l.summary END,
            aliases = (SELECT to_jsonb(ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(s.aliases || to_jsonb(ARRAY[LOWER(l.canonical_name)])) AS x)))
          FROM entities l WHERE s.entity_id = $1 AND l.entity_id = $2
        `, [survivor, loser]);
        await query(`UPDATE entities SET status = 'merged', merged_into = $1 WHERE entity_id = $2`, [survivor, loser]);
        await recordEvent(survivor, 'merged', `Absorbed duplicate node during dream consolidation.`, { sourceType: 'dream' });
        merged.push({ survivor, loser, name: row.lname });
      } catch (err) {
        console.warn(`⚠️ MemoryEngine.mergeDuplicates failed for ${row.lname}: ${err.message}`);
      }
    }
  }
  return merged;
}

/**
 * One dream cycle: merge duplicates, decay stale edges, strengthen hot ones,
 * hunt for gaps. Returns a report and stores it as a graph_insight.
 */
async function dream({ userId = null } = {}) {
  const startedAt = new Date().toISOString();

  const merged = await mergeDuplicates();

  // Edges untouched for 14+ days slowly fade (never below 0.05 — memories dim, not vanish)
  const decayed = await query(`
    UPDATE entity_edges SET strength = GREATEST(0.05, strength * 0.9)
    WHERE COALESCE(last_activated_at, updated_at) < now() - interval '14 days' AND strength > 0.05
    RETURNING edge_id
  `);

  // Edges activated in the last day consolidate (like sleep replay)
  const strengthened = await query(`
    UPDATE entity_edges SET strength = LEAST(1.0, strength + 0.05)
    WHERE last_activated_at > now() - interval '1 day'
    RETURNING edge_id
  `);

  const gaps = await detectGaps({ userId });

  // Re-cluster the consolidated graph into named neighborhoods (Stage 4b).
  let communities = [];
  try {
    const { detectCommunities } = require('./Communities');
    const cr = await detectCommunities({});
    communities = cr.communities;
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.dream community detection failed: ${err.message}`);
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    merged: merged.length,
    mergedDetail: merged.map(m => m.name),
    edgesDecayed: decayed.rowCount,
    edgesStrengthened: strengthened.rowCount,
    gapsFound: gaps.length,
    gaps: gaps.map(g => g.concept),
    communities: communities.length,
    communityLabels: communities.map(c => c.label)
  };

  try {
    await query(`
      INSERT INTO graph_insights (insight_id, user_id, kind, title, detail, payload, status)
      VALUES ($1, $2, 'dream_report', $3, $4, $5, 'accepted')
    `, [`ins_${randomUUID().slice(0, 12)}`, userId,
      `Dream cycle: ${merged.length} merged, ${decayed.rowCount} faded, ${gaps.length} gaps found`,
      `Consolidation run. Merged ${merged.length} duplicate node(s), decayed ${decayed.rowCount} stale edge(s), strengthened ${strengthened.rowCount} recent edge(s), surfaced ${gaps.length} knowledge gap(s).`,
      JSON.stringify(report)]);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine dream report insert failed: ${err.message}`);
  }

  eventBus.emit('memory:dream_completed', report);
  return report;
}

module.exports = {
  extractFromExchange,
  ingestChat,
  ingestDocument,
  recordActivation,
  detectGaps,
  dream,
  findExisting,
  upsertLivingEntity,
  upsertLivingEdge
};
