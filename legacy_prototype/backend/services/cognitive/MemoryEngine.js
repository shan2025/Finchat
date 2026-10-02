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
const { query, getPool } = require('../../database');
const { runInference } = require('../inference');
const { eventBus } = require('./EventBus');

const ENTITY_TYPES = ['ticker', 'technology', 'company', 'person', 'topic', 'preference', 'project', 'document'];
const RELATION_TYPES = ['related_to', 'part_of', 'uses', 'prefers', 'works_on', 'causes', 'instance_of', 'compares_to', 'co_mentioned'];
const PREFERENCE_KINDS = ['style', 'format', 'depth', 'topic', 'tool', 'constraint'];

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
     "strength": <0-1>,
     "valid_from": "<YYYY-MM-DD if the exchange says when this became true, else null>"}
  ],
  "superseded": [
    {"fact": "<id from KNOWN FACTS, e.g. F2>",
     "reason": "<one sentence: what in this exchange shows it is no longer true>",
     "ended": "<YYYY-MM-DD if the exchange says when it stopped being true, else null>"}
  ],
  "contradictions": [
    {"statement": "<claim made in this exchange>",
     "conflicts_with": "<the earlier/known fact it contradicts>",
     "explanation": "<one sentence>"}
  ],
  "preferences": [
    {"label": "<3-6 word name for the preference, e.g. 'Child-level explanations'>",
     "instruction": "<how the assistant should behave from now on, as one imperative sentence>",
     "kind": "<style|format|depth|topic|tool|constraint>",
     "evidence": "<the user's own words that show it>",
     "confidence": <0-1>}
  ]
}

Rules: at most 6 entities and 8 relations. Skip greetings, small talk and generic words.
"contradictions" is usually empty.

PREFERENCES — read the USER's words only, never the assistant's:
- Capture how this user wants to be answered, not what the answer was about.
- Anything the user asks for about the FORM of a reply is a preference worth keeping:
  "explain it like I'm a child", "in a way a child can understand", "keep it short",
  "no jargon", "give me bullet points", "always cite sources", "answer in Arabic",
  "stop using emojis", "show the numbers first".
- Also capture standing interests and constraints: "I only care about crypto, not stocks",
  "I'm a beginner", "I invest long-term", "never recommend penny stocks".
- Treat these as durable even when phrased about the current message — the user is
  telling you how they like to be taught.
- Do NOT invent preferences. If the user only asked a factual question, return [].

SUPERSEDED — facts change over time. The input may list KNOWN FACTS already
remembered about this user, each with an id. Put a fact in "superseded" ONLY
when this exchange plainly says it is no longer true: the user sold the stock,
changed jobs, dropped a project, or now wants answers a different way
("actually, give me more detail" ends "keep answers short"). A question, a
doubt, or a new fact that can sit beside the old one does NOT end it. When a
preference is replaced, also return the new one under "preferences".
Usually "superseded" is empty.

