// services/cognitive/EntityGraph.js — Sprint 5C · Graph-RAG
// Extracts entities from execution goal/result text, upserts them as graph nodes,
// and creates typed edges. On retrieval, does a one-hop graph walk from anchor
// entities in the current query to surface related context.

const { query } = require('../../database');
const { runInference } = require('../inference');

const EXTRACT_PROMPT = `Extract named entities from the text. Focus on:
- ticker: stock symbols (TSLA, AAPL, GOOGL) or crypto symbols (BTC, ETH, SOL)
- technology: languages/frameworks/protocols (Rust, React, Solana, IPFS)
- company: named organizations (OpenAI, Anthropic)
- topic: named domains/fields (neuroscience, DeFi, quantum computing)
- preference: user-stated preferences ("I prefer async", "loves TypeScript")
- project: named user projects

Respond ONLY with JSON: {"entities": [{"name": "<canonical name>", "type": "<one of the types above>"}]}
Skip generic words. At most 8 entities. Return {"entities": []} if none.`;

/**
 * Best-effort LLM entity extraction. Returns [] on any failure.
 */
async function extractEntities(text) {
  if (!text || text.length < 10) return [];
  try {
    const res = await runInference({
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: text.slice(0, 4000) }
      ],
      temperature: 0.1,
      jsonMode: true
    });
    let cleaned = (res.content || '').trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.entities)) return [];
    return parsed.entities
      .filter(e => e && typeof e.name === 'string' && typeof e.type === 'string')
      .map(e => ({ name: e.name.trim(), type: e.type.trim().toLowerCase() }))
      .filter(e => e.name.length > 0 && e.name.length < 80);
  } catch (err) {
    console.warn(`⚠️ EntityGraph.extractEntities failed: ${err.message}`);
    return [];
  }
}

/**
 * Upsert an entity node. Bumps mention_count + last_seen_at on repeat.
 * Returns the entity_id (existing or new).
 */
async function upsertEntity({ name, type }) {
  const canonical = name.trim();
  const t = (type || 'topic').toLowerCase();
  const id = `ent_${t}_${canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;

  await query(`
    INSERT INTO entities (entity_id, canonical_name, entity_type, mention_count, last_seen_at)
    VALUES ($1, $2, $3, 1, now())
    ON CONFLICT (canonical_name, entity_type) DO UPDATE
      SET mention_count = entities.mention_count + 1,
          last_seen_at = now()
    RETURNING entity_id
  `, [id, canonical, t]);

  // The RETURNING above is the inserted row — but ON CONFLICT DO UPDATE returns the updated row,
  // and we can't rely on the id we constructed matching an older row's id. Re-read to be safe.
  const r = await query(
    `SELECT entity_id FROM entities WHERE canonical_name = $1 AND entity_type = $2`,
    [canonical, t]
  );
  return r.rows[0]?.entity_id || id;
}

/**
 * Add or strengthen a typed edge between two entities.
 */
async function upsertEdge({ fromId, toId, edgeType, userId = null, executionId = null }) {
  if (!fromId || !toId || fromId === toId) return;
  await query(`
    INSERT INTO entity_edges (from_entity_id, to_entity_id, edge_type, weight, user_id, context_execution_id, updated_at)
    VALUES ($1, $2, $3, 1, $4, $5, now())
    ON CONFLICT (from_entity_id, to_entity_id, edge_type, user_id) DO UPDATE
      SET weight = entity_edges.weight + 1,
          context_execution_id = EXCLUDED.context_execution_id,
          updated_at = now()
  `, [fromId, toId, edgeType, userId, executionId]);
}

/**
 * Ingest an execution: extract entities from goal+result, upsert them,
 * and link them with co_mentioned edges. Returns list of entity ids created/touched.
 */
async function ingestExecution(execution) {
  const text = `${execution.goal || ''}\n\n${execution.result || ''}`.trim();
  const raw = await extractEntities(text);
  if (raw.length === 0) return [];

  const ids = [];
  for (const e of raw) {
    try {
      const id = await upsertEntity(e);
      if (id) ids.push(id);
    } catch (err) {
      console.warn(`⚠️ EntityGraph upsertEntity failed for "${e.name}": ${err.message}`);
    }
  }

  // Co-mentioned edges across all pairs surfaced together
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      try {
        await upsertEdge({
          fromId: ids[i], toId: ids[j],
          edgeType: 'co_mentioned',
          userId: null,
          executionId: execution.execution_id
        });
        await upsertEdge({
          fromId: ids[j], toId: ids[i],
          edgeType: 'co_mentioned',
          userId: null,
          executionId: execution.execution_id
        });
      } catch (err) {
        console.warn(`⚠️ EntityGraph upsertEdge failed: ${err.message}`);
      }
    }
  }

  return ids;
}

/**
 * Given text (typically a fresh goal), find anchor entities present in text and
 * do a one-hop graph walk to return related entities plus co-occurrence weight.
 * Returns [{name, type, viaEdge, weight}], sorted by weight desc.
 */
async function findRelatedForText(text, limit = 8) {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Grab entities whose canonical_name appears in the text (fast substring match)
  const anchors = await query(`
    SELECT entity_id, canonical_name, entity_type
    FROM entities
    WHERE $1 ILIKE '%' || canonical_name || '%'
    ORDER BY mention_count DESC
    LIMIT 6
  `, [text]);
  if (anchors.rows.length === 0) return [];

  const anchorIds = anchors.rows.map(r => r.entity_id);
  const placeholders = anchorIds.map((_, i) => `$${i + 1}`).join(',');
  const related = await query(`
    SELECT e.canonical_name, e.entity_type, edge.edge_type AS via, SUM(edge.weight)::int AS weight
    FROM entity_edges edge
    JOIN entities e ON e.entity_id = edge.to_entity_id
    WHERE edge.from_entity_id IN (${placeholders})
      AND edge.to_entity_id NOT IN (${placeholders})
    GROUP BY e.canonical_name, e.entity_type, edge.edge_type
    ORDER BY weight DESC
    LIMIT ${Math.max(1, Math.min(20, limit))}
  `, anchorIds);

  return related.rows.map(r => ({
    name: r.canonical_name,
    type: r.entity_type,
    viaEdge: r.via,
    weight: r.weight
  }));
}

module.exports = {
  extractEntities,
  upsertEntity,
  upsertEdge,
  ingestExecution,
  findRelatedForText
};
