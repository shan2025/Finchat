// repositories/MemoryRepository.js — all SQL for `memories`, `knowledge` and
// `knowledge_embeddings`.
//
// Second repository, following the pattern set by ExecutionRepository: the
// `query` function is injected so callers can be unit-tested without Supabase,
// and no SQL for these tables should live anywhere else.
//
// Why this table group next: MemoryService is the largest remaining `query()`
// consumer, and the security gap analysis (P0-4) wants owner/classification/
// provenance columns and per-agent read scoping on exactly these rows. Putting
// the boundary here first means that work has one place to change rather than
// a dozen call sites.

/**
 * @param {object}   [deps]
 * @param {Function} [deps.query] - (sql, params) => Promise<{rows: object[]}>
 */
function createMemoryRepository({ query } = {}) {
  // Lazy so importing this module never opens a pool.
  const run = (sql, params) => {
    const q = query || require('../database').query;
    return q(sql, params);
  };

  return {
    /**
     * Satisfy the memories.user_id foreign key for synthetic users ('system',
     * agent ids) that never went through signup.
     *
     * Belongs to a future UserRepository; it lives here for now because this is
     * the only path that needs it. Callers must not rely on it for real users.
     */
    async ensureUserExists(userId) {
      await run(
        `INSERT INTO users (user_id, email, name, role, password_hash)
         VALUES ($1, $1 || '@system.finchat.local', 'System User ' || $1, 'user', 'none')
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]);
    },

    async insertMemory({ memoryId, userId, memoryType, content, metadata, importance }) {
      await run(
        `INSERT INTO memories (memory_id, user_id, memory_type, content, metadata, importance)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [memoryId, userId, memoryType, content, JSON.stringify(metadata || {}), importance]);
    },

    /**
     * Both filters are optional. Placeholders are numbered as clauses are
     * appended, so the LIMIT always lands on the next free index — the classic
     * way to get this wrong is to hardcode $3.
     */
    async findMemories({ userId, memoryType, limit = 5 } = {}) {
      let sql = 'SELECT * FROM memories WHERE 1=1';
      const params = [];
      let i = 1;

      if (userId) { sql += ` AND user_id = $${i++}`; params.push(userId); }
      if (memoryType) { sql += ` AND memory_type = $${i++}`; params.push(memoryType); }

      sql += ` ORDER BY importance DESC, created_at DESC LIMIT $${i}`;
      params.push(limit);

      const res = await run(sql, params);
      return res.rows;
    },

    /** Procedural recipes for one agent, plus the shared/global ones. */
    async findProceduralWorkflows({ agentId, limit = 5 } = {}) {
      const res = await run(
        `SELECT * FROM memories
          WHERE memory_type = 'procedural'
            AND (metadata->>'agentId' = $1
              OR metadata->>'agentId' = 'global'
              OR metadata->>'agentId' IS NULL)
          ORDER BY importance DESC, created_at DESC
          LIMIT $2`,
        [agentId || 'global', limit]);
      return res.rows;
    },

    async insertKnowledge({ knowledgeId, title, content, source }) {
      await run(
        `INSERT INTO knowledge (knowledge_id, title, content, source)
         VALUES ($1, $2, $3, $4)`,
        [knowledgeId, title, content, source]);
    },

    /** @param {number[]} vector - raw embedding, serialised to pgvector literal here. */
    async insertKnowledgeEmbedding({ embeddingId, knowledgeId, vector }) {
      await run(
        `INSERT INTO knowledge_embeddings (embedding_id, knowledge_id, embedding)
         VALUES ($1, $2, $3::vector)`,
        [embeddingId, knowledgeId, `[${vector.join(',')}]`]);
    },

    /** Fallback when no embedding could be produced (Ollama down, etc). */
    async findRecentKnowledge(limit = 3) {
      const res = await run(
        'SELECT * FROM knowledge ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows;
    },

    /** Cosine-distance nearest neighbours via pgvector's `<=>`. */
    async findKnowledgeBySimilarity(vector, limit = 3) {
      const res = await run(
        `SELECT k.*, ke.embedding_id,
                (ke.embedding <=> $1::vector) as distance
           FROM knowledge k
           JOIN knowledge_embeddings ke ON k.knowledge_id = ke.knowledge_id
          ORDER BY ke.embedding <=> $1::vector
          LIMIT $2`,
        [`[${vector.join(',')}]`, limit]);
      return res.rows;
    },
  };
}

module.exports = {
  createMemoryRepository,
  memoryRepository: createMemoryRepository(),
};