Return {"entities":[],"relations":[],"contradictions":[],"preferences":[],"superseded":[]} if nothing significant.`;

/**
 * A stated date, or null. Dates the model invents for "now" are fine; dates in
 * the future, or before anyone here could have held a position, are not facts.
 */
function parseFactDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < 1990 || d.getTime() > Date.now() + 86400000) return null;
  return d.toISOString();
}

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

/**
 * LLM pass over one exchange. Returns {entities, relations, contradictions,
 * preferences, superseded}; empty on failure.
 *
 * @param {Array<{label: string, text: string}>} [opts.knownFacts] - current
 *   facts the exchange may end; `superseded` only ever names these labels.
 */
async function extractFromExchange(userText, aiText, { userId = null, agentId = null, knownFacts = [] } = {}) {
  const empty = { entities: [], relations: [], contradictions: [], preferences: [], superseded: [] };
  const exchange = `USER: ${(userText || '').slice(0, 2500)}\n\nASSISTANT: ${(aiText || '').slice(0, 2500)}`;
  if (exchange.length < 30) return empty;
  const text = knownFacts.length
    ? `KNOWN FACTS (still believed true):\n${knownFacts.map(f => `${f.label}: ${f.text}`).join('\n')}\n\n${exchange}`
    : exchange;
  try {
    const res = await runInference({
      messages: [
        { role: 'system', content: INGEST_PROMPT },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      jsonMode: true,
      // Learning about a user is work done for that user — attribute it, or the
      // Knowledge Center reports it against nobody.
      feature: 'extraction',
      userId,
      agentId
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
        strength: clamp(r.strength, 0, 1, 0.5),
        validFrom: parseFactDate(r.valid_from)
      }));
    const contradictions = (Array.isArray(parsed.contradictions) ? parsed.contradictions : [])
      .filter(c => c && typeof c.statement === 'string' && c.statement.trim())
      .slice(0, 3);
    const preferences = (Array.isArray(parsed.preferences) ? parsed.preferences : [])
      .filter(p => p && typeof p.instruction === 'string' && p.instruction.trim().length > 3)
      .slice(0, 4)
      .map(p => ({
        label: (typeof p.label === 'string' && p.label.trim() ? p.label : p.instruction).trim().slice(0, 60),
        instruction: p.instruction.trim().slice(0, 240),
        kind: PREFERENCE_KINDS.includes(String(p.kind || '').toLowerCase()) ? String(p.kind).toLowerCase() : 'style',
        evidence: typeof p.evidence === 'string' ? p.evidence.trim().slice(0, 200) : '',
        confidence: clamp(p.confidence, 0, 1, 0.7)
      }));
    // Only labels we handed over count — the model cannot close a fact by
    // naming one it was never shown.
    const shown = new Set(knownFacts.map(f => f.label));
    const superseded = (Array.isArray(parsed.superseded) ? parsed.superseded : [])
      .filter(s => s && typeof s.fact === 'string' && shown.has(s.fact.trim()))
      .slice(0, 4)
      .map(s => ({
        fact: s.fact.trim(),
        reason: typeof s.reason === 'string' ? s.reason.trim().slice(0, 300) : '',
        endedAt: parseFactDate(s.ended)
      }));
    return { entities, relations, contradictions, preferences, superseded };
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
async function findExisting(name, userId = null) {
  const r = await query(`
    SELECT entity_id, canonical_name, entity_type, summary, importance, confidence
    FROM entities
    WHERE status = 'active'
      AND (LOWER(canonical_name) = LOWER($1) OR aliases @> to_jsonb(ARRAY[LOWER($1)]))
      AND user_id IS NOT DISTINCT FROM $2
    ORDER BY mention_count DESC
    LIMIT 1
  `, [name.trim(), userId]);
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
  const userId = ctx.userId || null;
  // Scoped lookup: another user's node with the same name must not be grown here.
  const existing = await findExisting(e.name, userId);
  if (existing) {
    const newSummary = (e.summary && e.summary.length > (existing.summary || '').length) ? e.summary : existing.summary;
    await query(`
      UPDATE entities SET
        mention_count = mention_count + 1,
        last_seen_at = now(),
        -- The vector embeds the summary; a new summary leaves it describing the
        -- old one, so clear it for embedMissingEntities to redo.
        embedding = CASE WHEN summary IS DISTINCT FROM $2 THEN NULL ELSE embedding END,
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
                            summary, importance, confidence, owner_agent, user_id)
      VALUES ($1, $2, $3, 1, now(), $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, canonical_name, entity_type) DO UPDATE
        SET mention_count = entities.mention_count + 1, last_seen_at = now()
    `, [id, e.name, e.type, e.summary || '', e.importance, e.confidence, ctx.agentId || null, userId]);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.upsertLivingEntity insert failed for "${e.name}": ${err.message}`);
    return { entityId: null, isNew: false };
  }
  // Re-read: on a (user,name,type) conflict the surviving id is the old row's.
  const r = await query(
    `SELECT entity_id FROM entities
      WHERE canonical_name = $1 AND entity_type = $2 AND user_id IS NOT DISTINCT FROM $3`,
    [e.name, e.type, userId]);
  const entityId = r.rows[0]?.entity_id || id;
  await recordEvent(entityId, 'created', e.summary || `Learned about ${e.name}.`, ctx);
  return { entityId, isNew: true };
}

/**
 * Add or strengthen a living edge. Manual find-then-update (the table's unique
 * constraint treats NULL user_id rows as distinct, so ON CONFLICT can't be
 * trusted to dedupe them).
 *
 * Only OPEN edges are reinforced. A fact that was closed and is now stated
 * again starts a new interval, so its history reads "true, then not, then
 * true again" instead of the old interval quietly reopening.
 *
 * @param {string|null} [validFrom] - ISO date the fact became true, when the
 *   exchange said so; a new edge otherwise starts now.
 */
