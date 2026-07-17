// scripts/test_sprint2_phase3.js — Verification for Sprint 2 Phase 3 (Memory Taxonomy & MemoryAgent)
const { MemoryAgent } = require('../services/agents/MemoryAgent');
const memoryService = require('../services/cognitive/MemoryService');
const { getPool } = require('../database');
require('dotenv').config();

async function runTests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Sprint 2 Phase 3 Verification — Memory Taxonomy   ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;
  const memoryAgent = new MemoryAgent();

  // --- TEST 1: Procedural Memory Storage & Retrieval ---
  try {
    process.stdout.write('1. Procedural Workflow Storage & Recall... ');
    const stored = await memoryAgent.storeProcedural({
      agentId: 'aurelius',
      workflowName: 'Portfolio Rebalance Protocol',
      steps: ['Fetch ticker prices', 'Calculate sector allocation', 'Flag overweighted assets > 35%', 'Recommend rebalance trades']
    });
    if (!stored || stored.memoryType !== 'procedural') {
      throw new Error('Failed to store procedural workflow');
    }
    const recalled = await memoryAgent.recallProcedural({ agentId: 'aurelius' });
    if (!recalled || recalled.length === 0 || !recalled.some(p => p.content.includes('Portfolio Rebalance Protocol'))) {
      throw new Error('Failed to recall stored procedural workflow');
    }
    console.log(`✅ OK (Stored and recalled "${recalled[0].content.substring(0, 45)}...")`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: Episodic Memory Recall from executions table ---
  try {
    process.stdout.write('2. Episodic Recall over past completed executions... ');
    const history = await memoryAgent.recallEpisodic({ limit: 5 });
    if (!Array.isArray(history)) {
      throw new Error('Expected array of past executions');
    }
    console.log(`✅ OK (Recalled ${history.length} completed past episodes)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: Semantic Embedding & Similarity Search ---
  try {
    process.stdout.write('3. Semantic Embedding Storage & Similarity Search... ');
    const storedSem = await memoryService.storeWithEmbedding({
      title: 'Neuromorphic Computing Principles',
      content: 'Neuromorphic engineering mimics neuro-biological architectures present in the nervous system using spiking neural networks.'
    });
    if (!storedSem || !storedSem.stored) {
      throw new Error('Failed to store semantic entry');
    }
    const searchRes = await memoryAgent.recallSemantic({ queryText: 'spiking neural networks and neuromorphic AI' });
    if (!Array.isArray(searchRes) || searchRes.length === 0) {
      throw new Error('Semantic search returned empty results');
    }
    console.log(`✅ OK (Found matching semantic entry: "${searchRes[0].title}")`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 4: Memory Synthesis across Taxonomy ---
  try {
    process.stdout.write('4. Synthesis across Episodic, Semantic & Procedural memory layers... ');
    const synthesis = await memoryAgent.synthesizeHistory({
      userId: 'test_s2_user',
      goal: 'How should Aurelius rebalance my neuromorphic AI portfolio?',
      agentName: 'aurelius'
    });
    if (typeof synthesis.proceduralCount !== 'number' || typeof synthesis.semanticCount !== 'number') {
      throw new Error('Invalid synthesis structure');
    }
    if (synthesis.proceduralCount === 0 && synthesis.semanticCount === 0) {
      throw new Error('Expected synthesized content from semantic or procedural layers');
    }
    console.log(`✅ OK (Synthesized ${synthesis.episodicCount} episodic, ${synthesis.semanticCount} semantic, ${synthesis.proceduralCount} procedural memories)`);
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
