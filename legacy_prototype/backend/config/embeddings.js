// config/embeddings.js
//
// Gemini by default: the deployed server has a Gemini key and no Ollama, and
// with Ollama as the only provider every vector it stored was the SHA-256
// fallback (755 of 963 rows by 2026-09-25) — vectors that only match identical
// text. EMBEDDING_PROVIDER=ollama keeps local, offline work possible.
//
// Vectors from different models live in different spaces and cannot be
// compared, so switching provider means re-embedding every stored row
// (scripts/backfill_embeddings.js). The dimension is fixed by the vector(768)
// columns.
const provider = process.env.EMBEDDING_PROVIDER || 'gemini';

module.exports = {
  provider,
  model: process.env.EMBEDDING_MODEL || (provider === 'ollama' ? 'nomic-embed-text' : 'gemini-embedding-001'),
  dimension: 768
};
