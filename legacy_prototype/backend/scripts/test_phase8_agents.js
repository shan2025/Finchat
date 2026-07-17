// scripts/test_phase8_agents.js — Verification Script for Phase 8 Definition of Done
const { route, findBestAgent } = require('../services/agents/PlatoOrchestrator');
const { eventBus } = require('../services/cognitive/EventBus');
const { getPool } = require('../database');
require('dotenv').config();

async function runPhase8Tests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Phase 8 Verification — Thin Agents & Routing      ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // Track delegation events
  const delegations = [];
  eventBus.on('execution:delegated', (evt) => delegations.push(evt));

  // --- TEST 1: "review my resume" routes to Career (Rasha), not hardcoded ---
  try {
    process.stdout.write('1. "review my resume" routes to Career agent (Rasha)... ');
    const match = findBestAgent('Can you review my resume and suggest improvements?');
    if (!match) throw new Error('No agent matched — should route to Rasha');
    if (match.agent.agentId !== 'rasha') {
      throw new Error(`Routed to "${match.agent.agentId}" instead of "rasha"`);
    }
    console.log(`✅ OK (matched: ${match.agent.name}, score: ${match.score})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: "what's TSLA trading at" routes to Finance (Aurelius) ---
  try {
    process.stdout.write('2. "what is TSLA stock price" routes to Finance (Aurelius)... ');
    const match = findBestAgent('What is TSLA stock price today?');
    if (!match) throw new Error('No agent matched — should route to Aurelius');
    if (match.agent.agentId !== 'aurelius') {
      throw new Error(`Routed to "${match.agent.agentId}" instead of "aurelius"`);
    }
    console.log(`✅ OK (matched: ${match.agent.name}, score: ${match.score})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: "explain neuroscience of memory" routes to Research (Nova) ---
  try {
    process.stdout.write('3. "explain neuroscience of memory" routes to Research (Nova)... ');
    const match = findBestAgent('Explain the neuroscience of memory formation');
    if (!match) throw new Error('No agent matched — should route to Nova');
    if (match.agent.agentId !== 'nova') {
      throw new Error(`Routed to "${match.agent.agentId}" instead of "nova"`);
    }
    console.log(`✅ OK (matched: ${match.agent.name}, score: ${match.score})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 4: Unmatched goal falls back to Plato ---
  try {
    process.stdout.write('4. "tell me a joke" falls back to Plato (no specialist match)... ');
    const match = findBestAgent('Tell me a funny joke about cats');
    if (match !== null) {
      throw new Error(`Should have returned null (Plato fallback), got "${match.agent.agentId}" with score ${match.score}`);
    }
    console.log('✅ OK (no specialist match — Plato handles it)');
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 5: Full route() execution with a career goal ---
  try {
    process.stdout.write('5. Full route() for "help me write a cover letter"... ');
    const result = await route({
      goal: 'Help me write a cover letter for a software engineering job',
      userId: 'test_user_phase8'
    });

    if (result.delegatedTo !== 'rasha') {
      throw new Error(`Expected delegation to "rasha", got "${result.delegatedTo}"`);
    }

    console.log(`✅ OK`);
    console.log(`   Delegated to: ${result.delegatedTo} (score: ${result.delegationScore})`);
    console.log(`   Response: "${result.response.substring(0, 100)}..."`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 6: Full route() with unmatched goal falls back to Plato ---
  try {
    process.stdout.write('6. Full route() for unmatched goal falls back to Plato... ');
    const result = await route({
      goal: 'What is the meaning of life?',
      userId: 'test_user_phase8_fallback'
    });

    if (result.delegatedTo !== 'plato') {
      throw new Error(`Expected fallback to "plato", got "${result.delegatedTo}"`);
    }

    console.log(`✅ OK (Plato handled directly, no delegation)`);
    console.log(`   Response: "${result.response.substring(0, 100)}..."`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 7: EventBus received execution:delegated event ---
  try {
    process.stdout.write('7. Verifying execution:delegated events on EventBus... ');
    // Allow time for async events
    await new Promise(r => setTimeout(r, 500));
    if (delegations.length < 1) {
      throw new Error('No execution:delegated events received');
    }
    const d = delegations[0];
    console.log(`✅ OK (${delegations.length} delegations: ${d.fromAgent} -> ${d.toAgent}, score=${d.matchScore})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  console.log('\n═════════════════════════════════════════════════════════════');
  console.log(`Summary: ${passed} Passed | ${failed} Failed`);
  console.log('═════════════════════════════════════════════════════════════');

  // Wait for any fire-and-forget reflections before closing pool
  await new Promise(r => setTimeout(r, 5000));
  const pool = getPool();
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

runPhase8Tests();
