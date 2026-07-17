// scripts/test_phase2_state_machine.js — Verification Script for Phase 2 Definition of Done
const {
  createExecution,
  getExecution,
  updateState,
  completeExecution,
  failExecution,
  checkBudget,
  incrementUsage
} = require('../services/cognitive/ExecutionManager');
const { STATES, IllegalTransitionError, stateMachineEvents } = require('../services/cognitive/StateMachine');
const { getPool } = require('../database');
require('dotenv').config();

async function runPhase2Tests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Phase 2 Verification — StateMachine & Budgets     ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // Track event emissions
  const eventsReceived = [];
  stateMachineEvents.on('execution:state_changed', (evt) => {
    eventsReceived.push(evt);
  });

  let execId = null;

  // 1. Create Execution & verify budget defaults per Decision #2
  try {
    process.stdout.write('1. Creating Execution & verifying budget defaults... ');
    const created = await createExecution({
      goal: 'Test Phase 2 StateMachine and budget tracking',
      userId: 'verifier_user'
    });
    execId = created.execution_id;
    if (
      created.current_state !== STATES.CREATED ||
      created.max_iterations !== 8 ||
      created.max_tool_calls !== 5 ||
      created.max_tokens !== 5000 ||
      created.max_runtime_seconds !== 60 ||
      created.iterations_used !== 0
    ) {
      throw new Error(`Unexpected creation state or defaults: ${JSON.stringify(created)}`);
    }
    console.log(`✅ OK (${execId} | defaults: 8 / 5 / 5000 / 60s)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 2. Cycle through legal state transitions per Decision #3
  try {
    process.stdout.write('2. Testing legal state transition sequence... ');
    await updateState(execId, STATES.READY);
    await updateState(execId, STATES.RUNNING);
    await updateState(execId, STATES.WAITING, { waitReason: 'tool_response' });
    await updateState(execId, STATES.RUNNING);
    const completed = await completeExecution(execId, { result: 'Phase 2 verification success' });

    if (completed.current_state !== STATES.COMPLETED || completed.result !== 'Phase 2 verification success') {
      throw new Error(`Failed sequence end state: ${completed.current_state}`);
    }
    console.log('✅ OK (created -> ready -> running -> waiting -> running -> completed)');
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 3. Test illegal transition rejection
  try {
    process.stdout.write('3. Testing rejection of illegal transition (completed -> running)... ');
    let threwIllegal = false;
    try {
      await updateState(execId, STATES.RUNNING);
    } catch (err) {
      if (err instanceof IllegalTransitionError || err.name === 'IllegalTransitionError') {
        threwIllegal = true;
      } else {
        throw new Error(`Unexpected error type thrown: ${err.message}`);
      }
    }
    if (!threwIllegal) {
      throw new Error('Allowed transition out of terminal state COMPLETED');
    }
    console.log('✅ OK (IllegalTransitionError caught correctly)');
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 4. Test initial checkBudget (not breached) and incrementUsage
  try {
    process.stdout.write('4. Testing budget check (not breached) & usage counter increment... ');
    const initialCheck = await checkBudget(execId);
    if (initialCheck.breached !== false) {
      throw new Error('checkBudget returned breached=true before ceiling reached');
    }

    const updated = await incrementUsage(execId, { iterations: 3, toolCalls: 2, tokens: 450 });
    if (updated.iterations_used !== 3 || updated.tool_calls_used !== 2 || updated.tokens_used !== 450) {
      throw new Error(`Usage increment mismatch: ${JSON.stringify(updated)}`);
    }
    console.log('✅ OK (checkBudget false | incrementUsage updated to 3 iterations, 2 tools, 450 tokens)');
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 5. Test forced budget breach per Decision #2
  try {
    process.stdout.write('5. Testing checkBudget ceiling breach after incrementing past max_iterations... ');
    await incrementUsage(execId, { iterations: 10 }); // total iterations_used = 13 (max=8)
    const breachCheck = await checkBudget(execId);
    if (breachCheck.breached !== true || breachCheck.reason !== 'budget_exceeded') {
      throw new Error(`checkBudget failed to detect breach: ${JSON.stringify(breachCheck)}`);
    }
    if (!breachCheck.details.iterations.breached) {
      throw new Error('Details did not flag iterations as breached');
    }
    console.log(`✅ OK (Breach detected! reason="${breachCheck.reason}", iterations_used=${breachCheck.details.iterations.used}/8)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // 6. Verify EventBus / EventEmitter notifications
  try {
    process.stdout.write('6. Verifying execution:state_changed events emitted... ');
    if (eventsReceived.length < 5) {
      throw new Error(`Expected at least 5 state_changed events, received ${eventsReceived.length}`);
    }
    console.log(`✅ OK (${eventsReceived.length} state transition events recorded cleanly)`);
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

runPhase2Tests();
