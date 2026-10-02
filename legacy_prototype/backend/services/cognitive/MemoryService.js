// services/cognitive/MemoryService.js — Unified memory API (Sprint 2 Full Taxonomy)
//
// SQL for memories/knowledge/knowledge_embeddings lives in
// repositories/MemoryRepository.js; the episodic read lives in
// ExecutionRepository (it reads the `executions` table). This module keeps the
// memory policy: id minting, which provider embeds, and how the four
// stores are assembled for ContextBuilder.
const { memoryRepository } = require('../../repositories/MemoryRepository');
const { executionRepository } = require('../../repositories/ExecutionRepository');
const { setWorkingMemory, getWorkingMemory } = require('../redis');
const embeddingsConfig = require('../../config/embeddings');
const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// ─── 1. Working Memory (Redis, per-execution scratchpad, EXPIRE 86400) ───

async function storeWorkingMemory(contextId, data) {
  const existing = await getWorkingMemory(contextId);
  const merged = { ...existing, ...data, _updatedAt: new Date().toISOString() };
  await setWorkingMemory(contextId, merged, 86400);
  return merged;
}

async function retrieveWorkingMemory(contextId) {
  return await getWorkingMemory(contextId);
}

async function appendToScratchpad(contextId, entry) {
  const existing = await getWorkingMemory(contextId);
  const scratchpad = existing._scratchpad || [];
  scratchpad.push({ content: entry, timestamp: new Date().toISOString() });
  return await storeWorkingMemory(contextId, { _scratchpad: scratchpad });
}

// ─── 2. Episodic Memory (executions + execution_logs recall) ───

/**
 * Recall past episodes (executions & outcomes) from executions and execution_logs tables.
 * Scoped by userId and/or agentName.
 */
async function retrieveEpisodicHistory({ userId, agentId, limit = 5 } = {}) {
  return executionRepository.findCompletedEpisodes({ userId, agentId, limit });
}

// ─── 3. Long-Term Memory & Procedural Workflows (PostgreSQL — memories table) ───

async function store({ userId, memoryType, content, metadata = {}, importance = 5 }) {
  const uid = userId || 'system';

  // Best-effort: synthetic ids ('system', agent names) have no users row, and
  // memories.user_id is a foreign key. A failure here is not fatal — the insert
  // below will surface a real constraint problem.
  try {
    await memoryRepository.ensureUserExists(uid);
  } catch (err) {
    // ignore
  }

  const memoryId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  await memoryRepository.insertMemory({
    memoryId, userId: uid, memoryType, content, metadata, importance,
  });

  return { memoryId, memoryType, content, importance };
}

async function retrieve({ userId, memoryType, limit = 5 } = {}) {
  return memoryRepository.findMemories({ userId, memoryType, limit });
}

/**
 * Retrieve learned procedural workflows (memory_type = 'procedural') for an agent.
 */
async function retrieveProceduralWorkflows({ agentId, limit = 5 } = {}) {
  return memoryRepository.findProceduralWorkflows({ agentId, limit });
}

/**
 * Words of a goal for lexical matching: lowercased, split on anything that is
 * not a letter or digit, deduped. Stopwords and stemming are left to Postgres.
 * Capped so a long mission prompt cannot build an unbounded query.
 */
function goalTerms(goal, max = 32) {
  const words = String(goal || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return [...new Set(words)].slice(0, max);
}

/**
 * Procedural learnings relevant to this goal, for this user and agent. Empty
 * when nothing shares enough words with the goal: no note beats an unrelated
 * one that the model then tries to apply.
 */
async function retrieveRelevantProcedural({ goal, userId, agentId, limit = 3 } = {}) {
  return memoryRepository.findRelevantProcedural({ terms: goalTerms(goal), userId, agentId, limit });
}

// ─── 4. Semantic Memory (Embedding-Based Retrieval) ───

// Gemini's task types tune the vector for how it will be compared:
//   'document' — stored text that will be searched (a finding, a summary)
//   'query'    — a question searching those documents
//   'similar'  — text compared with text of the same kind (goal vs goal)
const GEMINI_TASK = { document: 'RETRIEVAL_DOCUMENT', query: 'RETRIEVAL_QUERY', similar: 'SEMANTIC_SIMILARITY' };

function l2normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 ? v.map((x) => x / n) : v;
}

// One warning per provider per minute — a dead key would otherwise log on
// every chat message.
const _warnedAt = {};
function warnOnce(provider, msg) {
  if (Date.now() - (_warnedAt[provider] || 0) < 60000) return;
  _warnedAt[provider] = Date.now();
  console.warn(`⚠️ MemoryService: ${provider} embedding failed: ${msg} — storing without a vector`);
}

/**
 * Embed text with the configured provider. Returns a unit-length vector of
 * `dimension` floats, or null when no provider can embed right now.
 *
 * There is deliberately no fallback vector. The old SHA-256 stand-in looked
 * valid to pgvector but matched only identical text, so every "similar
 * question" search silently returned noise. A row stored without a vector is
 * honest: it is skipped by similarity search and picked up by the backfill.
 *
 * @param {string} text
 * @param {{ purpose?: 'document'|'query'|'similar' }} [opts]
 */
