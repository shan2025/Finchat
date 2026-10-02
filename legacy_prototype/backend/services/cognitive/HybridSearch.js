// services/cognitive/HybridSearch.js — fuse lexical and vector result lists.
//
// Lexical search finds exact names and tickers that embeddings blur ("TSLA",
// "S&P 500"); vector search finds the same idea in other words ("crypto" →
// Bitcoin, "retirement fund" → index funds). Reciprocal Rank Fusion merges the
// two by rank alone, so BM25-style hit counts and cosine distances never have
// to be put on one scale: each list adds 1 / (k + rank) for every item it
// holds, and an item both lists agree on rises to the top.
//
// Gating is the caller's job. Each list must already hold only acceptable
// candidates (enough shared terms; distance under the calibrated cutoff) —
// fusion ranks, it does not judge relevance, and an unrelated note ranked
// first is still unrelated.

// Cosine distance under which a query→document pair counts as related.
// Calibrated on gemini-embedding-001 at 768d, RETRIEVAL_QUERY against
// RETRIEVAL_DOCUMENT: related pairs landed at 0.29–0.43, unrelated at 0.43+.
const VECTOR_MAX_DISTANCE = Number(process.env.MEMORY_VECTOR_MAX_DISTANCE) || 0.42;

/**
 * @template T
 * @param {Array<{ name: string, items: T[] }>} lists - each ranked best-first
 * @param {{ key: (item: T) => string, k?: number, limit?: number }} opts
 * @returns {Array<T & { rrf: number, matchedBy: string[] }>} best-first; the
 *   first list's copy of an item wins, so put the richer source first
 */
function fuseRanked(lists, { key, k = 60, limit = Infinity } = {}) {
  const byKey = new Map();
  for (const { name, items } of lists) {
    (items || []).forEach((item, rank) => {
      const id = key(item);
      if (id == null) return;
      const hit = byKey.get(id) || { item, rrf: 0, matchedBy: [], firstSeen: byKey.size };
      // A list naming the same item twice counts it once, at its best rank.
      if (hit.matchedBy.includes(name)) return;
      hit.rrf += 1 / (k + rank + 1);
      hit.matchedBy.push(name);
      byKey.set(id, hit);
    });
  }
  return [...byKey.values()]
    .sort((a, b) => b.rrf - a.rrf || a.firstSeen - b.firstSeen)
    .slice(0, limit)
    .map(({ item, rrf, matchedBy }) => ({ ...item, rrf, matchedBy }));
}

/** pgvector literal for a query parameter. */
const toVectorLiteral = (v) => `[${v.join(',')}]`;

module.exports = { fuseRanked, toVectorLiteral, VECTOR_MAX_DISTANCE };
