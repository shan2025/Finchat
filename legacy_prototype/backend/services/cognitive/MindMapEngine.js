// services/cognitive/MindMapEngine.js — Sprint Z · Track A
//
// Generates and grows mind maps. A mind map is a user artifact ("how should I
// understand this topic"), distinct from the Neural Map's derived view of system
// state — see the note at the top of migration 023.
//
// What makes these maps different from every other AI mind-map tool: nodes are
// linked to the living memory graph by entity_id where a match exists, so
// studying a topic ACTIVATES it and it lights up on the neural map heatmap.
// A map generated today already knows what you studied last month.
//
// The generator talks to the LLM directly with jsonMode, NOT through the
// cognitive action schema — so there is no JSON nested inside a JSON string
// here. (Track B learned that the hard way: small models cannot escape it.)

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../database');
const { runInference } = require('../inference');
const { findExisting, recordActivation } = require('./MemoryEngine');

// Shape bounds. A mind map that is just a prettier bullet list is the failure
// mode worth designing against, so breadth and depth are enforced in code and
// not merely requested in the prompt.
const MAX_DEPTH = 4;          // root(1) → branch(2) → leaf(3) → subleaf(4)
const MIN_BRANCHES = 3;
const MAX_BRANCHES = 7;
const MAX_CHILDREN = 6;
const MAX_NODES = 60;

// How much source text a document-backed generation may spend. Split evenly
// across the chosen documents so one 400-page PDF cannot crowd out the other
// four sources the learner deliberately picked.
const DOC_BUDGET = 12000;
const EXPAND_DOC_BUDGET = 5000;

const NODE_TYPES = new Set(['root', 'branch', 'leaf', 'question', 'task']);

const GEN_PROMPT = `You build STUDY MIND MAPS: a hierarchy that shows how a topic is organised.

Respond ONLY with JSON of this exact shape:
{"title":"<3-6 word map title>",
 "root":{"label":"<the topic>","summary":"<one sentence>"},
 "branches":[
   {"label":"<2-4 words>","summary":"<one sentence>",
    "children":[{"label":"<2-4 words>","summary":"<one sentence>","detail":"<2-3 sentences a learner would want>"}]}
 ]}

Rules:
- 4 to 7 branches. Each branch is a genuinely different facet, not a synonym of another.
- 3 to 5 children per branch. A child may itself have "children", but never go deeper than that.
- labels are SHORT noun phrases. Never sentences, never questions unless the node teaches by asking.
- summary is one line shown on the node; detail is the panel body and only belongs on leaves.
- Organise by how the subject actually decomposes, not by "introduction / history / conclusion".
- No markdown, no HTML, no backslashes anywhere.`;

const EXPAND_PROMPT = `You grow ONE branch of an existing study mind map.

Respond ONLY with JSON:
{"children":[{"label":"<2-4 words>","summary":"<one sentence>","detail":"<2-3 sentences>"}]}

Rules:
- 3 to 5 children, all genuinely NEW — never restate the node or its existing children.
- Go one level more specific than the node you are given, not sideways.
- No markdown, no HTML, no backslashes.`;

function parseJsonLoose(text) {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw err;
    return JSON.parse(match[0]);
  }
}

const clean = (v, max = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// ═══════════════════════════════════════════════════════════
// Tree normalisation
// ═══════════════════════════════════════════════════════════

/**
 * Turn whatever the model produced into a bounded, well-typed tree.
 * Enforces the shape rather than trusting it: clamps branch/child counts,
 * caps depth, drops empty labels, and dedupes siblings that repeat a label.
 */
function normalizeTree(raw, fallbackTopic) {
  const rootSrc = (raw && raw.root) || {};
  const root = {
    label: clean(rootSrc.label || raw?.title || fallbackTopic, 120) || clean(fallbackTopic, 120) || 'Untitled',
    summary: clean(rootSrc.summary, 400),
    detail: '',
    nodeType: 'root',
    children: []
  };

  const seen = new Set();
  const branches = Array.isArray(raw?.branches) ? raw.branches : [];

  for (const b of branches.slice(0, MAX_BRANCHES)) {
    const node = normalizeNode(b, 2, seen);
    if (node) root.children.push(node);
  }

  return root;
}

function normalizeNode(src, depth, seen) {
  if (!src || typeof src !== 'object') {
    const label = clean(src, 120);
    return label ? { label, summary: '', detail: '', nodeType: depth >= 3 ? 'leaf' : 'branch', children: [] } : null;
  }

  const label = clean(src.label || src.name || src.title, 120);
  if (!label) return null;

  // Sibling-blind dedupe: the same concept twice in one map is noise wherever
  // it appears, and models repeat themselves across branches.
  const key = label.toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key);

  const kids = [];
  if (depth < MAX_DEPTH) {
    const rawKids = Array.isArray(src.children) ? src.children : [];
    for (const k of rawKids.slice(0, MAX_CHILDREN)) {
      const child = normalizeNode(k, depth + 1, seen);
      if (child) kids.push(child);
    }
  }

  let nodeType = clean(src.nodeType || src.type, 20).toLowerCase();
  if (!NODE_TYPES.has(nodeType) || nodeType === 'root') {
    nodeType = kids.length ? 'branch' : 'leaf';
  }

  return {
    label,
    summary: clean(src.summary, 400),
    detail: clean(src.detail, 1500),
    nodeType,
    children: kids
  };
}

