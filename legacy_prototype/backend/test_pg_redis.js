// test_pg_redis.js — Verification script for Phase 0 & Phase 1 (Database, Redis, and Cognitive Core Schema)
const { query, getPool } = require('./database');
const { setWorkingMemory, getWorkingMemory, cacheSet, cacheGet } = require('./services/redis');
const { runInference } = require('./services/inference');
const { determineDelegationTarget } = require('./services/supervisor');
const embeddingsConfig = require('./config/embeddings');
require('dotenv').config();

async function runTests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Phase 0 & Phase 1 Verification Suite (Supabase)   ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // 1. Test PostgreSQL Connection & Table Expiry Check
  try {
    process.stdout.write('1. Testing Supabase PostgreSQL Connection... ');
    const res = await query('SELECT now() as time');
    console.log(`✅ OK (${res.rows[0].time})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 2. Verify Schema Tables (including goals, excluding tasks/subtasks)
  try {
    process.stdout.write('2. Verifying Cognitive Core Schema Tables... ');
    const tablesRes = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tables = tablesRes.rows.map(r => r.table_name);
    
    const requiredTables = ['users', 'goals', 'executions', 'execution_logs', 'knowledge_embeddings', 'pgmigrations'];
    const forbiddenTables = ['tasks', 'subtasks'];

    const missing = requiredTables.filter(t => !tables.includes(t));
    const presentForbidden = forbiddenTables.filter(t => tables.includes(t));

    if (missing.length > 0) {
      throw new Error(`Missing required tables: ${missing.join(', ')}`);
    }
    if (presentForbidden.length > 0) {
      throw new Error(`Found forbidden tables (should have been dropped per Decision #1): ${presentForbidden.join(', ')}`);
    }
    console.log(`✅ OK (All required tables exist: ${requiredTables.join(', ')} | No tasks/subtasks)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 3. Verify pgvector extension and knowledge_embeddings vector dimension matches config/embeddings.js (768)
  try {
    process.stdout.write('3. Verifying pgvector & knowledge_embeddings column dimension... ');
    const colRes = await query(`
      SELECT format_type(atttypid, atttypmod) as col_type
      FROM pg_attribute
      WHERE attrelid = 'knowledge_embeddings'::regclass AND attname = 'embedding'
    `);
    if (colRes.rows.length === 0) {
      throw new Error('embedding column not found on knowledge_embeddings table');
    }
    const colType = colRes.rows[0].col_type;
    const expectedDim = embeddingsConfig.dimension || 768;
    if (!colType.includes(`vector(${expectedDim})`)) {
      throw new Error(`Expected column type vector(${expectedDim}), got ${colType}`);
    }
    console.log(`✅ OK (${colType} matches config/embeddings.js dimension ${expectedDim})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 4. Test Upstash Redis working memory & caching
  try {
    process.stdout.write('4. Testing Redis working memory & cache client... ');
    const testExecId = 'test-verification-exec';
    await setWorkingMemory(testExecId, { status: 'verified', timestamp: Date.now() }, 60);
    const retrieved = await getWorkingMemory(testExecId);
    if (retrieved.status !== 'verified') {
      throw new Error('Working memory retrieval mismatch');
    }
    await cacheSet('test_key', { foo: 'bar' }, 60);
    const cached = await cacheGet('test_key');
    if (!cached || cached.foo !== 'bar') {
      throw new Error('Cache retrieval mismatch');
    }
    console.log('✅ OK (Working Memory and Cache SET/GET verified)');
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 5. Test Plato Supervisor Delegation Routing
  try {
    process.stdout.write('5. Testing Plato Supervisor Delegation Routing... ');
    const target1 = determineDelegationTarget('Could you analyze this startup seed investment opportunity?');
    const target2 = determineDelegationTarget('Can you review my resume and job skills?');
    const target3 = determineDelegationTarget('What is the capital of France?');
    
    if (target1 !== 'aurelius' || target2 !== 'rasha' || target3 !== null) {
      throw new Error(`Delegation routing mismatch: target1=${target1}, target2=${target2}, target3=${target3}`);
    }
    console.log('✅ OK (Plato routes correctly: finance->aurelius, career->rasha, direct->plato)');
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  console.log('\n═════════════════════════════════════════════════════════════');
  console.log(`Summary: ${passed} Passed | ${failed} Failed`);
  console.log('═════════════════════════════════════════════════════════════');

  const pool = getPool();
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
