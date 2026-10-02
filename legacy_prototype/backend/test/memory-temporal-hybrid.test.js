// test/memory-temporal-hybrid.test.js — facts hold over an interval, and
// recall finds what the user means as well as what they named.
//
// Temporal: the extractor is shown the user's current facts and may close
// them; recall walks only facts true now (or at a requested moment); a closed
// fact restated opens a new interval rather than reviving the old one.
//
// Hybrid: lexical and vector candidates are fused by rank (RRF); each side is
// gated on its own, so fusion never promotes an unrelated row.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const stubbed = new Set();
function stub(relPath, exports) {
  const filename = require.resolve(relPath);
  const m = new Module(filename, null);
  m.filename = filename; m.path = path.dirname(filename); m.loaded = true; m.exports = exports;
  require.cache[filename] = m;
  stubbed.add(filename);
}
const ENGINE = '../services/cognitive/MemoryEngine';
const GRAPH = '../services/cognitive/EntityGraph';
const fresh = (p) => { delete require.cache[require.resolve(p)]; return require(p); };
function restore() {
  for (const f of stubbed) delete require.cache[f];
  stubbed.clear();
  for (const p of [ENGINE, GRAPH]) delete require.cache[require.resolve(p)];
}

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

/**
 * Fake DB routed by statement shape. `routes` is [[regex, (params) => rows]];
 * anything unrouted returns no rows. Every call is recorded.
 */