/** Depth-first flatten into insertable rows, assigning ids and parent links. */
function flatten(root, mapId) {
  const rows = [];
  const walk = (node, parentId, order) => {
    if (rows.length >= MAX_NODES) return;
    const id = 'mmn_' + uuidv4();
    rows.push({
      node_id: id,
      map_id: mapId,
      parent_id: parentId,
      label: node.label,
      summary: node.summary,
      detail: node.detail,
      node_type: node.nodeType,
      order_index: order,
      entity_id: null
    });
    node.children.forEach((child, i) => walk(child, id, i));
  };
  walk(root, null, 0);
  return rows;
}

// ═══════════════════════════════════════════════════════════
// Memory-graph bridge
// ═══════════════════════════════════════════════════════════

/**
 * Link nodes to entities that already exist in the user's living graph, and
 * activate them. This is the crossover no competitor has: studying a topic
 * feeds the same memory that answers your chats.
 *
 * Best-effort throughout — a map must still generate when the graph is empty
 * or the DB is degraded (locally, vector columns fall back to jsonb).
 */
async function linkEntities(rows) {
  const linked = [];
  for (const row of rows) {
    try {
      const hit = await findExisting(row.label);
      if (hit && hit.entity_id) {
        row.entity_id = hit.entity_id;
        linked.push(hit.entity_id);
      }
    } catch (err) {
      // one failed lookup must not abort the generation
    }
  }
  return linked;
}

// ═══════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════

/**
 * Bulk-insert nodes with a single statement. Parents must land before their
 * children for the self-FK, and `flatten` already emits depth-first order, so
 * one ordered multi-row INSERT satisfies it — no awaiting in a loop.
 */
async function insertNodes(rows) {
  if (rows.length === 0) return;
  const cols = ['node_id', 'map_id', 'parent_id', 'label', 'summary', 'detail', 'node_type', 'order_index', 'entity_id'];
  const values = [];
  const tuples = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(r.node_id, r.map_id, r.parent_id, r.label, r.summary, r.detail, r.node_type, r.order_index, r.entity_id);
    return '(' + cols.map((_, c) => `$${base + c + 1}`).join(',') + ')';
  });
  await query(`INSERT INTO mind_map_nodes (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
}

async function createMap({ userId, title, topic, sourceType, sourceRef, meta = {} }) {
  const mapId = 'mm_' + uuidv4();
  await query(`
    INSERT INTO mind_maps (map_id, user_id, title, topic, source_type, source_ref, meta)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [mapId, userId, clean(title, 160), clean(topic, 400), sourceType, sourceRef || null, JSON.stringify(meta)]);
  return mapId;
}

// ═══════════════════════════════════════════════════════════
// Generation
// ═══════════════════════════════════════════════════════════

async function generateHierarchy(userContent, { model = null, maxChars = 8000 } = {}) {
  const res = await runInference({
    messages: [
      { role: 'system', content: GEN_PROMPT },
      { role: 'user', content: userContent.slice(0, maxChars) }
    ],
    temperature: 0.4,
    jsonMode: true,
    feature: 'mindmap',
    model
  });
  return { raw: parseJsonLoose(res.content), provider: res.provider, model: res.model };
}

/**
 * Build a map from a bare topic.
 * @returns {Promise<{mapId, title, nodeCount, linkedEntities}>}
 */
