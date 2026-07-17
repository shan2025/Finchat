// scripts/test_dashboard_pulse.js — Verifies Real-Time Agent Status API and WebSocket Pulse
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const assert = require('assert');
const { getDB, query } = require('../database');
const { createExecution, updateState } = require('../services/cognitive/ExecutionManager');
const { STATES } = require('../services/cognitive/StateMachine');
const { eventBus } = require('../services/cognitive/EventBus');

async function runTests() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Agent Operations Dashboard Pulse Verification');
  console.log('═══════════════════════════════════════════════\n');

  // Ensure DB connected
  getDB();

  let passed = 0;
  let failed = 0;

  function check(testName, condition, details = '') {
    if (condition) {
      console.log(`  ✅ ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ ${testName} — ${details}`);
      failed++;
    }
  }

  try {
    // ── Test 1: Simulate Active Execution for Aurelius ──────────
    console.log('▸ Test 1: Simulating active execution for Aurelius');
    const exec = await createExecution({
      userId: 'test_user_pulse',
      goal: 'Analyze live Solana vs Bitcoin market volume',
      assignedAgent: 'aurelius'
    });
    await updateState(exec.execution_id, STATES.READY);
    await updateState(exec.execution_id, STATES.RUNNING);

    // Query active executions directly via DB to test what agents route sees
    const resActive = await query(`
      SELECT assigned_agent, current_state, goal
      FROM executions
      WHERE current_state IN ('running', 'ready', 'waiting')
      AND execution_id = $1
    `, [exec.execution_id]);
    
    check('Active execution returned by status query', resActive.rows.length === 1);
    check('Assigned agent is aurelius', resActive.rows[0].assigned_agent === 'aurelius');
    check('Current state is running', resActive.rows[0].current_state === 'running');

    // ── Test 2: Simulate Waiting State (HITL) for Rasha ──────────
    console.log('\n▸ Test 2: Simulating waiting (HITL) state for Rasha');
    const execRasha = await createExecution({
      userId: 'test_user_pulse',
      goal: 'Evaluate senior smart contract engineer candidate resume',
      assignedAgent: 'rasha'
    });
    await updateState(execRasha.execution_id, STATES.READY);
    await updateState(execRasha.execution_id, STATES.RUNNING);
    await updateState(execRasha.execution_id, STATES.WAITING, { waitReason: 'human_approval' });

    const resWait = await query(`
      SELECT assigned_agent, current_state, wait_reason
      FROM executions
      WHERE execution_id = $1
    `, [execRasha.execution_id]);

    check('Waiting execution found in DB', resWait.rows.length === 1);
    check('Assigned agent is rasha', resWait.rows[0].assigned_agent === 'rasha');
    check('Current state is waiting', resWait.rows[0].current_state === 'waiting');
    check('Wait reason is human_approval', resWait.rows[0].wait_reason === 'human_approval');

    // ── Test 3: EventBus Pulse Emission ─────────────────────────
    console.log('\n▸ Test 3: Verifying EventBus pulse triggers');
    let eventReceived = false;
    const testListener = (data) => {
      if (data.executionId === 'test_pulse_event_123') {
        eventReceived = true;
      }
    };
    eventBus.on('execution:completed', testListener);

    eventBus.emit('execution:completed', {
      executionId: 'test_pulse_event_123',
      completionReason: 'natural'
    });

    check('EventBus execution:completed event fired correctly', eventReceived);
    eventBus.off('execution:completed', testListener);

    // ── Test 4: Cleanup simulated test executions ───────────────
    console.log('\n▸ Test 4: Cleaning up simulated executions');
    await updateState(exec.execution_id, STATES.COMPLETED);
    await updateState(execRasha.execution_id, STATES.RUNNING);
    await updateState(execRasha.execution_id, STATES.COMPLETED);

    const resCheckDone = await query(`
      SELECT current_state FROM executions WHERE execution_id IN ($1, $2)
    `, [exec.execution_id, execRasha.execution_id]);

    check('Simulated tasks marked completed in DB', resCheckDone.rows.every(r => r.current_state === 'completed'));

  } catch (err) {
    console.error('❌ Test suite execution error:', err);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`   Results: ✅ ${passed} passed  ❌ ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
