// scripts/test_sprint2_phase1.js — Verification for Sprint 2 Phase 1 (Agent Registry & Thick Agents)
const { getAllAgentConfigs, getAgentConfig, listActiveAgents, findBestAgent } = require('../services/agents/AgentRegistry');
const { BaseAgent } = require('../services/agents/BaseAgent');
const { route } = require('../services/agents/PlatoOrchestrator');
const { chatWithPersona } = require('../services/aiChat');
const { getPool } = require('../database');
require('dotenv').config();

async function runTests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Sprint 2 Phase 1 Verification — Agent Registry    ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // --- TEST 1: AgentRegistry loads from database & Upstash Redis cache ---
  try {
    process.stdout.write('1. AgentRegistry getAllAgentConfigs & Redis cache... ');
    const configs = await getAllAgentConfigs();
    if (!configs || configs.length < 6) {
      throw new Error(`Expected at least 6 agents, got ${configs ? configs.length : 0}`);
    }
    const rasha = await getAgentConfig('rasha');
    if (!rasha || rasha.name !== 'Rasha' || !rasha.capabilities.includes('resume')) {
      throw new Error('Rasha config invalid or missing capabilities');
    }
    if (rasha.memoryNamespace !== 'rasha::career') {
      throw new Error(`Expected namespace rasha::career, got ${rasha.memoryNamespace}`);
    }
    console.log(`✅ OK (Loaded ${configs.length} agents)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: Capability scoring and findBestAgent ---
  try {
    process.stdout.write('2. Capability scoring & specialist matching... ');
    const match = await findBestAgent('Could you review my resume and job application?');
    if (!match || match.agentConfig.agentId !== 'rasha') {
      throw new Error(`Expected rasha, got ${match ? match.agentConfig.agentId : 'null'}`);
    }
    const financeMatch = await findBestAgent('What is the current ticker price of TSLA and Bitcoin?');
    if (!financeMatch || financeMatch.agentConfig.agentId !== 'aurelius') {
      throw new Error(`Expected aurelius, got ${financeMatch ? financeMatch.agentConfig.agentId : 'null'}`);
    }
    console.log(`✅ OK (Matched Rasha and Aurelius accurately)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: BaseAgent Thick Factory (`fromRegistry`) ---
  try {
    process.stdout.write('3. BaseAgent thick factory fromRegistry... ');
    const nova = await BaseAgent.fromRegistry('nova');
    if (!nova || nova.agentId !== 'nova' || nova.memoryNamespace !== 'nova::research') {
      throw new Error('Nova thick agent factory failed');
    }
    console.log(`✅ OK (Instantiated ${nova.name} with namespace ${nova.memoryNamespace})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 4: Dual-Entry direct addressing via @agent prefix in aiChat.js ---
  try {
    process.stdout.write('4. Dual-Entry direct addressing (@rasha prefix)... ');
    const res = await chatWithPersona('plato', '@rasha how do I improve my cover letter and interview skills?', [], { userId: 'test_s2_u1' });
    if (res.delegatedAgent !== 'rasha') {
      throw new Error(`Expected delegatedAgent to be rasha, got ${res.delegatedAgent}`);
    }
    if (!res.isDirect) {
      throw new Error('Expected isDirect to be true');
    }
    console.log(`✅ OK (Directly routed to ${res.delegatedAgent}, response: "${res.cleanResponse.substring(0, 40)}...")`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 5: Indirect Plato routing (fallback to capability match) ---
  try {
    process.stdout.write('5. Indirect Plato routing (capability match without @prefix)... ');
    const res = await chatWithPersona('plato', 'Could you do a scientific paper research on neuromorphic AI architecture?', [], { userId: 'test_s2_u2' });
    if (res.delegatedAgent !== 'nova') {
      throw new Error(`Expected delegatedAgent to be nova, got ${res.delegatedAgent}`);
    }
    if (res.isDirect) {
      throw new Error('Expected isDirect to be false for indirect routing');
    }
    console.log(`✅ OK (Indirectly routed to ${res.delegatedAgent}, response: "${res.cleanResponse.substring(0, 40)}...")`);
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