async function generateFromTopic(userId, topic, opts = {}) {
  const cleanTopic = clean(topic, 400);
  if (!cleanTopic) throw new Error('topic is required');

  // Give the model whatever the user already knows about this, so the map
  // extends their graph instead of restating a generic outline.
  const known = await relatedContext(cleanTopic);
  const prompt = `TOPIC: ${cleanTopic}` + (known ? `\n\nThe learner has already studied these related concepts — connect to them where honest, and do not re-teach them from scratch:\n${known}` : '');

  const { raw, provider, model } = await generateHierarchy(prompt, opts);
  const tree = normalizeTree(raw, cleanTopic);
  if (tree.children.length < MIN_BRANCHES) {
    throw new Error(`generator produced only ${tree.children.length} branch(es) — refusing to save a stub map`);
  }

  const title = clean(raw?.title || cleanTopic, 160);
  const mapId = await createMap({
    userId, title, topic: cleanTopic, sourceType: 'topic', sourceRef: null,
    meta: { provider, model, generatedAt: new Date().toISOString() }
  });

  const rows = flatten(tree, mapId);
  const linked = await linkEntities(rows);
  await insertNodes(rows);

  if (linked.length) {
    await recordActivation({
      entityIds: linked, userId, source: 'mindmap', sourceId: mapId,
      detail: `Studied via mind map "${title}".`
    });
  }

  return { mapId, title, nodeCount: rows.length, linkedEntities: linked.length };
}

/**
 * Build a map from an existing conversation. Uses the transcript as the source
 * material rather than the bare topic, so the map reflects what was actually
 * discussed — including the user's own framing.
 */
