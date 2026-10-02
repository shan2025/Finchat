// scripts/memory_health.js — read-only health check of the memory stores.
// Usage: node scripts/memory_health.js [DATABASE_URL|NEW_DATABASE_URL]
// Every query runs inside a
// READ ONLY transaction that is rolled back, so nothing can be written.
const path = require('path');
const BACKEND = path.join(__dirname, '..');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules/pg'));

const which = process.argv[2] || 'DATABASE_URL';
const Q = {
  tables: `SELECT relname, n_live_tup FROM pg_stat_user_tables
           WHERE relname IN ('memories','knowledge','knowledge_embeddings','entities','entity_edges','node_events',
             'skill_recipes','graph_insights','reflections','graph_communities','entity_links','executions','ai_chat_messages')
           ORDER BY relname`,
  ext: `SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm')`,
  vecIdx: `SELECT tablename, indexname, indexdef FROM pg_indexes
           WHERE indexdef ILIKE '%vector%' OR indexdef ILIKE '%hnsw%' OR indexdef ILIKE '%ivfflat%' OR indexdef ILIKE '%gin%'`,
  knowledgeCols: `SELECT table_name, column_name, data_type FROM information_schema.columns
           WHERE table_name IN ('knowledge','knowledge_embeddings','skill_recipes','memories') ORDER BY table_name, ordinal_position`,
  embedCoverage: `SELECT (SELECT count(*) FROM knowledge) AS knowledge_rows,
                         (SELECT count(DISTINCT knowledge_id) FROM knowledge_embeddings) AS knowledge_with_vec,
                         (SELECT count(*) FROM skill_recipes) AS recipes,
                         (SELECT count(*) FROM skill_recipes WHERE embedding IS NOT NULL) AS recipes_with_vec`,
  // A hash stand-in has near-uniform magnitude and no semantic neighbours; real
  // vectors from one model cluster. Check norms and count exact-duplicate vectors.
  vecNorms: `SELECT round(min(vector_norm(embedding))::numeric,3) mn, round(max(vector_norm(embedding))::numeric,3) mx,
                    count(*) n, count(DISTINCT embedding::text) distinct_vecs FROM knowledge_embeddings`,
  recentEmbeds: `SELECT date_trunc('day', k.created_at)::date d, count(*) rows, count(ke.knowledge_id) with_vec
                 FROM knowledge k LEFT JOIN knowledge_embeddings ke USING (knowledge_id)
                 WHERE k.created_at > now() - interval '21 days' GROUP BY 1 ORDER BY 1 DESC`,
  nnSanity: `WITH s AS (SELECT knowledge_id, embedding FROM knowledge_embeddings ORDER BY random() LIMIT 5)
             SELECT s.knowledge_id, (SELECT round((ke.embedding <=> s.embedding)::numeric,3) FROM knowledge_embeddings ke
                     WHERE ke.knowledge_id <> s.knowledge_id ORDER BY ke.embedding <=> s.embedding LIMIT 1) AS nearest_other
             FROM s`,
  entities: `SELECT count(*) total, count(*) FILTER (WHERE status='active') active,
                    count(*) FILTER (WHERE user_id IS NULL) no_owner,
                    count(*) FILTER (WHERE length(canonical_name) <= 3) short_names,
                    count(DISTINCT user_id) owners FROM entities`,
  edges: `SELECT edge_type, count(*) n, count(*) FILTER (WHERE user_id IS NULL) no_owner,
                 round(avg(strength)::numeric,2) avg_str, max(weight) max_w
          FROM entity_edges GROUP BY edge_type ORDER BY n DESC`,
  edgesRecent: `SELECT source, count(*) n, count(*) FILTER (WHERE user_id IS NULL) no_owner
          FROM entity_edges WHERE updated_at > now() - interval '30 days' GROUP BY source ORDER BY n DESC`,
  crossUserEdges: `SELECT count(*) FROM entity_edges e JOIN entities f ON f.entity_id=e.from_entity_id
          JOIN entities t ON t.entity_id=e.to_entity_id WHERE f.user_id IS DISTINCT FROM t.user_id`,
  orphanEdges: `SELECT count(*) FROM entity_edges e WHERE NOT EXISTS (SELECT 1 FROM entities x WHERE x.entity_id=e.from_entity_id)
          OR NOT EXISTS (SELECT 1 FROM entities x WHERE x.entity_id=e.to_entity_id)`,
  edgesToMerged: `SELECT count(*) FROM entity_edges e JOIN entities x ON x.entity_id IN (e.from_entity_id,e.to_entity_id) WHERE x.status='merged'`,
  dupNames: `SELECT count(*) FROM (SELECT user_id, lower(canonical_name) FROM entities WHERE status='active'
          GROUP BY 1,2 HAVING count(*)>1) d`,
  shortNameSample: `SELECT canonical_name, entity_type, count(*) n FROM entities WHERE status='active' AND length(canonical_name)<=3
          GROUP BY 1,2 ORDER BY n DESC LIMIT 15`,
  prefs: `SELECT count(*) prefers_edges, count(DISTINCT user_id) users FROM entity_edges WHERE edge_type='prefers'`,
  memories: `SELECT memory_type, count(*) n, count(DISTINCT user_id) users, max(created_at)::date latest,
                    count(*) FILTER (WHERE content LIKE '%Reflection parsing failed%') parse_fail
             FROM memories GROUP BY 1 ORDER BY n DESC`,
  insights: `SELECT kind, status, count(*) FROM graph_insights GROUP BY 1,2 ORDER BY 1,2`,
  lastDream: `SELECT max(created_at) FROM graph_insights WHERE kind='dream_report'`,
  communities: `SELECT count(*) n, max(updated_at) latest FROM graph_communities`,
  nodeEvents: `SELECT event_type, count(*) FROM node_events GROUP BY 1 ORDER BY 2 DESC`,
  lastIngest: `SELECT max(created_at) FROM node_events WHERE event_type IN ('created','mentioned')`,
  recipeDist: `SELECT r.recipe_id, (SELECT round(min(r.embedding <=> o.embedding)::numeric,3) FROM skill_recipes o
           WHERE o.recipe_id<>r.recipe_id AND o.embedding IS NOT NULL) nearest FROM skill_recipes r WHERE r.embedding IS NOT NULL
           ORDER BY random() LIMIT 6`,
};

(async () => {
  const c = new Client({ connectionString: process.env[which], ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  await c.query("SET LOCAL statement_timeout = '30s'");
  for (const [k, sql] of Object.entries(Q)) {
    try {
      await c.query('SAVEPOINT s');
      const r = await c.query(sql);
      console.log(`\n## ${k}`); console.table(r.rows);
      await c.query('RELEASE SAVEPOINT s');
    } catch (e) { console.log(`\n## ${k}: ERROR ${e.message}`); await c.query('ROLLBACK TO SAVEPOINT s'); }
  }
  await c.query('ROLLBACK'); await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });

