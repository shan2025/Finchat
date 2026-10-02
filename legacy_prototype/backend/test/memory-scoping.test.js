// test/memory-scoping.test.js — learned links and recalled context stay with
// the user they belong to, and recall starts from what the user actually said.
//
// Pins four fixes found by probing the memory pipeline against a fake DB:
//   - a relation to a node the user already owned was looked up in the
//     ownerless graph, missed, and dropped
//   - chat edges were stored with user_id NULL, so per-user consolidation and
//     every per-user edge count skipped them
//   - Graph-RAG anchored on substrings ("ETH" in "method")
//   - skill recipes were searched across users, and with no embedding the
//     newest recipes were returned whatever the goal
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
function fresh(relPath) {
  delete require.cache[require.resolve(relPath)];
  return require(relPath);
}
function restore(...modules) {
  for (const f of stubbed) delete require.cache[f];
  stubbed.clear();
  for (const m of modules) delete require.cache[require.resolve(m)];
}

const ENGINE = '../services/cognitive/MemoryEngine';
const GRAPH = '../services/cognitive/EntityGraph';
const RECIPES = '../services/cognitive/SkillRecipes';

// u1 already owns a "Bitcoin" node. Every statement is recorded.
function fakeDb() {
  const calls = [];
  const query = async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    if (/LOWER\(canonical_name\) = LOWER\(\$1\)/.test(flat)) {
      const [name, uid] = params;
      return name.toLowerCase() === 'bitcoin' && uid === 'u1'
        ? { rows: [{ entity_id: 'ent_btc_u1', canonical_name: 'Bitcoin', summary: '' }] }
        : { rows: [] };
    }
    if (/SELECT entity_id FROM entities WHERE canonical_name/.test(flat)) return { rows: [{ entity_id: `ent_${params[0]}` }] };
    return { rows: [], rowCount: 0 };
  };
  return { calls, query };
}

function loadEngine(db, extraction) {
  stub('../database', { query: db.query, getPool: () => ({}) });
  stub('../services/inference', { runInference: async () => ({ content: JSON.stringify(extraction) }) });
  stub('../services/cognitive/EventBus', { eventBus: { emit() {} } });
  return fresh(ENGINE);
}

test('ingestChat links a new node to one the user already owns, and the edge is theirs', async () => {
  const db = fakeDb();
  try {
    const ME = loadEngine(db, {
      entities: [{ name: 'Lightning Network', type: 'technology', summary: 'An L2 for Bitcoin.' }],
      relations: [{ from: 'Lightning Network', to: 'Bitcoin', type: 'part_of', reason: 'L2', strength: 0.8 }],
      contradictions: [], preferences: []
    });
    const rep = await ME.ingestChat({
      userId: 'u1', sessionId: 's1', agentId: 'plato',
      userText: 'How does the Lightning Network relate to Bitcoin?', aiText: 'It is a layer-2 network.'
    });
    assert.deepEqual(rep.linked, [{ from: 'Lightning Network', to: 'Bitcoin', type: 'part_of' }]);
    const lookup = db.calls.find(c => /LOWER\(canonical_name\)/.test(c.sql) && c.params[0] === 'Bitcoin');
    assert.equal(lookup.params[1], 'u1', 'Bitcoin is looked up in u1\'s graph');
    const ins = db.calls.find(c => /INSERT INTO entity_edges/.test(c.sql));
    assert.equal(ins.params[1], 'ent_btc_u1');
    assert.equal(ins.params[3], 'u1', 'edge carries user_id');
  } finally { restore(ENGINE); }
});

test('upsertLivingEdge prefers the user\'s own row and adopts an ownerless one', async () => {
  const db = fakeDb();
  const q = db.query;
  db.query = async (sql, params) => /SELECT edge_id FROM entity_edges/.test(sql)
    ? (await q(sql, params), { rows: [{ edge_id: 7 }] })
    : q(sql, params);
  try {
    const ME = loadEngine(db, {});
    await ME.upsertLivingEdge({ fromId: 'a', toId: 'b', edgeType: 'uses', userId: 'u1' });
    const sel = db.calls.find(c => /SELECT edge_id/.test(c.sql));
    assert.match(sel.sql, /ORDER BY \(user_id IS NOT DISTINCT FROM \$4\) DESC/);
    assert.equal(sel.params[3], 'u1');
    const upd = db.calls.find(c => /UPDATE entity_edges SET/.test(c.sql));
    assert.match(upd.sql, /user_id = COALESCE\(user_id, \$6\)/);
    assert.equal(upd.params[5], 'u1');
  } finally { restore(ENGINE); }
});

test('wordsOf: lowercased words, punctuation collapsed', () => {
  const { wordsOf } = fresh(GRAPH);
  assert.equal(wordsOf('Is ETH/BTC up? S&P 500, too.'), 'is eth btc up s p 500 too');
  assert.equal(wordsOf(''), '');
  delete require.cache[require.resolve(GRAPH)];
});

test('findRelatedForText matches anchors on padded whole words', async () => {
  let seen;
  stub('../database', { query: async (sql, params) => { seen = { sql, params }; return { rows: [] }; } });
  stub('../services/inference', { runInference: async () => ({}) });
  try {
    const { findRelatedForText } = fresh(GRAPH);
    await findRelatedForText('What method fits the ETH solution?', 6, null, 'u1');
    assert.equal(seen.params[0], ' what method fits the eth solution ');
    assert.equal(seen.params[1], 'u1');
    assert.match(seen.sql, /\$1 LIKE '% ' \|\| norm \|\| ' %'/);
    assert.doesNotMatch(seen.sql, /ILIKE '%' \|\| canonical_name/);
  } finally { restore(GRAPH); }
});

test('SkillRecipes.findRelevant is user-scoped and returns nothing without an embedding', async () => {
  let seen;
  stub('../database', { query: async (sql, params) => { seen = { sql, params }; return { rows: [
    { recipe_id: 'near', distance: 0.1 }, { recipe_id: 'far', distance: 0.35 }, { recipe_id: 'nodist', distance: null }
  ] }; } });
  let vector = new Array(768).fill(0.036);
  stub('../services/cognitive/MemoryService', { generateEmbedding: async () => vector });
  try {
    let SR = fresh(RECIPES);
    const hits = await SR.findRelevant({ goal: 'compare two ETFs', agentId: 'plato', userId: 'u1' });
    assert.deepEqual(hits.map(h => h.recipe_id), ['near']);
    assert.equal(seen.params[1], 'u1');
    assert.match(seen.sql, /x\.user_id IS NULL OR x\.user_id = \$2/);

    vector = null;
    seen = null;
    SR = fresh(RECIPES);
    assert.deepEqual(await SR.findRelevant({ goal: 'compare two ETFs', agentId: 'plato', userId: 'u1' }), []);
    assert.equal(seen, null, 'no recency fallback query');
  } finally { restore(RECIPES); }
});
