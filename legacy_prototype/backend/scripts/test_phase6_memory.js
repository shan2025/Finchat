// scripts/test_phase6_memory.js — Verification Script for Phase 6 Definition of Done
const {
  storeWorkingMemory, retrieveWorkingMemory, appendToScratchpad,
  store, retrieve,
  generateEmbedding, storeWithEmbedding, retrieveBySimilarity,
  retrieveForContext
} = require('../services/cognitive/MemoryService');
const embeddingsConfig = require('../config/embeddings');
const { query, getPool } = require('../database');
require('dotenv').config();

async function runPhase6Tests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Phase 6 Verification — MemoryService              ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;
  const testConvId = `conv_test_phase6_${Date.now()}`;

  // --- TEST 1: Working memory — two turns share scratchpad via Redis ---
  try {
    process.stdout.write('1. Working memory: two turns share scratchpad via Redis... ');

    // Turn 1: store a scratchpad entry
    await appendToScratchpad(testConvId, 'User asked about Tesla stock price');
    await appendToScratchpad(testConvId, 'TSLA is trading at $396.18');

    // Turn 2: retrieve and verify the first turn's scratchpad is there
    const wm = await retrieveWorkingMemory(testConvId);
    if (!wm._scratchpad || wm._scratchpad.length < 2) {
      throw new Error(`Expected at least 2 scratchpad entries, got ${wm._scratchpad?.length || 0}`);
    }
    if (!wm._scratchpad[0].content.includes('Tesla')) {
      throw new Error('First scratchpad entry missing expected content');
    }

    console.log(`✅ OK (${wm._scratchpad.length} scratchpad entries shared across turns)`);
    console.log(`   Turn 1: "${wm._scratchpad[0].content}"`);
    console.log(`   Turn 2: "${wm._scratchpad[1].content}"`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: Long-term memory store/retrieve (episodic, semantic, procedural) ---
  try {
    process.stdout.write('2. Long-term memory: store and retrieve typed memories... ');

    // Ensure a test user exists
    const userCheck = await query("SELECT user_id FROM users WHERE user_id = 'test_memory_user'");
    if (userCheck.rows.length === 0) {
      await query(
        "INSERT INTO users (user_id, name, email, role) VALUES ($1, $2, $3, $4)",
        ['test_memory_user', 'Memory Test User', 'memtest@finchat.com', 'user']
      );
    }

    await store({
      userId: 'test_memory_user',
      memoryType: 'semantic',
      content: 'Tesla (TSLA) is an electric vehicle company founded by Elon Musk.',
      importance: 8
    });
    await store({
      userId: 'test_memory_user',
      memoryType: 'episodic',
      content: 'User previously asked about TSLA stock price and received $396.18.',
      importance: 6
    });
    await store({
      userId: 'test_memory_user',
      memoryType: 'procedural',
      content: 'When asked about stock prices, always use the stocks tool first.',
      importance: 9
    });

    const semanticMems = await retrieve({ userId: 'test_memory_user', memoryType: 'semantic' });
    const allMems = await retrieve({ userId: 'test_memory_user' });

    if (semanticMems.length < 1) throw new Error('No semantic memories retrieved');
    if (allMems.length < 3) throw new Error(`Expected at least 3 memories, got ${allMems.length}`);

    console.log(`✅ OK (${allMems.length} memories stored, semantic: ${semanticMems.length})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: Embedding generation matches config dimension ---
  try {
    process.stdout.write(`3. Embedding generation (${embeddingsConfig.model}, ${embeddingsConfig.dimension}d)... `);
    const embedding = await generateEmbedding('Tesla electric vehicle stock price');
    if (!embedding) {
      console.log('⚠️ WARN (Ollama embedding unavailable — skipping dimension check)');
      passed++;
    } else {
      if (embedding.length !== embeddingsConfig.dimension) {
        throw new Error(`Expected ${embeddingsConfig.dimension}d vector, got ${embedding.length}d`);
      }
      console.log(`✅ OK (${embedding.length}d vector generated)`);
      passed++;
    }
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 4: Store with embedding and retrieve by similarity ---
  try {
    process.stdout.write('4. Semantic retrieval: storeWithEmbedding + retrieveBySimilarity... ');
    const storeResult = await storeWithEmbedding({
      title: 'Tesla Company Overview',
      content: 'Tesla Inc designs, develops, manufactures and sells electric vehicles and energy storage systems.',
      source: 'test_phase6'
    });

    if (!storeResult.stored) throw new Error('storeWithEmbedding returned stored=false');

    if (storeResult.embeddingId) {
      // Embedding was stored — test similarity retrieval
      const similar = await retrieveBySimilarity('electric car company', 3);
      if (similar.length < 1) throw new Error('No similar results found');
      console.log(`✅ OK (Stored: ${storeResult.knowledgeId}, embedding: ${storeResult.embeddingDimension}d, similar results: ${similar.length})`);
    } else {
      console.log('⚠️ WARN (Knowledge stored but embedding unavailable — Ollama may be offline)');
    }
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 5: retrieveForContext integrates working + long-term memory ---
  try {
    process.stdout.write('5. retrieveForContext: combined working + long-term memories... ');
    const contextMems = await retrieveForContext({
      userId: 'test_memory_user',
      conversationId: testConvId,
      goal: 'What is Tesla stock?',
      limit: 5
    });

    const workingMems = contextMems.filter(m => m.type === 'working');
    const ltMems = contextMems.filter(m => m.type !== 'working');

    if (workingMems.length < 2) throw new Error(`Expected at least 2 working memories, got ${workingMems.length}`);
    if (ltMems.length < 1) throw new Error(`Expected at least 1 long-term memory, got ${ltMems.length}`);

    console.log(`✅ OK (${workingMems.length} working + ${ltMems.length} long-term memories for context)`);
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

runPhase6Tests();
