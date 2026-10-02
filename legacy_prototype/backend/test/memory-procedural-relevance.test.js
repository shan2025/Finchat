// test/memory-procedural-relevance.test.js — procedural recall follows the goal.
//
// Every procedural memory is written at importance 7, so the old
// importance-then-recency lookup gave every turn the same newest notes,
// including other users' notes for the same agent. These pin the replacement:
// rows are matched on words shared with the goal, scoped to this user plus
// runs with no user behind them, and nothing is returned when nothing matches.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createMemoryRepository } = require('../repositories/MemoryRepository');

function fakeQuery(rows = []) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params, normalised: sql.replace(/\s+/g, ' ').trim() });
    return { rows };
  };
  fn.calls = calls;
  return fn;
}

test.describe('findRelevantProcedural', () => {
  test('binds terms, user, agent and limit in that order', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findRelevantProcedural({ terms: ['tsla', 'earnings'], userId: 'u1', agentId: 'plato', limit: 3 });
    assert.deepEqual(q.calls[0].params, [['tsla', 'earnings'], 'u1', 'plato', 3]);
    assert.ok(q.calls[0].normalised.endsWith('LIMIT $4'), q.calls[0].normalised);
  });

  test('ranks by shared terms, not by importance or recency alone', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findRelevantProcedural({ terms: ['tsla'], userId: 'u1', agentId: 'plato' });
    const sql = q.calls[0].normalised;
    assert.match(sql, /plainto_tsquery\('english', t\)/);
    assert.match(sql, /to_tsvector\('english', m\.content\)/);
    assert.match(sql, /h\.hits >= \(SELECT n FROM need\)/);
    assert.match(sql, /ORDER BY h\.hits DESC/);
  });

  test("never reads another user's rows", async () => {
    // Only the caller's rows, or rows owned by the agent itself (no user).
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findRelevantProcedural({ terms: ['tsla'], userId: 'u1', agentId: 'plato' });
    const sql = q.calls[0].normalised;
    assert.match(sql, /m\.user_id = \$2 OR \(m\.user_id = m\.metadata->>'agentId' AND m\.metadata->>'agentId' IN \(\$3, 'global'\)\)/);
    assert.doesNotMatch(sql, /metadata->>'agentId' IS NULL/);
  });

  test('skips the reflection parse-failure placeholder', async () => {
    // It quotes the goal verbatim, so without this it would always rank first.
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findRelevantProcedural({ terms: ['tsla'], userId: 'u1' });
    assert.match(q.calls[0].normalised, /m\.content NOT LIKE '%Reflection parsing failed%'/);
  });

  test('no terms means no query and no rows', async () => {
    const q = fakeQuery([{ content: 'should not be returned' }]);
    const repo = createMemoryRepository({ query: q });
    assert.deepEqual(await repo.findRelevantProcedural({ terms: [], userId: 'u1' }), []);
    assert.deepEqual(await repo.findRelevantProcedural({}), []);
    assert.equal(q.calls.length, 0);
  });

  test('defaults the agent to global and the limit to 3', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findRelevantProcedural({ terms: ['x1'] });
    assert.deepEqual(q.calls[0].params, [['x1'], null, 'global', 3]);
  });
});

// ─── MemoryService wiring ───

const SVC_PATH = require.resolve('../services/cognitive/MemoryService');
const stubbed = new Set();
function stub(relPath, exports) {
  const filename = require.resolve(relPath);
  const m = new Module(filename, null);
  m.filename = filename; m.path = path.dirname(filename); m.loaded = true; m.exports = exports;
  require.cache[filename] = m;
  stubbed.add(filename);
}

// `embed` stands in for the provider: a vector, or null for "no provider".
function load(repo, { embed = null } = {}) {
  stub('axios', { post: async () => {
    if (!embed) throw new Error('no provider in tests');
    return { data: { embedding: { values: embed } } };
  } });
  stub('../services/QuotaManager', { resolveCredentials: () => [{ key: 'test-key' }] });
  stub('../repositories/MemoryRepository', { memoryRepository: repo });
  stub('../repositories/ExecutionRepository', { executionRepository: {} });
  stub('../services/redis', { setWorkingMemory: async () => {}, getWorkingMemory: async () => ({}) });
  stub('../services/cognitive/EntityGraph', { findRelatedForText: async () => [] });
  stub('../services/cognitive/SkillRecipes', { findRelevant: async () => [], markReused: async () => {} });
  stub('../services/cognitive/MemoryEngine', { recordActivation: async () => {} });
  delete require.cache[SVC_PATH];
  return require(SVC_PATH);
}

