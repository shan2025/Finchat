// scripts/test_sprint2_phase4.js — Verification for Sprint 2 Phase 4 (BullMQ Background Workers)
const { enqueueExecutionJob, getJobStatus, startWorkerPool, shutdownWorkerPool } = require('../services/queue/WorkerPool');
require('dotenv').config();

async function runTests() {
  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║   FinChat Sprint 2 Phase 4 Verification — BullMQ Workers    ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  // --- TEST 1: Enqueue Job ---
  let testJobId = null;
  try {
    process.stdout.write('1. Enqueueing cognitive chat job into BullMQ... ');
    const jobInfo = await enqueueExecutionJob({
      personaId: 'plato',
      userMessage: 'What is the philosophy of AI governance?',
      options: { userId: 'test_s2_worker' }
    });
    if (!jobInfo || !jobInfo.jobId || jobInfo.queueName !== 'cognitive-executions') {
      throw new Error('Failed to enqueue job properly');
    }
    testJobId = jobInfo.jobId;
    console.log(`✅ OK (Enqueued job #${testJobId}, state: ${jobInfo.state})`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 2: Poll Initial Job Status ---
  try {
    process.stdout.write('2. Polling initial job status... ');
    const status = await getJobStatus(testJobId);
    if (!status || status.jobId !== testJobId) {
      throw new Error('Could not fetch job status');
    }
    console.log(`✅ OK (Job #${status.jobId} state is "${status.state}")`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  // --- TEST 3: Start Worker Pool & Process Job ---
  try {
    process.stdout.write('3. Starting Worker pool & processing background job... ');
    startWorkerPool(2);

    // Poll until job completes or fails (timeout after 45s)
    let finished = false;
    let finalStatus = null;
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 1000));
      finalStatus = await getJobStatus(testJobId);
      if (finalStatus && (finalStatus.state === 'completed' || finalStatus.state === 'failed')) {
        finished = true;
        break;
      }
    }

    if (!finished) {
      throw new Error('Worker timed out processing job after 45 seconds');
    }
    if (finalStatus.state === 'failed') {
      throw new Error(`Worker failed job processing: ${finalStatus.failedReason}`);
    }
    if (!finalStatus.result || !finalStatus.result.processedByWorker) {
      throw new Error('Result missing processedByWorker flag');
    }

    console.log(`✅ OK (Job #${testJobId} completed in ${finalStatus.result.workerDurationMs || 'N/A'}ms)`);
    passed++;
  } catch (err) {
    console.log(`❌ FAILED: ${err.message}`);
    failed++;
  }

  console.log('\n═════════════════════════════════════════════════════════════');
  console.log(`Summary: ${passed} Passed | ${failed} Failed`);
  console.log('═════════════════════════════════════════════════════════════');

  await shutdownWorkerPool();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
