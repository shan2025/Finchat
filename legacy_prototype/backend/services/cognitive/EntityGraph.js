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
 *
 * Fix 5: ON CONFLICT targets entity_id (PK) to handle the race where two
 * concurrent chats generate the same deterministic id. A secondary catch
 * handles the (canonical_name, entity_type) unique constraint if a different
 * id was previously generated for the same name+type, by re-reading.
 */
async function upsertEntity({ name, type, userId = null }) {
  const canonical = name.trim();
  const t = (type || 'topic').toLowerCase();
  // The id MUST include the owner. It used to be derived from name+type alone, so
  // two users mentioning "Bitcoin" produced the same entity_id and collided on the
  // primary key — one shared node for everyone, which is how the graph (and the
  // neural map derived from it) ended up identical across accounts.
  const ownerTag = userId ? String(userId).replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24) : 'anon';
  const id = `ent_${ownerTag}_${t}_${canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await query(`
        INSERT INTO entities (entity_id, canonical_name, entity_type, user_id, mention_count, last_seen_at)
        VALUES ($1, $2, $3, $4, 1, now())
        ON CONFLICT (entity_id) DO UPDATE
          SET mention_count = entities.mention_count + 1,
              last_seen_at = now()
      `, [id, canonical, t, userId]);

      return id; // success — the id we generated is the row's id
    } catch (err) {
      // Unique violation on (user_id, canonical_name, entity_type): this user already
      // has the node under a different id (e.g. one created before ids were scoped).
      // Re-read THEIR row — never another user's.
      if (err.message && err.message.includes('duplicate key') && attempt === 0) {
        const r = await query(
          `SELECT entity_id FROM entities
            WHERE canonical_name = $1 AND entity_type = $2 AND user_id IS NOT DISTINCT FROM $3`,
          [canonical, t, userId]
        );
        if (r.rows[0]?.entity_id) {
          // Bump its mention count while we're here
          await query(
            `UPDATE entities SET mention_count = mention_count + 1, last_seen_at = now() WHERE entity_id = $1`,
            [r.rows[0].entity_id]
          ).catch(() => {});
          return r.rows[0].entity_id;
        }
        continue; // retry the insert (row may have been deleted between calls)
      }
      throw err; // non-duplicate error — let it propagate
    }
  }

  // Fallback: re-read whatever is there for THIS user
  const r = await query(
    `SELECT entity_id FROM entities
      WHERE canonical_name = $1 AND entity_type = $2 AND user_id IS NOT DISTINCT FROM $3`,
    [canonical, t, userId]
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

  // The execution knows who it belongs to; everything it produces is theirs.
  const userId = execution.user_id || execution.userId || null;

  const ids = [];
  for (const e of raw) {
    try {
      const id = await upsertEntity({ ...e, userId });
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
          userId, // was hardcoded null — that is why 4,632 of 4,646 edges had no owner
          executionId: execution.execution_id
        });
        await upsertEdge({
          fromId: ids[j], toId: ids[i],
          edgeType: 'co_mentioned',
          userId, // was hardcoded null — that is why 4,632 of 4,646 edges had no owner
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
 * Given text (typically a fresh goal), find anchor entities in text and do a
 * 2-hop weighted walk using edge strength×confidence scores. Agent-owned nodes
 * receive a 1.5× boost so specialists surface their domain first.
 *
 * @param {string}  text      - Goal / query text
 * @param {number}  limit     - Max neighbor results (anchors always included)
 * @param {string|null} agentName - Current agent id; owned nodes are boosted
 * @param {string|null} userId    - Owner scope. Only this user's graph is walked;
 *                                  without it an agent could recall another user's
 *                                  topics as if they were this user's memory.
 * Returns [{entity_id, name, type, viaEdge, weight}], anchors first.
 */
async function findRelatedForText(text, limit = 8, agentName = null, userId = null) {
  if (!text) return [];

  const anchors = await query(`
    SELECT entity_id, canonical_name, entity_type
    FROM entities
    WHERE $1 ILIKE '%' || canonical_name || '%'
      AND status = 'active'
      AND user_id IS NOT DISTINCT FROM $2
    ORDER BY mention_count DESC
    LIMIT 6
  `, [text, userId]);
  if (anchors.rows.length === 0) return [];

  const anchorIds = anchors.rows.map(r => r.entity_id);
  const N = anchorIds.length;
  // Params: $1..$N = anchorIds, $N+1 = agentName, $N+2 = limit, $N+3 = userId
  const inList  = anchorIds.map((_, i) => `$${i + 1}`).join(',');
  const agentP  = `$${N + 1}`;
  const limitP  = `$${N + 2}`;
  const userP   = `$${N + 3}`;
  const params  = [...anchorIds, agentName, Math.max(1, Math.min(20, limit)), userId];

  // 2-hop CTE:
  //   hop1 score = strength × confidence × weight  (falls back gracefully when
  //                living columns are NULL — pre-engine edges have no strength yet)
  //   hop2 score = hop1.score × same product along the second edge
  //   agent boost = ×1.5 when the node is owned by the current agent
  //   GROUP BY de-dupes nodes reachable via multiple paths and sums their scores
  const related = await query(`
    WITH hop1 AS (
      SELECT e.entity_id, e.canonical_name, e.entity_type, ee.edge_type AS via,
             COALESCE(ee.strength, 0.3) * COALESCE(ee.confidence, 0.5) * GREATEST(COALESCE(ee.weight, 1), 1) AS score,
             CASE WHEN e.owner_agent = ${agentP} AND ${agentP} IS NOT NULL THEN 1.5 ELSE 1.0 END AS boost
      FROM entity_edges ee
      JOIN entities e ON e.entity_id = ee.to_entity_id
      WHERE ee.from_entity_id IN (${inList})
        AND ee.to_entity_id   NOT IN (${inList})
        AND e.status = 'active'
        AND e.user_id IS NOT DISTINCT FROM ${userP}
    ),
    hop2 AS (
      SELECT e.entity_id, e.canonical_name, e.entity_type, ee2.edge_type AS via,
             h1.score * COALESCE(ee2.strength, 0.3) * COALESCE(ee2.confidence, 0.5) * GREATEST(COALESCE(ee2.weight, 1), 1) AS score,
             CASE WHEN e.owner_agent = ${agentP} AND ${agentP} IS NOT NULL THEN 1.5 ELSE 1.0 END AS boost
      FROM hop1 h1
      JOIN entity_edges ee2 ON ee2.from_entity_id = h1.entity_id
      JOIN entities e ON e.entity_id = ee2.to_entity_id
      WHERE ee2.to_entity_id NOT IN (${inList})
        AND e.status = 'active'
        AND e.user_id IS NOT DISTINCT FROM ${userP}
    ),
    ranked AS (
      SELECT entity_id, canonical_name, entity_type, via,
             SUM(score * boost) AS total_score
      FROM (
        SELECT entity_id, canonical_name, entity_type, via, score, boost FROM hop1
        UNION ALL
        SELECT entity_id, canonical_name, entity_type, via, score, boost FROM hop2
      ) t
      GROUP BY entity_id, canonical_name, entity_type, via
    )
    SELECT entity_id, canonical_name, entity_type, via, total_score
    FROM ranked
    ORDER BY total_score DESC
    LIMIT ${limitP}
  `, params);

  // Anchors first (concepts named in the text), then scored neighbors.
  // entity_id rides along so retrieval can *activate* these nodes.
  return [
    ...anchors.rows.map(r => ({
      entity_id: r.entity_id,
      name: r.canonical_name,
      type: r.entity_type,
      viaEdge: 'anchor',
      weight: 99
    })),
    ...related.rows.map(r => ({
      entity_id: r.entity_id,
      name: r.canonical_name,
      type: r.entity_type,
      viaEdge: r.via,
      weight: parseFloat(r.total_score) || 0
    }))
  ];
}

module.exports = {
  extractEntities,
  upsertEntity,
  upsertEdge,
  ingestExecution,
  findRelatedForText
};