test.after(() => {
  for (const f of stubbed) delete require.cache[f];
  delete require.cache[SVC_PATH];
});

test.describe('goalTerms', () => {
  test('lowercases, splits on punctuation, drops 1-letter words, dedupes', () => {
    const svc = load({});
    assert.deepEqual(svc.goalTerms("What's TSLA's Q3 outlook? TSLA, a/b"), ['what', 'tsla', 'q3', 'outlook']);
  });

  test('keeps non-English letters and caps the term count', () => {
    const svc = load({});
    assert.deepEqual(svc.goalTerms('café über'), ['café', 'über']);
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    assert.equal(svc.goalTerms(long).length, 32);
  });
});

test.describe('retrieveEnrichedContext procedural memories', () => {
  test('asks for notes matching the goal, for this user and agent', async () => {
    const seen = [];
    const svc = load({
      async findRelevantProcedural(args) {
        seen.push(args);
        return [{ content: '[Procedural Learning for plato]: TSLA earnings…', importance: 7 }];
      },
    });
    const out = await svc.retrieveEnrichedContext({ userId: 'u1', goal: 'TSLA earnings', agentName: 'plato' });
    // Twice the limit, so fusion has candidates to choose between.
    assert.deepEqual(seen, [{ terms: ['tsla', 'earnings'], userId: 'u1', agentId: 'plato', limit: 6 }]);
    assert.deepEqual(out.memories, [{ type: 'procedural', content: '[Procedural Learning for plato]: TSLA earnings…', importance: 7 }]);
  });

  test('with no embedding provider, recall stays lexical', async () => {
    const svc = load({
      findRelevantProcedural: async () => [{ memory_id: 'a', content: 'lexical note', importance: 7 }],
      findSimilarProcedural: async () => { throw new Error('vector search without a vector'); },
    });
    const out = await svc.retrieveEnrichedContext({ userId: 'u1', goal: 'TSLA earnings', agentName: 'plato' });
    assert.deepEqual(out.memories.map(m => m.content), ['lexical note']);
  });

  test('hybrid: a note both halves find ranks first; vector-only notes are recalled too', async () => {
    const vectorArgs = [];
    const svc = load({
      findRelevantProcedural: async () => [
        { memory_id: 'lex-only', content: 'shares words', importance: 7 },
        { memory_id: 'both', content: 'shares words and meaning', importance: 7 },
      ],
      findSimilarProcedural: async (args) => {
        vectorArgs.push(args);
        return [
          { memory_id: 'both', content: 'shares words and meaning', importance: 7 },
          { memory_id: 'vec-only', content: 'same idea, other words', importance: 7 },
        ];
      },
    }, { embed: Array.from({ length: 768 }, (_, i) => (i % 5) - 2) });
    const out = await svc.retrieveEnrichedContext({ userId: 'u1', goal: 'how does interest compound', agentName: 'plato' });
    assert.deepEqual(out.memories.map(m => m.content),
      ['shares words and meaning', 'shares words', 'same idea, other words']);
    assert.equal(vectorArgs[0].userId, 'u1');
    assert.equal(vectorArgs[0].agentId, 'plato');
    assert.equal(vectorArgs[0].vector.length, 768);
    assert.ok(vectorArgs[0].maxDistance > 0 && vectorArgs[0].maxDistance < 0.5);
  });

  test('no longer injects notes by recency', async () => {
    // The two old lookups must not be called on the chat path any more.
    const svc = load({
      findRelevantProcedural: async () => [],
      findProceduralWorkflows: async () => { throw new Error('recency lookup called'); },
      findMemories: async () => { throw new Error('recency lookup called'); },
    });
    const out = await svc.retrieveEnrichedContext({ userId: 'u1', goal: 'anything at all', agentName: 'plato' });
    assert.deepEqual(out.memories, []);
  });
});