async function generateEmbedding(text, { purpose = 'document' } = {}) {
  const { provider, model, dimension } = embeddingsConfig;
  const input = String(text || '').slice(0, 8000);
  if (!input.trim()) return null;

  if (provider === 'gemini') {
    const { resolveCredentials } = require('../QuotaManager');
    const cred = resolveCredentials('gemini')[0];
    if (!cred) { warnOnce('gemini', 'no GEMINI_API_KEY configured'); return null; }
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        { model: `models/${model}`, content: { parts: [{ text: input }] }, taskType: GEMINI_TASK[purpose] || GEMINI_TASK.document, outputDimensionality: dimension },
        { headers: { 'x-goog-api-key': cred.key }, timeout: 15000 }
      );
      const values = res.data && res.data.embedding && res.data.embedding.values;
      if (!Array.isArray(values) || values.length !== dimension) { warnOnce('gemini', `unexpected shape (${values ? values.length : 'none'})`); return null; }
      // Below its native size Gemini's vectors are not unit length; cosine
      // search in pgvector does not care, but every stored vector should match.
      return l2normalize(values);
    } catch (err) {
      const status = err.response ? err.response.status : err.code;
      warnOnce('gemini', `${status} ${err.message}`);
      return null;
    }
  }

  if (provider === 'ollama') {
    try {
      const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, { model, prompt: input }, { timeout: 30000 });
      const v = response.data && response.data.embedding;
      return Array.isArray(v) && v.length === dimension ? l2normalize(v) : null;
    } catch (err) {
      warnOnce('ollama', err.message);
      return null;
    }
  }

  warnOnce(provider, `unknown provider "${provider}"`);
  return null;
}

async function storeWithEmbedding({ title, content, source = 'cognitive_core' }) {
  const knowledgeId = `know_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  await memoryRepository.insertKnowledge({ knowledgeId, title, content, source });

  // The knowledge row is stored either way — an embedding failure must not lose
  // the content, it only costs similarity search on that row.
  const embedding = await generateEmbedding(content);
  if (embedding) {
    const embeddingId = `emb_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    await memoryRepository.insertKnowledgeEmbedding({
      embeddingId, knowledgeId, vector: embedding,
    });
    return { knowledgeId, embeddingId, embeddingDimension: embedding.length, stored: true };
  }

  return { knowledgeId, embeddingId: null, embeddingDimension: null, stored: true };
}

async function retrieveBySimilarity(queryText, limit = 3) {
  const embedding = await generateEmbedding(queryText, { purpose: 'query' });
  if (!embedding) {
    // No vector to search with — fall back to newest-first rather than nothing.
    return memoryRepository.findRecentKnowledge(limit);
  }
  return memoryRepository.findKnowledgeBySimilarity(embedding, limit);
}

// ─── 5. Context Retrieval (for ContextBuilder integration) ───

/**
 * Retrieve JUST the memory list (backward-compatible with Phase 6).
 * For the enriched Graph-RAG bundle use retrieveEnrichedContext().
 */
async function retrieveForContext(opts) {
  const bundle = await retrieveEnrichedContext(opts);
  return bundle.memories;
}

/**
 * Retrieve memories + Graph-RAG entities + skill recipes for ContextBuilder.
 * Sprint 5C addition.
 */
async function retrieveEnrichedContext({ userId, conversationId, goal, agentName, limit = 5 }) {
  const memories = [];

  // 1. Working memory from Redis
  if (conversationId) {
    const wm = await retrieveWorkingMemory(conversationId);
    if (wm && wm._scratchpad && wm._scratchpad.length > 0) {
      memories.push(...wm._scratchpad.map(s => ({
        type: 'working',
        content: s.content,
        timestamp: s.timestamp
      })));
    }
  }

  // 2. Procedural learnings that match this goal. This replaces two lookups
  // that ignored the goal (the agent's newest 2, from any user, and this
  // user's newest 3), which put the same notes into every turn.
  if (goal) {
    const procs = await retrieveRelevantProcedural({ goal, userId, agentId: agentName, limit: 3 });
    memories.push(...procs.map(p => ({
      type: 'procedural',
      content: p.content,
      importance: p.importance
    })));
  }

  // 3. Sprint 5C: Graph-RAG one-hop neighbors of entities in the goal (best-effort)
  let graphContext = [];
  let recipeHints = [];
  try {
    if (goal) {
      const { findRelatedForText } = require('./EntityGraph');
      // userId scopes the walk to this user's own graph — without it, retrieval
      // could surface another account's topics as this user's memory.
      graphContext = await findRelatedForText(goal, 6, agentName || null, userId || null);
      // Cognitive Memory Engine: the nodes used to answer "light up" —
      // fire-and-forget so retrieval latency is untouched.
      const activatedIds = graphContext.map(g => g.entity_id).filter(Boolean);
      if (activatedIds.length > 0) {
        const { recordActivation } = require('./MemoryEngine');
        recordActivation({
          entityIds: activatedIds,
          userId,
          agentId: agentName || null,
          source: 'retrieval',
          sourceId: conversationId || null,
          detail: goal ? `Recalled while answering: "${String(goal).slice(0, 120)}"` : ''
        }).catch(() => { });
      }
    }
  } catch (e) { /* best-effort */ }
  try {
    if (goal) {
      const { findRelevant, markReused } = require('./SkillRecipes');
      recipeHints = await findRelevant({ goal, agentId: agentName, limit: 2 });
      for (const r of recipeHints) { markReused(r.recipe_id).catch(() => { }); }
    }
  } catch (e) { /* best-effort */ }

  return { memories, graphContext, recipeHints };
}

module.exports = {
  // Working memory
  storeWorkingMemory,
  retrieveWorkingMemory,
  appendToScratchpad,
  // Episodic memory
  retrieveEpisodicHistory,
  // Long-term & procedural memory
  store,
  retrieve,
  retrieveProceduralWorkflows,
  retrieveRelevantProcedural,
  goalTerms,
  // Semantic memory
  generateEmbedding,
  storeWithEmbedding,
  retrieveBySimilarity,
  // Context integration
  retrieveForContext,
  retrieveEnrichedContext
};