async function generateFromChat(userId, sessionId, opts = {}) {
  const res = await query(`
    SELECT role, content FROM ai_conversations
    WHERE session_id = $1 AND user_id = $2 AND role IN ('user','assistant')
    ORDER BY created_at ASC LIMIT 40
  `, [sessionId, userId]);

  if (res.rows.length === 0) {
    throw new Error('no conversation found for that session');
  }

  const transcript = res.rows
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clean(m.content, 1200)}`)
    .join('\n');

  const firstUser = res.rows.find(r => r.role === 'user');
  const topic = clean(firstUser ? firstUser.content : 'Conversation', 200);

  const { raw, provider, model } = await generateHierarchy(
    `Build a study mind map of what this conversation covers.\n\nTRANSCRIPT:\n${transcript}`, opts);

  const tree = normalizeTree(raw, topic);
  if (tree.children.length < MIN_BRANCHES) {
    throw new Error(`generator produced only ${tree.children.length} branch(es) — refusing to save a stub map`);
  }

  const title = clean(raw?.title || topic, 160);
  const mapId = await createMap({
    userId, title, topic, sourceType: 'chat', sourceRef: sessionId,
    meta: { provider, model, messages: res.rows.length, generatedAt: new Date().toISOString() }
  });

  const rows = flatten(tree, mapId);
  const linked = await linkEntities(rows);
  await insertNodes(rows);

  if (linked.length) {
    await recordActivation({
      entityIds: linked, userId, source: 'mindmap', sourceId: mapId,
      detail: `Studied via mind map "${title}".`
    });
  }

  return { mapId, title, nodeCount: rows.length, linkedEntities: linked.length };
}

/**
 * Build a map from documents the user uploaded.
 *
 * The map is grounded: the model is told to organise what the sources actually
 * say. Documents are then adopted by the map (map_id set), so the root's
 * overview can name every source the map was built from.
 */
async function generateFromDocuments(userId, docIds, opts = {}) {
  const docs = await docsByIds(userId, docIds);
  if (!docs.length) throw new Error('no documents found for that selection');

  // A scanned PDF with no text layer extracts to nothing. Building a map from
  // the filename alone would look like it worked and be worthless.
  const usable = docs.filter(d => String(d.extracted || '').trim().length > 40);
  if (!usable.length) throw new Error('none of those documents had extractable text');

  const focus = clean(opts.topic, 300);
  const topic = focus || clean(usable.map(d => d.filename).join(', '), 400);

  const prompt =
    `Build a study mind map of the ${usable.length} source document(s) below.` +
    (focus ? ` Focus it on: ${focus}.` : '') +
    `\nOrganise it by what the sources actually say. Do not add facts they do not contain.\n\n` +
    sourceBlock(usable, DOC_BUDGET);

  const { raw, provider, model } = await generateHierarchy(prompt, { ...opts, maxChars: DOC_BUDGET + 2000 });
  const tree = normalizeTree(raw, topic);
  if (tree.children.length < MIN_BRANCHES) {
    throw new Error(`generator produced only ${tree.children.length} branch(es) — refusing to save a stub map`);
  }

  const title = clean(raw?.title || topic, 160);
  const mapId = await createMap({
    userId, title, topic, sourceType: 'document', sourceRef: usable[0].doc_id,
    meta: {
      provider, model, generatedAt: new Date().toISOString(),
      sources: usable.map(d => ({ docId: d.doc_id, filename: d.filename }))
    }
  });

  const rows = flatten(tree, mapId);
  const linked = await linkEntities(rows);
  await insertNodes(rows);

  await adoptDocs(mapId, userId, usable);

  if (linked.length) {
    await recordActivation({
      entityIds: linked, userId, source: 'mindmap', sourceId: mapId,
      detail: `Studied via mind map "${title}".`
    });
  }

  return {
    mapId, title, nodeCount: rows.length, linkedEntities: linked.length,
    sourceCount: usable.length, skipped: docs.length - usable.length
  };
}

/**
 * Grow one branch on demand. The ancestor chain is the context, so an expanded
 * node goes one level deeper rather than drifting back to the top-level topic —
 * this is the primary interaction, not one-shot generation.
 */
async function expandNode(mapId, nodeId, opts = {}) {
  const nodeRes = await query(
    'SELECT node_id, map_id, parent_id, label, summary FROM mind_map_nodes WHERE node_id = $1 AND map_id = $2',
    [nodeId, mapId]);
  const node = nodeRes.rows[0];
  if (!node) throw new Error('node not found');

  const depth = await depthOf(nodeId);
  if (depth >= MAX_DEPTH) {
    return { added: 0, reason: `node is already at maximum depth (${MAX_DEPTH})` };
  }

  const ancestors = await ancestorChain(nodeId);
  const existing = await query(
    'SELECT label FROM mind_map_nodes WHERE parent_id = $1 ORDER BY order_index', [nodeId]);

  // Documents on this node or anywhere above it are the source of truth for
  // this branch. With them present the expansion stops being general knowledge
  // and starts being "what do MY sources say about this".
  const docs = (await inheritedDocs(nodeId)).filter(d => String(d.extracted || '').trim().length > 40);

  const prompt =
    `PATH: ${ancestors.join(' → ')}\n` +
    `NODE TO EXPAND: ${node.label}${node.summary ? ` — ${node.summary}` : ''}\n` +
    (existing.rows.length
      ? `ALREADY PRESENT (do not repeat): ${existing.rows.map(r => r.label).join(', ')}\n`
      : '') +
    (docs.length
      ? `\nGround every child in the source material below — it is what this branch is about. ` +
        `Do not add anything the sources do not support.\n\n${sourceBlock(docs.slice(0, 4), EXPAND_DOC_BUDGET)}\n`
      : '');

  const res = await runInference({
    messages: [
      { role: 'system', content: EXPAND_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: 0.5,
    jsonMode: true,
    feature: 'mindmap',
    model: opts.model || null
  });

  const raw = parseJsonLoose(res.content);
  const taken = new Set(existing.rows.map(r => r.label.toLowerCase()));
  taken.add(node.label.toLowerCase());

  const kids = (Array.isArray(raw?.children) ? raw.children : [])
    .slice(0, MAX_CHILDREN)
    .map(k => normalizeNode(k, depth + 1, taken))
    .filter(Boolean);

  if (kids.length === 0) return { added: 0, reason: 'the model returned nothing new' };

  const startOrder = existing.rows.length;
  const rows = [];
  kids.forEach((kid, i) => {
    const id = 'mmn_' + uuidv4();
    rows.push({
      node_id: id, map_id: mapId, parent_id: nodeId,
      label: kid.label, summary: kid.summary, detail: kid.detail,
      node_type: kid.nodeType, order_index: startOrder + i, entity_id: null
    });
    // Grandchildren the model volunteered are kept only if depth allows.
    if (depth + 2 <= MAX_DEPTH) {
      kid.children.forEach((g, gi) => rows.push({
        node_id: 'mmn_' + uuidv4(), map_id: mapId, parent_id: id,
        label: g.label, summary: g.summary, detail: g.detail,
        node_type: g.nodeType, order_index: gi, entity_id: null
      }));
    }
  });

  const linked = await linkEntities(rows);
  await insertNodes(rows);
  await touchMap(mapId);

  return { added: rows.length, linkedEntities: linked.length, nodes: rows };
}

// ═══════════════════════════════════════════════════════════
// Reads / helpers
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// Documents
// ═══════════════════════════════════════════════════════════

/** The caller's own documents, by id. Ownership is part of the query, not a check after it. */
async function docsByIds(userId, docIds) {
  const ids = (Array.isArray(docIds) ? docIds : []).filter(d => typeof d === 'string' && d);
  if (!ids.length) return [];
  const res = await query(
    'SELECT * FROM mind_map_docs WHERE user_id = $1 AND doc_id = ANY($2::text[]) ORDER BY created_at ASC',
    [userId, ids]);
  return res.rows;
}

/**
 * Documents in scope for a node: its own first, then each ancestor's, then the
 * map-level sources. A leaf inherits the paper its branch was built from, which
 * is what "ask about this" has to mean for the answer to be grounded.
 */
async function inheritedDocs(nodeId) {
  const res = await query(`
    WITH RECURSIVE up AS (
      SELECT node_id, parent_id, map_id, 0 AS d FROM mind_map_nodes WHERE node_id = $1
      UNION ALL
      SELECT n.node_id, n.parent_id, n.map_id, up.d + 1
        FROM mind_map_nodes n JOIN up ON up.parent_id = n.node_id
    )
    SELECT d.*, up.d AS distance FROM mind_map_docs d JOIN up ON d.node_id = up.node_id
    UNION ALL
    SELECT d.*, 999 AS distance FROM mind_map_docs d
     WHERE d.node_id IS NULL
       AND d.map_id = (SELECT map_id FROM mind_map_nodes WHERE node_id = $1)
    ORDER BY distance ASC, created_at ASC
  `, [nodeId]);
  return res.rows;
}

/**
 * Bind the documents a generation used to the map it produced.
 *
 * A document still sitting in the library is moved. One that already belongs to
 * another map is COPIED instead — building a second map from a paper must not
 * silently strip that paper off the first map's node, which is exactly what a
 * bare UPDATE would do. The text is already extracted, so a copy is cheap.
 */
async function adoptDocs(mapId, userId, docs) {
  if (!docs.length) return;
  const free = docs.filter(d => !d.map_id);
  const bound = docs.filter(d => d.map_id && d.map_id !== mapId);

  if (free.length) {
    await query(
      `UPDATE mind_map_docs SET map_id = $1
        WHERE user_id = $2 AND doc_id = ANY($3::text[]) AND map_id IS NULL`,
      [mapId, userId, free.map(d => d.doc_id)]);
  }

  for (const d of bound) {
    await query(`
      INSERT INTO mind_map_docs
        (doc_id, user_id, map_id, node_id, filename, mimetype, size_bytes,
         stored_name, kind, extracted, char_count)
      VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)
    `, ['mmd_' + uuidv4(), userId, mapId, d.filename, d.mimetype, d.size_bytes,
        d.stored_name, d.kind, d.extracted, d.char_count]);
  }
}

/** Every document belonging to a map, node-scoped and map-scoped alike. */
async function mapDocs(mapId) {
  const res = await query(`
    SELECT doc_id, map_id, node_id, filename, mimetype, size_bytes, stored_name,
           kind, char_count, created_at
      FROM mind_map_docs WHERE map_id = $1 ORDER BY created_at ASC
  `, [mapId]);
  return res.rows;
}

/**
 * Fold documents into one prompt block, spending the budget evenly. Even split
 * rather than first-come: the fifth source the learner chose deserves the same
 * room as the first.
 */
function sourceBlock(docs, budget) {
  if (!docs.length) return '';
  const share = Math.max(700, Math.floor(budget / docs.length));
  return docs.map((d, i) => {
    const body = String(d.extracted || '').trim();
    const cut = body.length > share ? body.slice(0, share) + '\n…[source truncated]' : body;
    return `--- SOURCE ${i + 1}: ${d.filename} ---\n${cut}`;
  }).join('\n\n');
}

/** What the map was built from, in the order a reader would want to see it. */
function buildSources(map, docs) {
  const out = [];
  if (map.source_type === 'chat' && map.source_ref) {
    out.push({ type: 'chat', label: 'Conversation transcript', ref: map.source_ref });
  } else if (map.source_type === 'topic') {
    out.push({ type: 'topic', label: map.topic || map.title || 'Topic', ref: null });
  } else if (map.source_type === 'graph') {
    out.push({ type: 'graph', label: 'Knowledge graph slice', ref: map.source_ref });
  }
  for (const d of docs) {
    out.push({
      type: 'document', label: d.filename, ref: d.doc_id,
      nodeId: d.node_id, kind: d.kind, chars: d.char_count
    });
  }
  return out;
}

/** Concepts the user already has in the living graph, as prompt context. */
async function relatedContext(topic) {
  try {
    const words = topic.toLowerCase().split(/\W+/).filter(w => w.length > 3).slice(0, 6);
    if (words.length === 0) return '';
    const res = await query(`
      SELECT canonical_name, entity_type FROM entities
      WHERE status = 'active' AND (${words.map((_, i) => `LOWER(canonical_name) LIKE $${i + 1}`).join(' OR ')})
      ORDER BY importance DESC NULLS LAST, mention_count DESC LIMIT 12
    `, words.map(w => `%${w}%`));
    return res.rows.map(r => `- ${r.canonical_name} (${r.entity_type})`).join('\n');
  } catch (err) {
    return ''; // graph unavailable — generate from the topic alone
  }
}

async function depthOf(nodeId) {
  const res = await query(`
    WITH RECURSIVE up AS (
      SELECT node_id, parent_id, 1 AS d FROM mind_map_nodes WHERE node_id = $1
      UNION ALL
      SELECT n.node_id, n.parent_id, up.d + 1 FROM mind_map_nodes n JOIN up ON up.parent_id = n.node_id
    )
    SELECT MAX(d) AS depth FROM up
  `, [nodeId]);
  return Number(res.rows[0]?.depth || 1);
}

async function ancestorChain(nodeId) {
  const res = await query(`
    WITH RECURSIVE up AS (
      SELECT node_id, parent_id, label, 0 AS d FROM mind_map_nodes WHERE node_id = $1
      UNION ALL
      SELECT n.node_id, n.parent_id, n.label, up.d + 1 FROM mind_map_nodes n JOIN up ON up.parent_id = n.node_id
    )
    SELECT label FROM up ORDER BY d DESC
  `, [nodeId]);
  return res.rows.map(r => r.label);
}

async function touchMap(mapId) {
  await query('UPDATE mind_maps SET updated_at = now() WHERE map_id = $1', [mapId]);
}

/** Full tree for one map, ordered so parents always precede their children. */
async function getMap(mapId, userId) {
  const mapRes = await query('SELECT * FROM mind_maps WHERE map_id = $1 AND user_id = $2', [mapId, userId]);
  const map = mapRes.rows[0];
  if (!map) return null;

  const nodes = await query(`
    WITH RECURSIVE tree AS (
      SELECT n.*, 0 AS depth, LPAD(n.order_index::text, 6, '0') AS path
      FROM mind_map_nodes n WHERE n.map_id = $1 AND n.parent_id IS NULL
      UNION ALL
      SELECT c.*, tree.depth + 1, tree.path || '.' || LPAD(c.order_index::text, 6, '0')
      FROM mind_map_nodes c JOIN tree ON c.parent_id = tree.node_id
    )
    SELECT * FROM tree ORDER BY path
  `, [mapId]);

  const edges = await query('SELECT * FROM mind_map_edges WHERE map_id = $1', [mapId]);
  const docs = await mapDocs(mapId);
  return { map, nodes: nodes.rows, edges: edges.rows, docs, sources: buildSources(map, docs) };
}

async function listMaps(userId) {
  const res = await query(`
    SELECT m.*,
           (SELECT COUNT(*) FROM mind_map_nodes n WHERE n.map_id = m.map_id) AS node_count,
           (SELECT COUNT(*) FROM mind_map_docs d WHERE d.map_id = m.map_id)  AS doc_count
    FROM mind_maps m WHERE m.user_id = $1 ORDER BY m.updated_at DESC LIMIT 50
  `, [userId]);
  return res.rows;
}

module.exports = {
  generateFromTopic,
  generateFromChat,
  generateFromDocuments,
  expandNode,
  getMap,
  listMaps,
  createMap,
  insertNodes,
  touchMap,
  // documents
  docsByIds,
  inheritedDocs,
  mapDocs,
  sourceBlock,
  buildSources,
  // exported for tests
  normalizeTree,
  normalizeNode,
  flatten,
  depthOf,
  ancestorChain,
  MAX_DEPTH,
  MAX_BRANCHES,
  MAX_CHILDREN,
  MAX_NODES
};