async function upsertLivingEdge({ fromId, toId, edgeType, reason = '', strength = 0.5, source = 'chat', agentId = null, userId = null, validFrom = null }) {
  if (!fromId || !toId || fromId === toId) return;
  try {
    // Prefer the row this user already owns, so adopting an ownerless one below
    // can never collide with it on the (from, to, type, user_id) constraint.
    const existing = await query(`
      SELECT edge_id FROM entity_edges
      WHERE from_entity_id = $1 AND to_entity_id = $2 AND edge_type = $3
        AND valid_to IS NULL
      ORDER BY (user_id IS NOT DISTINCT FROM $4) DESC, edge_id LIMIT 1
    `, [fromId, toId, edgeType, userId]);
    if (existing.rows.length > 0) {
      // Ownerless edges written before chat edges carried user_id are adopted
      // the next time the same user reinforces them.
      await query(`
        UPDATE entity_edges SET
          weight = weight + 1,
          strength = LEAST(1.0, GREATEST(strength, $2) + 0.05),
          confidence = LEAST(1.0, confidence + 0.03),
          reason = CASE WHEN $3 <> '' THEN $3 ELSE reason END,
          source = $4, agent_id = COALESCE($5, agent_id), updated_at = now(),
          user_id = COALESCE(user_id, $6)
        WHERE edge_id = $1
      `, [existing.rows[0].edge_id, strength, reason, source, agentId, userId]);
    } else {
      await query(`
        INSERT INTO entity_edges (from_entity_id, to_entity_id, edge_type, weight, user_id,
                                  strength, confidence, reason, source, agent_id, updated_at, valid_from)
        VALUES ($1, $2, $3, 1, $4, $5, 0.7, $6, $7, $8, now(), COALESCE($9::timestamptz, now()))
      `, [fromId, toId, edgeType, userId, strength, reason, source, agentId, validFrom]);
    }
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.upsertLivingEdge failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Temporal facts — edges are true over an interval
// ═══════════════════════════════════════════════════════════

const KNOWN_FACTS_MAX = 12;

/**
 * The user's facts an exchange could end, labelled F1..Fn for the extractor:
 * their standing preferences (always — "actually, more detail please" names
 * no topic) plus the open edges touching nodes named in the text.
 *
 * @returns {Promise<Array<{label: string, edgeId: string, fromId: string, text: string}>>}
 */
async function currentFactsFor(text, userId) {
  if (!userId || userId === 'system') return [];
  try {
    const { findAnchors } = require('./EntityGraph');
    // Lexical anchors only: this runs on every exchange, and a fact the text
    // does not name is one the exchange is unlikely to be ending.
    const anchorIds = (await findAnchors(text, userId)).map(a => a.entity_id);
    const r = await query(`
      SELECT e.edge_id, e.from_entity_id, e.edge_type, e.reason, e.valid_from,
             f.canonical_name AS from_name, t.canonical_name AS to_name,
             (e.edge_type = 'prefers') AS is_pref
      FROM entity_edges e
      JOIN entities f ON f.entity_id = e.from_entity_id AND f.user_id = $1 AND f.status = 'active'
      JOIN entities t ON t.entity_id = e.to_entity_id   AND t.user_id = $1 AND t.status = 'active'
      WHERE e.valid_to IS NULL
        AND e.edge_type <> 'co_mentioned'
        AND (e.edge_type = 'prefers'
             OR e.from_entity_id = ANY($2::text[]) OR e.to_entity_id = ANY($2::text[]))
      ORDER BY is_pref DESC, e.strength DESC, e.updated_at DESC
      LIMIT $3
    `, [userId, anchorIds, KNOWN_FACTS_MAX]);
    return r.rows.map((x, i) => ({
      label: `F${i + 1}`,
      edgeId: String(x.edge_id),
      fromId: x.from_entity_id,
      text: `${x.from_name} --${x.edge_type}--> ${x.to_name}` +
        (x.reason ? `: ${String(x.reason).slice(0, 160)}` : '') +
        (x.valid_from ? ` (since ${new Date(x.valid_from).toISOString().slice(0, 10)})` : '')
    }));
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.currentFactsFor failed: ${err.message}`);
    return [];
  }
}

/**
 * Close a fact: it stays in the graph as history, and recall stops walking it.
 * Never moves valid_to before valid_from, nor into the future.
 *
 * @returns {Promise<boolean>} whether an open edge was closed
 */
async function invalidateEdge(edgeId, { reason = '', endedAt = null, userId = null, ctx = {} } = {}) {
  try {
    const r = await query(`
      UPDATE entity_edges SET
        valid_to = GREATEST(valid_from, LEAST(now(), COALESCE($3::timestamptz, now()))),
        invalidated_at = now(),
        invalidation_reason = $2,
        updated_at = now()
      WHERE edge_id = $1 AND valid_to IS NULL
      RETURNING from_entity_id, to_entity_id, edge_type
    `, [edgeId, reason || '', endedAt]);
    if (!r.rows.length) return false;
    const e = r.rows[0];
    await recordEvent(e.from_entity_id, 'superseded',
      `No longer true (${e.edge_type}): ${reason || 'superseded by a later exchange.'}`, { ...ctx, userId });
    eventBus.emit('graph:fact_superseded', { userId, edgeId: String(edgeId), edgeType: e.edge_type, reason });
    return true;
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.invalidateEdge failed: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// User preferences
// ═══════════════════════════════════════════════════════════
//
// A preference is a `preference` node hanging off the user's own node by a
// `prefers` edge that carries user_id — the shape /api/knowledge/patterns and
// ReportEngine already query. Nothing wrote them reliably before: the generic
// relation extractor had to invent both endpoints, so "explain it like I'm a
// child" was learned as a topic, if at all.

/**
 * The node standing for this user in the graph — the `from` side of every
 * `prefers` edge. Deterministic id, so it is created once and then found.
 */
async function userNode(userId) {
  if (!userId || userId === 'system') return null;
  const entityId = `ent_user_${String(userId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;
  const found = await query(`SELECT entity_id FROM entities WHERE entity_id = $1`, [entityId]);
  if (found.rows.length) return entityId;

  let name = 'You';
  try {
    const u = await query(`SELECT name FROM users WHERE user_id = $1`, [userId]);
    if (u.rows[0]?.name) name = u.rows[0].name;
  } catch (e) { /* users table shape is not this module's business */ }

  try {
    await query(`
      INSERT INTO entities (entity_id, canonical_name, entity_type, mention_count, last_seen_at,
                            summary, importance, confidence, user_id)
      VALUES ($1, $2, 'person', 1, now(), $3, 9, 1.0, $4)
      ON CONFLICT (user_id, canonical_name, entity_type) DO NOTHING
    `, [entityId, name, 'The person this assistant works for.', userId]);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.userNode insert failed: ${err.message}`);
  }
  // A name collision WITHIN this user's own graph means that node is this person.
  // The name match must stay user-scoped: two accounts can share a display name,
  // and matching across users would hand one person's node to another.
  const r = await query(
    `SELECT entity_id FROM entities
      WHERE entity_id = $1
         OR (canonical_name = $2 AND entity_type = 'person' AND user_id IS NOT DISTINCT FROM $3)
      LIMIT 1`,
    [entityId, name, userId]);
  return r.rows[0]?.entity_id || null;
}

/**
 * Persist one learned preference: a `preference` node plus a user-scoped
 * `prefers` edge. Repeating a preference strengthens the edge instead of
 * duplicating it (upsertLivingEdge handles that).
 */
async function recordPreference(pref, ctx = {}) {
  const fromId = await userNode(ctx.userId);
  if (!fromId) return null;
  const { entityId } = await upsertLivingEntity({
    name: pref.label,
    type: 'preference',
    summary: pref.instruction,
    importance: 8,
    confidence: pref.confidence
  }, ctx);
  if (!entityId) return null;

  await upsertLivingEdge({
    fromId, toId: entityId, edgeType: 'prefers',
    // The reason column is what the Knowledge page shows under each pattern,
    // so it carries the actionable instruction, not a description of it.
    reason: pref.instruction,
    strength: Math.max(0.6, pref.confidence),
    source: ctx.sourceType || 'chat',
    agentId: ctx.agentId || null,
    userId: ctx.userId
  });
  await recordEvent(entityId, 'mentioned',
    pref.evidence ? `Preference stated: "${pref.evidence}"` : pref.instruction, ctx);
  return entityId;
}

/**
 * Standing preferences for a user, strongest first — injected into the system
 * prompt so agents actually honour them.
 * @returns {Promise<Array<{label: string, instruction: string, strength: number}>>}
 */
async function getUserPreferences(userId, limit = 8) {
  if (!userId || userId === 'system') return [];
  try {
    const r = await query(`
      SELECT t.canonical_name AS label, COALESCE(NULLIF(e.reason, ''), t.summary) AS instruction,
             e.strength, e.weight
      FROM entity_edges e
      JOIN entities t ON t.entity_id = e.to_entity_id
      WHERE e.edge_type = 'prefers' AND e.user_id = $1 AND t.status = 'active'
        AND e.valid_to IS NULL
      ORDER BY e.strength DESC, e.weight DESC, e.updated_at DESC
      LIMIT $2
    `, [userId, limit]);
    return r.rows.map(x => ({
      label: x.label,
      instruction: x.instruction || x.label,
      strength: Number(x.strength) || 0
    }));
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.getUserPreferences failed: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// The pipeline
// ═══════════════════════════════════════════════════════════

/**
 * Learn from one chat exchange. Fire-and-forget from the chat route.
 * Returns a report { learned, linked, contradictions } for tests/logging.
 */
async function ingestChat({ userId, sessionId, agentId, userText, aiText, sourceLabel = '',
                           sourceType = 'chat', learnPreferences = true }) {
  const report = { learned: [], linked: [], contradictions: [], preferences: [], superseded: [] };
  // Document ingestion reuses this path with the file's text in the user slot;
  // a sentence inside a PDF is not the user telling us how they want answers,
  // nor that something they told us has stopped being true.
  const knownFacts = learnPreferences ? await currentFactsFor(`${userText || ''}\n${aiText || ''}`, userId) : [];
  const extracted = await extractFromExchange(userText, aiText, { userId, agentId, knownFacts });
  if (!learnPreferences) { extracted.preferences = []; extracted.superseded = []; }
  if (extracted.entities.length === 0 && extracted.contradictions.length === 0
      && extracted.preferences.length === 0 && extracted.superseded.length === 0) return report;

  const ctx = { sourceType, sourceId: sessionId || null, agentId: agentId || null, userId: userId || null };

  // Close superseded facts FIRST, so a replacement stated in the same exchange
  // (same nodes, same relation) opens a new interval rather than reinforcing
  // the one being ended.
  const factByLabel = new Map(knownFacts.map(f => [f.label, f]));
  for (const s of extracted.superseded) {
    const fact = factByLabel.get(s.fact);
    if (!fact) continue;
    if (await invalidateEdge(fact.edgeId, { reason: s.reason, endedAt: s.endedAt, userId, ctx })) {
      report.superseded.push({ fact: fact.text, reason: s.reason });
    }
  }

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
    // Scoped: unscoped, this only ever searched the ownerless graph, so a link to
    // a node the user already had was silently dropped.
    if (!fromId) fromId = (await findExisting(r.from, userId || null))?.entity_id;
    if (!toId) toId = (await findExisting(r.to, userId || null))?.entity_id;
    if (!fromId || !toId) continue;
    // Both ends are this user's nodes, so the edge is theirs too. Leaving it
    // ownerless kept it out of per-user consolidation and every edge count.
    await upsertLivingEdge({
      fromId, toId, edgeType: r.type, reason: r.reason, strength: r.strength,
      source: 'chat', agentId: agentId || null,
      userId: userId || null,
      validFrom: r.validFrom
    });
    report.linked.push({ from: r.from, to: r.to, type: r.type });
  }

  // preferences → the user's own node, by a user-scoped `prefers` edge.
  // These drive the "Your patterns" panel AND get replayed into every future
  // system prompt, so learning one is what makes the assistant change how it
  // answers next time.
  for (const p of extracted.preferences) {
    try {
      const entityId = await recordPreference(p, ctx);
      if (entityId) report.preferences.push({ label: p.label, instruction: p.instruction, entityId });
    } catch (err) {
      console.warn(`⚠️ MemoryEngine preference record failed: ${err.message}`);
    }
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

  // New nodes get their vectors in the background — one batched request, and
  // the chat that taught them is not kept waiting on it.
  if (userId && (report.learned.some(l => l.isNew) || report.preferences.length > 0)) {
    require('./EntityGraph').embedMissingEntities(userId).catch(() => { });
  }

  eventBus.emit('memory:ingested', {
    userId, sessionId,
    learned: report.learned.length,
    linked: report.linked.length,
    preferences: report.preferences.length,
    superseded: report.superseded.length
  });
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
        sourceLabel: title || 'Document',
        sourceType: 'document',
        learnPreferences: false
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
    WHERE status = 'active' AND user_id IS NOT DISTINCT FROM $1
    ORDER BY importance DESC, mention_count DESC LIMIT 40
  `, [userId]);
  if (nodes.rows.length < 3) return [];
  const ids = nodes.rows.map(n => n.entity_id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const edges = await query(`
    SELECT f.canonical_name AS from_name, t.canonical_name AS to_name, e.edge_type
    FROM entity_edges e
    JOIN entities f ON f.entity_id = e.from_entity_id
    JOIN entities t ON t.entity_id = e.to_entity_id
    WHERE e.from_entity_id IN (${ph}) AND e.to_entity_id IN (${ph})
      AND e.valid_to IS NULL
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
      jsonMode: true,
      feature: 'gap-detection',
      userId
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
      // Don't re-open a gap that's already open or was dismissed — by THIS user;
      // one person dismissing "Solidity" must not hide it from everyone else.
      const dupe = await query(`
        SELECT 1 FROM graph_insights
        WHERE kind = 'gap' AND LOWER(title) = LOWER($1) AND status IN ('open', 'dismissed')
          AND user_id IS NOT DISTINCT FROM $2 LIMIT 1
      `, [`Missing concept: ${g.concept}`, userId]);
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
async function mergeDuplicates(userId = null) {
  // Grouping must include user_id. Without it this would treat two DIFFERENT
  // users' same-named nodes as duplicates and merge one person's memory into
  // another's — the most destructive form of the cross-user bug.
  const dupes = await query(`
    SELECT LOWER(canonical_name) AS lname, array_agg(entity_id ORDER BY mention_count DESC, created_at ASC) AS ids
    FROM entities WHERE status = 'active' AND ($1::text IS NULL OR user_id = $1)
    GROUP BY user_id, LOWER(canonical_name) HAVING COUNT(*) > 1
  `, [userId]);
  const merged = [];
  for (const row of dupes.rows) {
    const [survivor, ...losers] = row.ids;
    for (const loser of losers) {
      try {
        await mergeEntityPair(survivor, loser);
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
 * Fold the loser's edges of one direction onto the survivor's colliding edge.
 *
 * entity_edges_unique_triple is (from, to, edge_type, user_id), so simply
 * repointing an edge onto the survivor explodes whenever the survivor already
 * connects to the same neighbour with the same relation. Instead: sum the
 * weight, keep the strongest strength/confidence and the latest activation on
 * the survivor's edge, drop the loser's now-redundant row, and only then move
 * whatever is left (which by construction can no longer collide).
 *
 * `dir` is the column being repointed; `other` is the fixed end of the edge.
 * user_id is compared with IS NOT DISTINCT FROM because the constraint treats
 * NULL user_id rows as distinct — matching it exactly is what makes the
 * follow-up UPDATE collision-free.
 */
async function foldEdges(client, dir, survivor, loser) {
  const other = dir === 'from_entity_id' ? 'to_entity_id' : 'from_entity_id';
  await client.query(`
    WITH folded AS (
      UPDATE entity_edges s SET
        weight = s.weight + l.weight,
        strength = LEAST(1.0, GREATEST(s.strength, l.strength)),
        confidence = GREATEST(s.confidence, l.confidence),
        activation_count = s.activation_count + l.activation_count,
        reason = CASE WHEN COALESCE(s.reason, '') <> '' THEN s.reason ELSE l.reason END,
        last_activated_at = GREATEST(s.last_activated_at, l.last_activated_at),
        updated_at = now()
      FROM entity_edges l
      WHERE l.${dir} = $2 AND l.${other} <> $1
        AND s.${dir} = $1 AND s.${other} = l.${other}
        AND s.edge_type = l.edge_type
        AND s.user_id IS NOT DISTINCT FROM l.user_id
        -- Uniqueness covers open edges only, so only two open edges collide.
        -- A closed edge is history of its own interval and moves over as is.
        AND s.valid_to IS NULL AND l.valid_to IS NULL
      RETURNING l.edge_id
    )
    DELETE FROM entity_edges WHERE edge_id IN (SELECT edge_id FROM folded)
  `, [survivor, loser]);
  await client.query(
    `UPDATE entity_edges SET ${dir} = $1, updated_at = now() WHERE ${dir} = $2 AND ${other} <> $1`,
    [survivor, loser]
  );
}

/** Absorb `loser` into `survivor` atomically — edges, events, counters, tombstone. */
async function mergeEntityPair(survivor, loser) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await foldEdges(client, 'from_entity_id', survivor, loser);
    await foldEdges(client, 'to_entity_id', survivor, loser);
    // Anything still touching the loser is a self-loop (loser↔loser or the
    // survivor↔loser edge we just repointed onto itself).
    await client.query(`DELETE FROM entity_edges WHERE from_entity_id = $1 OR to_entity_id = $1`, [loser]);
    await client.query(`DELETE FROM entity_edges WHERE from_entity_id = $1 AND to_entity_id = $1`, [survivor]);
    await client.query(`UPDATE node_events SET entity_id = $1 WHERE entity_id = $2`, [survivor, loser]);
    await client.query(`
      UPDATE entities s SET
        mention_count = s.mention_count + l.mention_count,
        importance = GREATEST(s.importance, l.importance),
        summary = CASE WHEN LENGTH(s.summary) >= LENGTH(l.summary) THEN s.summary ELSE l.summary END,
        aliases = (SELECT to_jsonb(ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(s.aliases || to_jsonb(ARRAY[LOWER(l.canonical_name)])) AS x)))
      FROM entities l WHERE s.entity_id = $1 AND l.entity_id = $2
    `, [survivor, loser]);
    await client.query(`UPDATE entities SET status = 'merged', merged_into = $1 WHERE entity_id = $2`, [survivor, loser]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The graph-wide half of a dream cycle: merge duplicate nodes, fade stale
 * edges, strengthen recently-replayed ones.
 *
 * Split out from dream() so the nightly sweep over every user runs it once
 * rather than once per user — merging is idempotent and an unscoped run is a
 * whole-table sweep, so repeating it per user is pure waste. See
 * dreamAllUsers(), which is the only caller that leaves userId null.
 *
 * Pass a userId for anything a person triggered. "Consolidate now" on the
 * Knowledge page is one user asking to tidy THEIR graph: unscoped, it faded
 * thousands of edges belonging to other accounts and then reported that count
 * back as if it were theirs.
 */
async function consolidateGraph(userId = null) {
  const merged = await mergeDuplicates(userId);

  // Edges untouched for 14+ days slowly fade (never below 0.05 — memories dim, not vanish)
  const decayed = await query(`
    UPDATE entity_edges SET strength = GREATEST(0.05, strength * 0.9)
    WHERE COALESCE(last_activated_at, updated_at) < now() - interval '14 days' AND strength > 0.05
      AND valid_to IS NULL
      AND ($1::text IS NULL OR user_id = $1)
    RETURNING edge_id
  `, [userId]);

  // Edges activated in the last day consolidate (like sleep replay)
  const strengthened = await query(`
    UPDATE entity_edges SET strength = LEAST(1.0, strength + 0.05)
    WHERE last_activated_at > now() - interval '1 day'
      AND valid_to IS NULL
      AND ($1::text IS NULL OR user_id = $1)
    RETURNING edge_id
  `, [userId]);

  return {
    merged,
    edgesDecayed: decayed.rowCount,
    edgesStrengthened: strengthened.rowCount
  };
}

/**
 * One dream cycle: merge duplicates, decay stale edges, strengthen hot ones,
 * hunt for gaps. Returns a report and stores it as a graph_insight.
 *
 * @param {object} opts
 * @param {string} [opts.userId]        - whose graph to report on. Required for the
 *                                        `memory:dream_completed` pulse to be
 *                                        delivered; an ownerless report is not
 *                                        emitted, because it cannot be routed to
 *                                        anyone without broadcasting private
 *                                        entity names to every browser.
 * @param {object} [opts.consolidation] - pre-computed consolidateGraph() result, so a
 *                                        multi-user sweep does the graph-wide work once.
 * @param {boolean} [opts.nameCommunities=true] - spend an LLM call naming each NEW
 *                                        cluster. Clusters keep any label they
 *                                        already had either way; turning this off
 *                                        only means a brand-new cluster is named
 *                                        after its most important member instead.
 *                                        The unattended sweep turns it off — see
 *                                        dreamAllUsers().
 */
async function dream({ userId = null, consolidation = null, nameCommunities = true } = {}) {
  const startedAt = new Date().toISOString();

  const { merged, edgesDecayed, edgesStrengthened } = consolidation || await consolidateGraph(userId);

  const gaps = await detectGaps({ userId });

  // Catch the graph's vectors up: nodes from before vectors were kept, and
  // ones whose summary changed since. Batched, so a sweep is a few requests.
  let embedded = 0;
  if (userId) {
    try {
      embedded = await require('./EntityGraph').embedMissingEntities(userId, 100);
    } catch (err) {
      console.warn(`⚠️ MemoryEngine.dream embedding sweep failed: ${err.message}`);
    }
  }

  // Re-cluster the consolidated graph into named neighborhoods (Stage 4b).
  let communities = [];
  try {
    const { detectCommunities } = require('./Communities');
    const cr = await detectCommunities({ userId, name: nameCommunities });
    communities = cr.communities;
  } catch (err) {
    console.warn(`⚠️ MemoryEngine.dream community detection failed: ${err.message}`);
  }

  const report = {
    // Whose graph was consolidated. `mergedDetail` and `gaps` are entity names
    // lifted straight out of that user's knowledge graph, so the report cannot
    // be broadcast — server.js routes it to this user's sockets alone.
    userId,
    startedAt,
    finishedAt: new Date().toISOString(),
    merged: merged.length,
    mergedDetail: merged.map(m => m.name),
    edgesDecayed,
    edgesStrengthened,
    gapsFound: gaps.length,
    gaps: gaps.map(g => g.concept),
    nodesEmbedded: embedded,
    communities: communities.length,
    communityLabels: communities.map(c => c.label)
  };

  try {
    await query(`
      INSERT INTO graph_insights (insight_id, user_id, kind, title, detail, payload, status)
      VALUES ($1, $2, 'dream_report', $3, $4, $5, 'accepted')
    `, [`ins_${randomUUID().slice(0, 12)}`, userId,
      `Dream cycle: ${merged.length} merged, ${edgesDecayed} faded, ${gaps.length} gaps found`,
      `Consolidation run. Merged ${merged.length} duplicate node(s), decayed ${edgesDecayed} stale edge(s), strengthened ${edgesStrengthened} recent edge(s), surfaced ${gaps.length} knowledge gap(s).`,
      JSON.stringify(report)]);
  } catch (err) {
    console.warn(`⚠️ MemoryEngine dream report insert failed: ${err.message}`);
  }

  // Only an owned report can be delivered. Emitting without a userId would
  // reach nobody (server.js drops ownerless events) and log a warning on every
  // scheduled run, so skip it rather than pretend.
  if (userId) eventBus.emit('memory:dream_completed', report);
  return report;
}

/**
 * The scheduled dream cycle across every user whose graph has changed.
 *
 * Runs the graph-wide consolidation once, then produces a per-user report —
 * gaps and communities are already per-user queries, and the live neural-map
 * pulse can only be delivered to a named owner. Before this, the scheduler
 * called dream({}) once with no owner, which is what made the pulse broadcast
 * one user's entity names to every connected browser.
 *
 * Only graphs touched inside the window are processed. The per-user pass costs
 * a gap query plus a re-clustering each, and this runs every six hours — there
 * is nothing to consolidate in an account that has been dormant for a month,
 * and sweeping it anyway makes the job scale with total signups rather than
 * with activity.
 *
 * Community naming is OFF here. Naming spends one LLM call per new cluster, and
 * a graph carries a dozen or more, so an unattended four-times-a-day sweep was
 * measured burning the whole daily allowance of the primary model on cosmetic
 * labels — starving the chat path, which is what users are actually waiting on.
 * Existing labels survive (community ids are content-addressed, so an unchanged
 * cluster keeps its name), and the on-demand path in routes/knowledge.js still
 * names properly because a human asked for it and is waiting on the answer.
 *
 * @param {object} opts
 * @param {number} [opts.activeWithinDays=7] - how recently a graph must have been touched
 * @returns {Promise<{consolidation, reports: object[]}>}
 */
async function dreamAllUsers({ activeWithinDays = 7 } = {}) {
  const consolidation = await consolidateGraph();

  const owners = await query(`
    SELECT DISTINCT user_id FROM entities
    WHERE user_id IS NOT NULL
      AND status = 'active'
      AND COALESCE(last_activated_at, last_seen_at, created_at) > now() - ($1 || ' days')::interval
  `, [String(activeWithinDays)]);

  const reports = [];
  for (const row of owners.rows) {
    try {
      reports.push(await dream({ userId: row.user_id, consolidation, nameCommunities: false }));
    } catch (err) {
      // One user's graph failing must not abandon the rest of the sweep.
      console.warn(`⚠️ Dream cycle failed for user ${row.user_id}: ${err.message}`);
    }
  }

  console.log(`🌙 Dream cycle: merged ${consolidation.merged.length}, faded ${consolidation.edgesDecayed}, strengthened ${consolidation.edgesStrengthened} across ${reports.length} user graph(s).`);
  return { consolidation, reports };
}

module.exports = {
  extractFromExchange,
  ingestChat,
  ingestDocument,
  recordActivation,
  detectGaps,
  dream,
  dreamAllUsers,
  consolidateGraph,
  findExisting,
  upsertLivingEntity,
  upsertLivingEdge,
  currentFactsFor,
  invalidateEdge,
  parseFactDate,
  userNode,
  recordPreference,
  getUserPreferences
};
