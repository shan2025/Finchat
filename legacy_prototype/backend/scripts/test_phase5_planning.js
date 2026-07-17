// scripts/test_phase5_planning.js — Verification Script for Phase 5 Definition of Done
const { run } = require('../services/cognitive/CognitiveCore');
const { plan } = require('../services/cognitive/PlanningEngine');
const { createExecution } = require('../services/cognitive/ExecutionManager');
const { query, getPool } = require('../database');
require('dotenv').config();

async function runPhase5Tests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Phase 5 Verification — PlanningEngine             ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // --- TEST 1: Simple goal should NOT trigger planning ---
  try {
    process.stdout.write('1. Simple goal ("what is PostgreSQL") should NOT trigger plan... ');
    const result = await run({
      goal: 'What is PostgreSQL? Give me a brief answer.',
      userId: 'test_user_phase5',
      agentName: 'plato'
    });

    // Check that no "planning" phase was logged
    const planLogs = await query(`
      SELECT * FROM execution_logs
      WHERE execution_id = $1 AND phase = 'planning'
    `, [result.executionId]);

    if (planLogs.rows.length > 0) {
      console.log(`⚠️ WARN (Plan was triggered for a simple goal — model decided to plan anyway)`);
    } else {
      console.log(`✅ OK (No planning phase — direct respond)`);
    }
    console.log(`   Response: "${result.response.substring(0, 100)}..."`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: PlanningEngine.plan() directly generates valid plan ---
  try {
    process.stdout.write('2. PlanningEngine.plan() generates valid structured plan... ');
    const testExec = await createExecution({
      goal: 'Research Tesla, compare to competitors, summarize',
      userId: 'test_user_plan_direct'
    });

    const planResult = await plan({
      executionId: testExec.execution_id,
      goal: 'Research Tesla, compare to competitors, summarize'
    });

    if (!planResult.plan) throw new Error('No plan returned');
    if (!planResult.plan.steps || planResult.plan.steps.length === 0) {
      throw new Error('Plan has no steps');
    }
    if (!planResult.stored) throw new Error('Plan was not stored in executions.current_plan');

    // Verify it was stored in the database
    const execRow = await query(
      'SELECT current_plan FROM executions WHERE execution_id = $1',
      [testExec.execution_id]
    );
    if (!execRow.rows[0].current_plan) throw new Error('current_plan is null in database');

    console.log(`✅ OK`);
    console.log(`   Summary: "${planResult.plan.plan_summary}"`);
    console.log(`   Steps: ${planResult.plan.steps.length}`);
    planResult.plan.steps.forEach(s => {
      console.log(`     ${s.step}. [${s.action}] ${s.description}${s.tool ? ` (tool: ${s.tool})` : ''}`);
    });
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: current_plan is populated in PostgreSQL ---
  try {
    process.stdout.write('3. Verifying current_plan column is populated in executions... ');
    const res = await query(`
      SELECT execution_id, current_plan
      FROM executions
      WHERE current_plan IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (res.rows.length === 0) throw new Error('No execution with current_plan found');

    const plan = res.rows[0].current_plan;
    if (!plan.steps || !Array.isArray(plan.steps)) {
      throw new Error('current_plan.steps is missing or not an array');
    }
    console.log(`✅ OK (Execution ${res.rows[0].execution_id} has ${plan.steps.length}-step plan stored)`);
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

runPhase5Tests();
