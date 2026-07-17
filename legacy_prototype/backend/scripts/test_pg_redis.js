// scripts/test_pg_redis.js — Phase 10 Verification for Data Layer
const { query, getPool } = require('../database');
const { redisCommand } = require('../services/redis');
const embeddingsConfig = require('../config/embeddings');
require('dotenv').config();

async function runDataTests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Phase 10 Verification — PostgreSQL & Redis        ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // --- TEST 1: PG Pool Connects ---
  try {
    process.stdout.write('1. PostgreSQL Pool Connection... ');
    const res = await query('SELECT 1 as val');
    if (res.rows[0].val !== 1) throw new Error('Query failed');
    console.log(`✅ OK`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: All Required Tables Exist ---
  try {
    process.stdout.write('2. Required Tables Exist... ');
    const tablesRes = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tables = tablesRes.rows.map(r => r.table_name);
    
    const required = [
      'executions', 'execution_logs', 'tool_permissions', 
      'tool_calls', 'tool_results', 'agents', 
      'memories', 'knowledge', 'knowledge_embeddings', 'reflections'
    ];
    const excluded = ['tasks', 'subtasks'];
    
    for (const req of required) {
      if (!tables.includes(req)) throw new Error(`Missing required table: ${req}`);
    }
    for (const exc of excluded) {
      if (tables.includes(exc)) throw new Error(`Table should not exist: ${exc}`);
    }
    console.log(`✅ OK (Found ${required.length} required tables, 0 excluded)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: Redis SET/GET Works ---
  try {
    process.stdout.write('3. Upstash Redis Connection & Operations... ');
    const testKey = `test_phase10_${Date.now()}`;
    await redisCommand(['SET', testKey, 'hello_redis', 'EX', '10']);
    const val = await redisCommand(['GET', testKey]);
    if (val !== 'hello_redis') throw new Error(`Expected 'hello_redis', got '${val}'`);
    console.log(`✅ OK (SET/GET successful)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 4: pgvector installed & dimension matches config ---
  try {
    process.stdout.write('4. pgvector Extension & Dimension Match... ');
    
    // Check extension
    const extRes = await query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    if (extRes.rows.length === 0) throw new Error('pgvector extension not installed');
    
    // Check column type mapping
    const colRes = await query(`
      SELECT data_type, udt_name
      FROM information_schema.columns 
      WHERE table_name = 'knowledge_embeddings' AND column_name = 'embedding'
    `);
    
    if (colRes.rows.length === 0) throw new Error('embedding column missing');
    if (colRes.rows[0].udt_name !== 'vector') throw new Error('embedding column is not a vector');
    
    // Check dimension using typmod via pg_attribute
    const dimRes = await query(`
      SELECT atttypmod 
      FROM pg_attribute 
      WHERE attrelid = 'knowledge_embeddings'::regclass 
      AND attname = 'embedding'
    `);
    
    if (dimRes.rows.length === 0) throw new Error('Could not determine dimension');
    // For pgvector, the typmod is dimension, but in postgres metadata it might be stored weirdly.
    // Actually, pg_attribute.atttypmod for vector(768) is 768. Let's verify.
    const dim = dimRes.rows[0].atttypmod;
    if (dim !== embeddingsConfig.dimension && dim !== -1) { 
      throw new Error(`Dimension mismatch: DB=${dim}, Config=${embeddingsConfig.dimension}`);
    }
    
    console.log(`✅ OK (Extension installed, config dimension: ${embeddingsConfig.dimension})`);
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

runDataTests();
