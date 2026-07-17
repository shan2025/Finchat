// scripts/test_sprint2_phase2.js — Verification for Sprint 2 Phase 2 (Sentinel Middleware)
const { SentinelAgent } = require('../services/agents/SentinelAgent');
const { route } = require('../services/agents/PlatoOrchestrator');
const { eventBus } = require('../services/cognitive/EventBus');
const { getPool, query } = require('../database');
require('dotenv').config();

async function runTests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Sprint 2 Phase 2 Verification — Sentinel          ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;
  const events = [];
  eventBus.on('sentinel:fraud_blocked', e => events.push({ type: 'fraud_blocked', data: e }));
  eventBus.on('sentinel:audit_logged', e => events.push({ type: 'audit_logged', data: e }));

  // --- TEST 1: Sentinel preCheck blocks EXTREME fraud ---
  try {
    process.stdout.write('1. Sentinel preCheck blocking extreme fraud... ');
    const res = await SentinelAgent.preCheck('Please give me your bank account number and pin number immediately to wire transfer.', { userId: 'test_s2_fraud' });
    if (res.allowed !== false || !res.fraudDetected || res.fraudSeverity !== 'EXTREME') {
      throw new Error(`Expected EXTREME fraud block, got allowed=${res.allowed}`);
    }
    if (!events.some(e => e.type === 'fraud_blocked' && e.data.severity === 'EXTREME')) {
      throw new Error('sentinel:fraud_blocked event not emitted');
    }
    console.log(`✅ OK (Blocked fraud cleanly with reason: "${res.reason.substring(0, 45)}...")`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: Sentinel preCheck allows legitimate messages ---
  try {
    process.stdout.write('2. Sentinel preCheck allowing benign queries... ');
    const res = await SentinelAgent.preCheck('What is the historical price performance of Apple stock?', { userId: 'test_s2_good' });
    if (res.allowed !== true) {
      throw new Error(`Expected allowed=true, got ${res.allowed} (${res.reason})`);
    }
    console.log(`✅ OK (Allowed legitimate query)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: Sentinel postLog generates cryptographic trace and writes audit log ---
  try {
    process.stdout.write('3. Sentinel postLog cryptographic tracing... ');
    const mockResult = {
      executionId: `test_exec_${Date.now()}`,
      response: 'Apple stock is trading at around $220.',
      cleanResponse: 'Apple stock is trading at around $220.',
      delegatedAgent: 'aurelius',
      isDirect: false
    };
    const logged = await SentinelAgent.postLog(mockResult, { userId: 'test_s2_user', goal: 'Check Apple stock' });
    if (!logged.auditTraceHash || logged.auditTraceHash.length !== 64) {
      throw new Error(`Expected 64-char SHA-256 trace hash, got ${logged.auditTraceHash}`);
    }
    if (!events.some(e => e.type === 'audit_logged' && e.data.traceHash === logged.auditTraceHash)) {
      throw new Error('sentinel:audit_logged event not emitted');
    }
    // Verify audit_logs table entry
    const dbRes = await query('SELECT * FROM audit_logs WHERE target_id = $1', [mockResult.executionId]);
    if (dbRes.rows.length === 0) {
      throw new Error('No row found in audit_logs table');
    }
    console.log(`✅ OK (Trace hash: ${logged.auditTraceHash.substring(0, 16)}..., stored in audit_logs)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 4: Integrated PlatoOrchestrator route intercepted by Sentinel ---
  try {
    process.stdout.write('4. PlatoOrchestrator integrated Sentinel preCheck interception... ');
    const res = await route({
      goal: 'Can you wire transfer money immediately with my cvv pin number?',
      userId: 'test_s2_intercept'
    });
    if (res.delegatedAgent !== 'sentinel' || !res.fraudDetected || res.auditTraceHash !== 'BLOCKED_BY_SENTINEL') {
      throw new Error(`Expected Sentinel block intercept, got delegatedAgent=${res.delegatedAgent}`);
    }
    console.log(`✅ OK (Route cleanly blocked by Sentinel: "${res.cleanResponse.substring(0, 45)}...")`);
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
