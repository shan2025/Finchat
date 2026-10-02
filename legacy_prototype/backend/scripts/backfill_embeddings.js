// scripts/backfill_embeddings.js — re-embed every stored vector with the configured provider.
//
// Why: until config/embeddings.js moved to Gemini, the deployed server had no
// embedding provider and stored a SHA-256 stand-in for every vector (matches
// identical text only); the rest were nomic vectors from local runs, which live
// in a different space. Neither can be compared with a Gemini query, so every
// vector is rewritten.
//
// Touches ONLY the vector columns: knowledge_embeddings.embedding (and inserts
// one for a knowledge row that has none), skill_recipes.embedding, and — after
// migration 063 — memories.embedding (procedural rows) and entities.embedding.
// No content is changed or deleted.
//
//   node scripts/backfill_embeddings.js            dry run: counts only
//   node scripts/backfill_embeddings.js --apply    write
//   node scripts/backfill_embeddings.js --apply --stale-only
//                                                  only rows still holding a hash stand-in
//                                                  or no vector (safe to re-run after deploy)
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { Client } = require('pg');
const { model, dimension, provider } = require('../config/embeddings');
const { resolveCredentials } = require('../services/QuotaManager');

const APPLY = process.argv.includes('--apply');
const STALE_ONLY = process.argv.includes('--stale-only');
const BATCH = 50;

// The retired stand-in, reproduced only to recognise rows that still hold it.
function hashVector(text, dim) {
  const v = []; let i = 0;
  while (v.length < dim) {
    const h = crypto.createHash('sha256').update(text + ':' + i).digest();
    for (let j = 0; j + 3 < h.length && v.length < dim; j += 4) v.push((h.readUInt32BE(j) / 0xFFFFFFFF) * 2 - 1);
    i++;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
function isStale(text, embText) {
  if (!embText) return true;
  const v = JSON.parse(embText), h = hashVector(text, v.length);
  return v.reduce((s, x, k) => s + x * h[k], 0) > 0.9999;
}
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embedBatch(key, texts, taskType) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
        { requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: String(t || ' ').slice(0, 8000) }] }, taskType, outputDimensionality: dimension })) },
        { headers: { 'x-goog-api-key': key }, timeout: 60000 }
      );
      return res.data.embeddings.map((e) => unit(e.values));
    } catch (err) {
      const status = err.response && err.response.status;
      if ((status === 429 || status >= 500) && attempt < 6) {
        const wait = 5000 * Math.pow(2, attempt);
        console.log(`   ${status} from Gemini — waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw new Error(`Gemini ${status || err.code}: ${err.response ? JSON.stringify(err.response.data).slice(0, 200) : err.message}`);
    }
  }
}

async function run(db, key, { label, rows, taskType, write }) {
  const todo = STALE_ONLY ? rows.filter((r) => isStale(r.text, r.emb)) : rows;
  console.log(`${label}: ${rows.length} rows, ${todo.length} to embed${STALE_ONLY ? ' (stale only)' : ''}`);
  if (!APPLY || !todo.length) return;
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const vecs = await embedBatch(key, chunk.map((r) => r.text), taskType);
    await db.query('BEGIN');
    try {
      for (let k = 0; k < chunk.length; k++) await write(chunk[k], `[${vecs[k].join(',')}]`);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    done += chunk.length;
    console.log(`   ${done}/${todo.length}`);
  }
}

(async () => {
  if (provider !== 'gemini') throw new Error(`EMBEDDING_PROVIDER is ${provider}; this backfill writes Gemini vectors`);
  const cred = resolveCredentials('gemini')[0];
  if (!cred) throw new Error('GEMINI_API_KEY is not set');
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} · ${model} @ ${dimension}d · db ${(process.env.DATABASE_URL.match(/@([^:/]+)/) || [])[1]}`);
  try {
    const k = await db.query(`SELECT k.knowledge_id, k.content AS text, ke.embedding_id, ke.embedding::text AS emb
      FROM knowledge k LEFT JOIN knowledge_embeddings ke ON ke.knowledge_id = k.knowledge_id ORDER BY k.created_at`);
    await run(db, cred.key, {
      label: 'knowledge_embeddings', rows: k.rows, taskType: 'RETRIEVAL_DOCUMENT',
      write: (r, vec) => r.embedding_id
        ? db.query('UPDATE knowledge_embeddings SET embedding = $1::vector WHERE embedding_id = $2', [vec, r.embedding_id])
        : db.query('INSERT INTO knowledge_embeddings (embedding_id, knowledge_id, embedding) VALUES ($1, $2, $3::vector)',
          [`emb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, r.knowledge_id, vec])
    });
    const s = await db.query('SELECT recipe_id, goal_pattern AS text, embedding::text AS emb FROM skill_recipes ORDER BY created_at');
    await run(db, cred.key, {
      label: 'skill_recipes', rows: s.rows, taskType: 'SEMANTIC_SIMILARITY',
      write: (r, vec) => db.query('UPDATE skill_recipes SET embedding = $1::vector WHERE recipe_id = $2', [vec, r.recipe_id])
    });
    // Hybrid recall (migration 063). The text must match what the live code
    // embeds — EntityGraph.embedMissingEntities and MemoryService.store — or
    // backfilled rows land in a slightly different place than new ones.
    const p = await db.query(`SELECT memory_id, content AS text, embedding::text AS emb FROM memories
      WHERE memory_type = 'procedural' ORDER BY created_at`);
    await run(db, cred.key, {
      label: 'memories (procedural)', rows: p.rows, taskType: 'RETRIEVAL_DOCUMENT',
      write: (r, vec) => db.query('UPDATE memories SET embedding = $1::vector WHERE memory_id = $2', [vec, r.memory_id])
    });
    const e = await db.query(`SELECT entity_id,
        canonical_name || ' (' || entity_type || ')' || CASE WHEN summary <> '' THEN ': ' || summary ELSE '' END AS text,
        embedding::text AS emb
      FROM entities WHERE status = 'active' AND user_id IS NOT NULL ORDER BY created_at`);
    await run(db, cred.key, {
      label: 'entities', rows: e.rows, taskType: 'RETRIEVAL_DOCUMENT',
      write: (r, vec) => db.query('UPDATE entities SET embedding = $1::vector WHERE entity_id = $2', [vec, r.entity_id])
    });
  } finally { await db.end(); }
  console.log(APPLY ? 'Done.' : 'Dry run only. Re-run with --apply to write.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