function fakeDb(routes = []) {
  const calls = [];
  const query = async (sql, params = []) => {
    const s = flat(sql);
    calls.push({ sql: s, params });
    for (const [re, fn] of routes) if (re.test(s)) return { rows: fn(params) || [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { calls, query };
}

// ─── HybridSearch.fuseRanked ───

test.describe('fuseRanked (reciprocal rank fusion)', () => {
  const { fuseRanked } = require('../services/cognitive/HybridSearch');
  const key = (x) => x.id;

  test('an item both lists hold outranks the top of either list alone', () => {
    const out = fuseRanked([
      { name: 'lexical', items: [{ id: 'a' }, { id: 'b' }] },
      { name: 'vector', items: [{ id: 'c' }, { id: 'b' }] },
    ], { key });
    assert.deepEqual(out.map(x => x.id), ['b', 'a', 'c']);
    assert.deepEqual(out[0].matchedBy, ['lexical', 'vector']);
    assert.deepEqual(out[1].matchedBy, ['lexical']);
  });

  test('ties keep first-seen order; limit applies after fusion', () => {
    const out = fuseRanked([
      { name: 'lexical', items: [{ id: 'a' }] },
      { name: 'vector', items: [{ id: 'z' }] },
    ], { key, limit: 1 });
    assert.deepEqual(out.map(x => x.id), ['a']);
  });

  test('a list repeating an item counts it once', () => {
    const out = fuseRanked([{ name: 'lexical', items: [{ id: 'a' }, { id: 'a' }] }], { key });
    assert.equal(out.length, 1);
    assert.equal(out[0].rrf, 1 / 61);
  });

  test('empty and missing lists fuse to nothing', () => {
    assert.deepEqual(fuseRanked([{ name: 'x', items: [] }, { name: 'y' }], { key }), []);
  });

  test('the first list\'s copy of an item is the one returned', () => {
    const out = fuseRanked([
      { name: 'lexical', items: [{ id: 'a', from: 'lexical' }] },
      { name: 'vector', items: [{ id: 'a', from: 'vector', distance: 0.3 }] },
    ], { key });
    assert.equal(out[0].from, 'lexical');
  });
});

// ─── parseFactDate ───

test('parseFactDate accepts stated past dates only', () => {
  stub('../database', { query: async () => ({ rows: [] }), getPool: () => ({}) });
  stub('../services/inference', { runInference: async () => ({}) });
  stub('../services/cognitive/EventBus', { eventBus: { emit() {} } });
  try {
    const { parseFactDate } = fresh(ENGINE);
    assert.equal(parseFactDate('2026-03-15'), '2026-03-15T00:00:00.000Z');
    assert.equal(parseFactDate(null), null);
    assert.equal(parseFactDate('last March'), null);
    assert.equal(parseFactDate('1850-01-01'), null);
    assert.equal(parseFactDate('2999-01-01'), null);
    assert.equal(parseFactDate('2026-13-45'), null);
  } finally { restore(); }
});

// ─── Temporal ingestion ───

// u1 holds TSLA (edge 41) and prefers short answers (edge 42).
const FACT_ROWS = [
  { edge_id: 42, from_entity_id: 'ent_user_u1', edge_type: 'prefers', reason: 'Keep answers short',
    valid_from: '2026-08-01T00:00:00Z', from_name: 'Asha', to_name: 'Short answers', is_pref: true },
  { edge_id: 41, from_entity_id: 'ent_user_u1', edge_type: 'related_to', reason: 'Holds the stock',
    valid_from: '2026-05-02T00:00:00Z', from_name: 'Asha', to_name: 'TSLA', is_pref: false },
];

function loadEngine(db, llmJson, seenPrompts = []) {
  stub('../database', { query: db.query, getPool: () => ({}) });
  stub('../services/inference', { runInference: async ({ messages }) => {
    seenPrompts.push(messages[1].content);
    return { content: JSON.stringify(llmJson) };
  } });
  stub('../services/cognitive/EventBus', { eventBus: { emit() {} } });
  stub('../services/cognitive/MemoryService', { generateEmbeddings: async (t) => t.map(() => null) });
  return fresh(ENGINE);
}

const temporalRoutes = () => [
  [/FROM entity_edges e JOIN entities f .* WHERE e\.valid_to IS NULL AND e\.edge_type <> 'co_mentioned'/, () => FACT_ROWS],
  [/^UPDATE entity_edges SET valid_to = GREATEST/, (p) => [{ from_entity_id: 'ent_user_u1', to_entity_id: 'x', edge_type: String(p[0]) === '41' ? 'related_to' : 'prefers' }]],
];

test('ingestChat shows current facts to the extractor and closes the ones the user ended', async () => {
  const db = fakeDb(temporalRoutes());
  const prompts = [];
  try {
    const ME = loadEngine(db, {
      entities: [], relations: [], contradictions: [], preferences: [],
      superseded: [
        { fact: 'F2', reason: 'User says they sold all their TSLA.', ended: '2026-09-30' },
        { fact: 'F9', reason: 'never shown — must be ignored' },
      ],
    }, prompts);
    const rep = await ME.ingestChat({
      userId: 'u1', sessionId: 's1', agentId: 'plato',
      userText: 'I sold all my TSLA last week, what should I do with the cash?', aiText: 'Consider your goals.'
    });

    assert.match(prompts[0], /KNOWN FACTS \(still believed true\):\nF1: Asha --prefers--> Short answers: Keep answers short \(since 2026-08-01\)\nF2: Asha --related_to--> TSLA/);

    const closes = db.calls.filter(c => /^UPDATE entity_edges SET valid_to = GREATEST/.test(c.sql));
    assert.equal(closes.length, 1, 'only the shown fact is closed');
    assert.deepEqual(closes[0].params, ['41', 'User says they sold all their TSLA.', '2026-09-30T00:00:00.000Z']);
    assert.match(closes[0].sql, /WHERE edge_id = \$1 AND valid_to IS NULL/);
    assert.equal(rep.superseded.length, 1);

    const ev = db.calls.find(c => /INSERT INTO node_events/.test(c.sql));
    assert.equal(ev.params[1], 'superseded');
  } finally { restore(); }
});

test('a fact is closed BEFORE its replacement is written', async () => {
  const db = fakeDb([
    ...temporalRoutes(),
    [/^SELECT entity_id FROM entities WHERE entity_id = \$1/, (p) => [{ entity_id: p[0] }]],
    [/^SELECT entity_id FROM entities WHERE canonical_name/, (p) => [{ entity_id: `ent_${p[0]}` }]],
  ]);
  try {
    const ME = loadEngine(db, {
      entities: [], relations: [], contradictions: [],
      preferences: [{ label: 'Detailed answers', instruction: 'Give thorough, detailed answers.', kind: 'depth', confidence: 0.9 }],
      superseded: [{ fact: 'F1', reason: 'User now wants more detail.' }],
    });
    const rep = await ME.ingestChat({
      userId: 'u1', sessionId: 's1', userText: 'Actually, stop keeping it short — I want the full detail.', aiText: 'Understood.'
    });
    const iClose = db.calls.findIndex(c => /^UPDATE entity_edges SET valid_to = GREATEST/.test(c.sql));
    const iNew = db.calls.findIndex(c => /^INSERT INTO entity_edges/.test(c.sql));
    assert.ok(iClose >= 0 && iNew > iClose, 'close comes first');
    assert.equal(db.calls[iClose].params[0], '42');
    assert.equal(rep.preferences[0].label, 'Detailed answers');
  } finally { restore(); }
});

test('document ingestion neither reads facts nor closes them', async () => {
  const db = fakeDb(temporalRoutes());
  const prompts = [];
  try {
    const ME = loadEngine(db, {
      entities: [], relations: [], contradictions: [], preferences: [],
      superseded: [{ fact: 'F1', reason: 'from a PDF' }],
    }, prompts);
    await ME.ingestChat({
      userId: 'u1', sessionId: 'doc1', userText: '[Document: report]\n\nTSLA sold 400k cars this quarter.', aiText: '',
      sourceType: 'document', learnPreferences: false
    });
    assert.doesNotMatch(prompts[0], /KNOWN FACTS/);
    assert.ok(!db.calls.some(c => /valid_to = GREATEST/.test(c.sql)));
  } finally { restore(); }
});

test('upsertLivingEdge reinforces open edges only, and dates a new one from the stated start', async () => {
  const db = fakeDb();
  try {
    const ME = loadEngine(db, {});
    await ME.upsertLivingEdge({ fromId: 'a', toId: 'b', edgeType: 'works_on', userId: 'u1', validFrom: '2026-01-05T00:00:00.000Z' });
    const sel = db.calls.find(c => /^SELECT edge_id FROM entity_edges/.test(c.sql));
    assert.match(sel.sql, /AND valid_to IS NULL/);
    const ins = db.calls.find(c => /^INSERT INTO entity_edges/.test(c.sql));
    assert.match(ins.sql, /COALESCE\(\$9::timestamptz, now\(\)\)/);
    assert.equal(ins.params[8], '2026-01-05T00:00:00.000Z');
  } finally { restore(); }
});

test('standing preferences come from open edges only', async () => {
  const db = fakeDb();
  try {
    const ME = loadEngine(db, {});
    await ME.getUserPreferences('u1');
    assert.match(db.calls[0].sql, /e\.edge_type = 'prefers' AND e\.user_id = \$1 .*AND e\.valid_to IS NULL/);
  } finally { restore(); }
});

// ─── Graph recall ───

function loadGraph(db) {
  stub('../database', { query: db.query });
  stub('../services/inference', { runInference: async () => ({}) });
  return fresh(GRAPH);
}

test('findRelatedForText walks only facts true now', async () => {
  const db = fakeDb([[/^SELECT entity_id, canonical_name, entity_type FROM \( SELECT/, () => [
    { entity_id: 'ent_tsla', canonical_name: 'TSLA', entity_type: 'ticker' }]]]);
  try {
    const G = loadGraph(db);
    const out = await G.findRelatedForText('How is TSLA doing?', 6, 'atlas', 'u1');
    const walk = db.calls.find(c => /^WITH hop1 AS/.test(c.sql));
    assert.match(walk.sql, /AND ee\.valid_to IS NULL AND e\.status/);
    assert.match(walk.sql, /AND ee2\.valid_to IS NULL AND e\.status/);
    assert.equal(walk.params.length, 4, 'no asOf parameter');
    assert.deepEqual(out.map(o => [o.name, o.viaEdge]), [['TSLA', 'anchor']]);
  } finally { restore(); }
});

test('findRelatedForText can walk the graph as it stood at a past moment', async () => {
  const db = fakeDb([[/^SELECT entity_id, canonical_name, entity_type FROM \( SELECT/, () => [
    { entity_id: 'ent_tsla', canonical_name: 'TSLA', entity_type: 'ticker' }]]]);
  try {
    const G = loadGraph(db);
    await G.findRelatedForText('TSLA', 6, null, 'u1', { asOf: '2026-06-01' });
    const walk = db.calls.find(c => /^WITH hop1 AS/.test(c.sql));
    assert.match(walk.sql, /ee\.valid_from <= \$5::timestamptz AND \(ee\.valid_to IS NULL OR ee\.valid_to > \$5::timestamptz\)/);
    assert.equal(walk.params[4], '2026-06-01T00:00:00.000Z');
  } finally { restore(); }
});

test('hybrid anchors: named nodes and nodes close in meaning, gated and fused', async () => {
  const db = fakeDb([
    [/^SELECT entity_id, canonical_name, entity_type FROM \( SELECT/, () => [
      { entity_id: 'ent_btc', canonical_name: 'Bitcoin', entity_type: 'ticker' }]],
    [/embedding <=> \$1::vector\) < \$3/, () => [
      { entity_id: 'ent_sol', canonical_name: 'Solana', entity_type: 'technology' },
      { entity_id: 'ent_btc', canonical_name: 'Bitcoin', entity_type: 'ticker' }]],
  ]);
  try {
    const G = loadGraph(db);
    const out = await G.findRelatedForText('how is Bitcoin and the wider crypto market', 6, null, 'u1',
      { queryVector: new Array(768).fill(0.036) });
    assert.deepEqual(out.map(o => [o.name, o.viaEdge]), [['Bitcoin', 'anchor'], ['Solana', 'similar']]);
    const sem = db.calls.find(c => /embedding <=> \$1::vector\) < \$3/.test(c.sql));
    assert.equal(sem.params[1], 'u1', 'vector anchors are the user\'s own');
    assert.ok(sem.params[2] > 0 && sem.params[2] < 0.5, 'distance gate applied');
    assert.match(sem.sql, /entity_type <> 'preference'/);
    assert.match(sem.sql, /entity_id NOT LIKE 'ent_user_%'/);
  } finally { restore(); }
});

test('no query vector means no vector query', async () => {
  const db = fakeDb();
  try {
    const G = loadGraph(db);
    await G.findAnchors('anything', 'u1', null);
    assert.ok(!db.calls.some(c => /<=>/.test(c.sql)));
  } finally { restore(); }
});

test('a failing vector half leaves the named anchors standing', async () => {
  const db = fakeDb([[/^SELECT entity_id, canonical_name, entity_type FROM \( SELECT/, () => [
    { entity_id: 'ent_btc', canonical_name: 'Bitcoin', entity_type: 'ticker' }]]]);
  const q = db.query;
  db.query = async (sql, p) => { if (/<=>/.test(sql)) throw new Error('column "embedding" does not exist'); return q(sql, p); };
  try {
    const G = loadGraph(db);
    const out = await G.findAnchors('Bitcoin today', 'u1', new Array(768).fill(0.036));
    assert.deepEqual(out.map(a => a.entity_id), ['ent_btc']);
  } finally { restore(); }
});

test('co-mention upserts target the open-edge unique index', async () => {
  const db = fakeDb();
  try {
    const G = loadGraph(db);
    await G.upsertEdge({ fromId: 'a', toId: 'b', edgeType: 'co_mentioned', userId: 'u1' });
    assert.match(db.calls[0].sql, /ON CONFLICT \(from_entity_id, to_entity_id, edge_type, user_id\) WHERE valid_to IS NULL DO UPDATE/);
  } finally { restore(); }
});

test('embedMissingEntities embeds name, type and summary in one batch', async () => {
  const db = fakeDb([[/WHERE status = 'active' AND user_id = \$1 AND embedding IS NULL/, () => [
    { entity_id: 'e1', canonical_name: 'Bitcoin', entity_type: 'ticker', summary: 'The user holds some.' },
    { entity_id: 'e2', canonical_name: 'Phantom', entity_type: 'technology', summary: '' },
  ]]]);
  const batches = [];
  try {
    stub('../services/cognitive/MemoryService', { generateEmbeddings: async (texts, opts) => {
      batches.push({ texts, opts });
      return [[0.6, 0.8], null];
    } });
    const G = loadGraph(db);
    assert.equal(await G.embedMissingEntities('u1'), 1);
    assert.deepEqual(batches, [{ texts: ['Bitcoin (ticker): The user holds some.', 'Phantom (technology)'], opts: { purpose: 'document' } }]);
    const upd = db.calls.filter(c => /^UPDATE entities SET embedding/.test(c.sql));
    assert.deepEqual(upd.map(u => u.params), [['e1', '[0.6,0.8]']]);
    assert.equal(await G.embedMissingEntities(null), 0);
  } finally { restore(); }
});

// ─── Repository: vector half of procedural recall ───

test('findSimilarProcedural keeps lexical recall\'s scope and gates on distance', async () => {
  const { createMemoryRepository } = require('../repositories/MemoryRepository');
  const calls = [];
  const repo = createMemoryRepository({ query: async (sql, params) => { calls.push({ sql: flat(sql), params }); return { rows: [] }; } });
  await repo.findSimilarProcedural({ vector: [0.1, 0.2], userId: 'u1', agentId: 'plato', maxDistance: 0.42, limit: 6 });
  const { sql, params } = calls[0];
  assert.deepEqual(params, ['[0.1,0.2]', 'u1', 'plato', 0.42, 6]);
  assert.match(sql, /m\.user_id = \$2 OR \(m\.user_id = m\.metadata->>'agentId' AND m\.metadata->>'agentId' IN \(\$3, 'global'\)\)/);
  assert.match(sql, /\(m\.embedding <=> \$1::vector\) < \$4/);
  assert.match(sql, /NOT LIKE '%Reflection parsing failed%'/);
  assert.deepEqual(await repo.findSimilarProcedural({ vector: [] }), []);
});
