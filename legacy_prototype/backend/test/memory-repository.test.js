// test/memory-repository.test.js
//
// The interesting risk in this repository is placeholder numbering: findMemories
// and findCompletedEpisodes append optional WHERE clauses and then bind LIMIT to
// "the next free index". Getting that wrong binds LIMIT to a filter value, which
// does not throw — it silently returns the wrong rows. So every filter
// combination is enumerated here.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepository } = require('../repositories/MemoryRepository');
const { createExecutionRepository } = require('../repositories/ExecutionRepository');

function fakeQuery(rows = []) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params, normalised: sql.replace(/\s+/g, ' ').trim() });
    return { rows };
  };
  fn.calls = calls;
  return fn;
}

test.describe('findMemories placeholder numbering', () => {
  const cases = [
    { name: 'no filters', args: { limit: 5 }, params: [5], clauses: [] },
    { name: 'userId only', args: { userId: 'u1', limit: 7 }, params: ['u1', 7], clauses: ['user_id = $1'] },
    { name: 'memoryType only', args: { memoryType: 'semantic', limit: 3 }, params: ['semantic', 3], clauses: ['memory_type = $1'] },
    {
      name: 'both filters', args: { userId: 'u1', memoryType: 'episodic', limit: 9 },
      params: ['u1', 'episodic', 9], clauses: ['user_id = $1', 'memory_type = $2'],
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const q = fakeQuery();
      const repo = createMemoryRepository({ query: q });
      await repo.findMemories(c.args);

      assert.deepEqual(q.calls[0].params, c.params);
      for (const clause of c.clauses) {
        assert.ok(q.calls[0].normalised.includes(clause),
          `expected clause "${clause}" in: ${q.calls[0].normalised}`);
      }
      // LIMIT must bind the LAST parameter, whatever the filter count.
      assert.ok(q.calls[0].normalised.endsWith(`LIMIT $${c.params.length}`),
        `LIMIT should bind $${c.params.length}: ${q.calls[0].normalised}`);
    });
  }

  test('defaults to a limit of 5 with no arguments at all', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findMemories();
    assert.deepEqual(q.calls[0].params, [5]);
  });

  test('orders by importance then recency', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findMemories({});
    assert.match(q.calls[0].normalised, /ORDER BY importance DESC, created_at DESC/);
  });
});

test.describe('findCompletedEpisodes placeholder numbering', () => {
  const cases = [
    { name: 'no filters', args: { limit: 5 }, params: [5] },
    { name: 'userId only', args: { userId: 'u1', limit: 5 }, params: ['u1', 5] },
    { name: 'agentId only', args: { agentId: 'nova', limit: 5 }, params: ['nova', 5] },
    { name: 'both', args: { userId: 'u1', agentId: 'nova', limit: 2 }, params: ['u1', 'nova', 2] },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const q = fakeQuery();
      const repo = createExecutionRepository({ query: q });
      await repo.findCompletedEpisodes(c.args);
      assert.deepEqual(q.calls[0].params, c.params);
      assert.ok(q.calls[0].normalised.endsWith(`LIMIT $${c.params.length}`),
        q.calls[0].normalised);
    });
  }

  test('only ever returns completed executions', async () => {
    const q = fakeQuery();
    const repo = createExecutionRepository({ query: q });
    await repo.findCompletedEpisodes({});
    assert.match(q.calls[0].normalised, /WHERE e\.current_state = 'completed'/);
  });
});

test.describe('memories writes', () => {
  test('insertMemory serialises metadata to JSON', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.insertMemory({
      memoryId: 'mem_1', userId: 'u1', memoryType: 'semantic',
      content: 'c', metadata: { agentId: 'nova' }, importance: 7,
    });
    assert.deepEqual(q.calls[0].params,
      ['mem_1', 'u1', 'semantic', 'c', '{"agentId":"nova"}', 7]);
  });

  test('insertMemory tolerates missing metadata', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.insertMemory({ memoryId: 'm', userId: 'u', memoryType: 't', content: 'c', importance: 5 });
    assert.equal(q.calls[0].params[4], '{}');
  });

  test('ensureUserExists is idempotent by construction', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.ensureUserExists('system');
    assert.match(q.calls[0].normalised, /ON CONFLICT \(user_id\) DO NOTHING/);
    assert.deepEqual(q.calls[0].params, ['system']);
  });
});

test.describe('procedural workflows', () => {
  test('includes the agent plus shared and unattributed recipes', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findProceduralWorkflows({ agentId: 'nova', limit: 4 });
    const sql = q.calls[0].normalised;
    assert.match(sql, /memory_type = 'procedural'/);
    assert.match(sql, /metadata->>'agentId' = \$1/);
    assert.match(sql, /metadata->>'agentId' = 'global'/);
    assert.match(sql, /metadata->>'agentId' IS NULL/);
    assert.deepEqual(q.calls[0].params, ['nova', 4]);
  });

  test('falls back to global when no agent is given', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findProceduralWorkflows({});
    assert.deepEqual(q.calls[0].params, ['global', 5]);
  });
});

test.describe('knowledge and embeddings', () => {
  test('insertKnowledgeEmbedding serialises the vector as a pgvector literal', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.insertKnowledgeEmbedding({
      embeddingId: 'emb_1', knowledgeId: 'know_1', vector: [0.1, -0.2, 0.3],
    });
    assert.deepEqual(q.calls[0].params, ['emb_1', 'know_1', '[0.1,-0.2,0.3]']);
    assert.match(q.calls[0].normalised, /\$3::vector/);
  });

  test('similarity search binds the same vector for filter and ordering', async () => {
    // $1 appears in both the distance projection and the ORDER BY; binding a
    // second copy would double the payload and can silently diverge.
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findKnowledgeBySimilarity([1, 2], 3);
    assert.deepEqual(q.calls[0].params, ['[1,2]', 3]);
    const sql = q.calls[0].normalised;
    assert.match(sql, /\(ke\.embedding <=> \$1::vector\) as distance/);
    assert.match(sql, /ORDER BY ke\.embedding <=> \$1::vector/);
  });

  test('recent-knowledge fallback takes only a limit', async () => {
    const q = fakeQuery();
    const repo = createMemoryRepository({ query: q });
    await repo.findRecentKnowledge(4);
    assert.deepEqual(q.calls[0].params, [4]);
    assert.match(q.calls[0].normalised, /ORDER BY created_at DESC/);
  });
});

test('requiring the module does not open a database pool', () => {
  assert.doesNotThrow(() => {
    delete require.cache[require.resolve('../repositories/MemoryRepository')];
    require('../repositories/MemoryRepository');
  });
});
