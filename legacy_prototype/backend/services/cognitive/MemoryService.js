// services/cognitive/MemoryService.js — Unified memory API (Sprint 2 Full Taxonomy)
//
// SQL for memories/knowledge/knowledge_embeddings lives in
// repositories/MemoryRepository.js; the episodic read lives in
// ExecutionRepository (it reads the `executions` table). This module keeps the
// memory policy: id minting, the embedding fallback chain, and how the four
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

// ─── 4. Semantic Memory (Embedding-Based Retrieval) ───

async function generateEmbedding(text) {
  const { provider, model, dimension } = embeddingsConfig;

  if (provider === 'ollama') {
    try {
      const response = await axios.post(
        `${OLLAMA_URL}/api/embeddings`,
        { model, prompt: text },
        { timeout: 30000 }
      );
      return response.data.embedding || null;
    } catch (err) {
      console.warn(`⚠️ MemoryService: Ollama embedding failed: ${err.message} — using deterministic fallback`);
    }
  } else {
    console.warn(`⚠️ MemoryService: Unknown embedding provider "${provider}" — using deterministic fallback`);
  }

  // Deterministic fallback: generate a normalized pseudo-random vector from SHA-256 hash
  // This ensures pgvector insertion and cosine similarity queries always work
  return generateDeterministicEmbedding(text, dimension || 768);
}

/**
 * Generate a deterministic normalized vector from text using SHA-256.
 * Produces consistent embeddings for the same input text across restarts.
 * These won't have real semantic meaning, but they keep the pgvector pipeline functional.
 */
function generateDeterministicEmbedding(text, dimension) {
  const crypto = require('crypto');
  const vector = [];

  // Generate enough hash bytes to fill the vector
  // Each SHA-256 hash gives 32 bytes = 8 floats (4 bytes each)
  let hashInput = text;
  let chunkIndex = 0;

  while (vector.length < dimension) {
    const hash = crypto.createHash('sha256').update(hashInput + ':' + chunkIndex).digest();
    // Read non-overlapping 4-byte chunks from the 32-byte hash (8 values per hash)
    for (let i = 0; i + 3 < hash.length && vector.length < dimension; i += 4) {
      const val = hash.readUInt32BE(i);
      vector.push((val / 0xFFFFFFFF) * 2 - 1); // Map to [-1, 1]
    }
    chunkIndex++;
  }

  // L2 normalize the vector
  let norm = 0;
  for (let i = 0; i < dimension; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) vector[i] /= norm;
  }

  return vector.slice(0, dimension);
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
  const embedding = await generateEmbedding(queryText);
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

  // 2. Procedural workflows from PostgreSQL
  if (agentName) {
    const procs = await retrieveProceduralWorkflows({ agentId: agentName, limit: 2 });
    memories.push(...procs.map(p => ({
      type: 'procedural',
      content: p.content,
      importance: p.importance
    })));
  }

  // 3. Long-term memories from PostgreSQL
  if (userId) {
    const ltm = await retrieve({ userId, limit: 3 });
    memories.push(...ltm.map(m => ({
      type: m.memory_type,
      content: m.content,
      importance: m.importance
    })));
  }

  // 4. Sprint 5C: Graph-RAG one-hop neighbors of entities in the goal (best-effort)
  let graphContext = [];
  let recipeHints = [];
  try {
    if (goal) {
      const { findRelatedForText } = require('./EntityGraph');
      graphContext = await findRelatedForText(goal, 6, agentName || null);
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
  // Semantic memory
  generateEmbedding,
  storeWithEmbedding,
  retrieveBySimilarity,
  // Context integration
  retrieveForContext,
  retrieveEnrichedContext
};
