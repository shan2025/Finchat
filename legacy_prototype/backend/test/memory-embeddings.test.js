// test/memory-embeddings.test.js — generateEmbedding never fakes a vector.
//
// The deployed server has no Ollama, and the old code answered every failed
// embed with a SHA-256 "vector" that pgvector accepted and that matched only
// identical text — so similarity search returned noise for months without an
// error anywhere. These pin the replacement: Gemini by default, a real
// unit-length 768-d vector or null, never a stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const SVC_PATH = require.resolve('../services/cognitive/MemoryService');
const stubbed = new Set();
function stub(relPath, exports) {
  const filename = require.resolve(relPath);
  const m = new Module(filename, null);
  m.filename = filename; m.path = path.dirname(filename); m.loaded = true; m.exports = exports;
  require.cache[filename] = m;
  stubbed.add(filename);
}

// Fresh MemoryService over a fake axios; `post` decides what the provider says.
function load({ post, env = {} }) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  const calls = [];
  stub('axios', { post: async (url, body, opts) => { calls.push({ url, body, opts }); return post(url, body, opts); } });
  stub('../repositories/MemoryRepository', { memoryRepository: {} });
  stub('../repositories/ExecutionRepository', { executionRepository: {} });
  stub('../services/redis', { setWorkingMemory: async () => {}, getWorkingMemory: async () => ({}) });
  delete require.cache[require.resolve('../config/embeddings')];
  delete require.cache[SVC_PATH];
  const svc = require(SVC_PATH);
  const restore = () => {
    for (const f of stubbed) delete require.cache[f];
    stubbed.clear();
    delete require.cache[SVC_PATH];
    delete require.cache[require.resolve('../config/embeddings')];
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  return { svc, calls, restore };
}

const vec = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('gemini: returns a unit-length 768-d vector and sends the right task type', async () => {
  const { svc, calls, restore } = load({
    env: { EMBEDDING_PROVIDER: null, GEMINI_API_KEY: 'test-key-abcd' },
    post: async () => ({ data: { embedding: { values: vec(768, (i) => (i % 7) - 3) } } })
  });
  try {
    const v = await svc.generateEmbedding('RBI digital lending rules', { purpose: 'query' });
    assert.equal(v.length, 768);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, 'vector is normalised');
    assert.match(calls[0].url, /gemini-embedding-001:embedContent$/);
    assert.equal(calls[0].body.taskType, 'RETRIEVAL_QUERY');
    assert.equal(calls[0].body.outputDimensionality, 768);
    assert.equal(calls[0].opts.headers['x-goog-api-key'], 'test-key-abcd');
  } finally { restore(); }
});

test('gemini failure returns null, never a stand-in vector', async () => {
  const { svc, restore } = load({
    env: { EMBEDDING_PROVIDER: null, GEMINI_API_KEY: 'test-key-abcd' },
    post: async () => { const e = new Error('quota'); e.response = { status: 429 }; throw e; }
  });
  try {
    assert.equal(await svc.generateEmbedding('anything'), null);
  } finally { restore(); }
});

test('no Gemini key: null without calling out', async () => {
  const { svc, calls, restore } = load({ env: { EMBEDDING_PROVIDER: null, GEMINI_API_KEY: null }, post: async () => { throw new Error('should not be called'); } });
  try {
    assert.equal(await svc.generateEmbedding('anything'), null);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('a wrong-sized vector is rejected rather than stored', async () => {
  const { svc, restore } = load({
    env: { EMBEDDING_PROVIDER: null, GEMINI_API_KEY: 'test-key-abcd' },
    post: async () => ({ data: { embedding: { values: vec(3072, () => 0.1) } } })
  });
  try {
    assert.equal(await svc.generateEmbedding('anything'), null);
  } finally { restore(); }
});

test('ollama provider: unreachable means null, not a hash', async () => {
  const { svc, restore } = load({ env: { EMBEDDING_PROVIDER: 'ollama' }, post: async () => { throw new Error('ECONNREFUSED'); } });
  try {
    assert.equal(await svc.generateEmbedding('anything'), null);
  } finally { restore(); }
});

test('blank text is not sent', async () => {
  const { svc, calls, restore } = load({ env: { EMBEDDING_PROVIDER: null, GEMINI_API_KEY: 'test-key-abcd' }, post: async () => ({}) });
  try {
    assert.equal(await svc.generateEmbedding('   '), null);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});
