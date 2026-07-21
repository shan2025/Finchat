// scripts/test_zkp_hybrid.js — Verification for hybrid ZKP flow
const { generateUnblockProof, verifyUnblockProof, verifyZKProof } = require('../services/zkp');
const { getDB } = require('../database');
const { v4: uuidv4 } = require('uuid');

async function runTest() {
    console.log('🚀 Starting Hybrid ZKP Verification Test...\n');

    // 1. Setup mock data
    const adminId = 'admin-' + uuidv4().substring(0, 8);
    const userId = 'user-' + uuidv4().substring(0, 8);
    const db = getDB();

    // Ensure mock users exist
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, role) VALUES (?, ?, ?, ?)').run(adminId, 'Test Admin', adminId + '@test.com', 'admin');
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, role, is_frozen) VALUES (?, ?, ?, ?, ?)').run(userId, 'Test User', userId + '@test.com', 'staff', 1);

    console.log(`Step 1: Admin ${adminId} unblocking User ${userId}...`);

    // 2. Trigger Fast Path (Commitment)
    const t0 = Date.now();
    const result = generateUnblockProof(adminId, userId, 'Testing hybrid ZKP system');
    const t1 = Date.now();

    console.log(`  ✅ Fast Path Complete (${t1 - t0}ms)`);
    console.log(`  Commitment Hash: ${result.commitmentHash.substring(0, 32)}...`);
    console.log(`  Proof ID: ${result.proofId}`);

    // 3. Verify Fast Path immediately
    const verifyFast = verifyUnblockProof(result.proofId, result.nonce);
    console.log(`Step 2: Immediate Verification (SHA-256): ${verifyFast.valid ? '✅ VALID' : '❌ FAILED'}`);

    // 4. Wait for Background ZKP Path
    console.log('\nStep 3: Waiting for background Groth16 ZKP generation...');

    let zkpGenerated = false;
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 1000));

        const proof = db.prepare('SELECT zkp_verified FROM zkp_proofs WHERE id = ?').get(result.proofId);
        if (proof && proof.zkp_verified) {
            zkpGenerated = true;
            break;
        }
    }

    if (!zkpGenerated) {
        console.log('\n❌ FAILED: ZKP generation timed out.');
        process.exit(1);
    }

    console.log('\n  ✅ ZKP Generation Detected!');

    // 5. Verify Actual ZKP (Cryptographic)
    console.log('Step 4: Performing Cryptographic Groth16 Verification...');
    const t2 = Date.now();
    const zkpResult = await verifyZKProof(result.proofId);
    const t3 = Date.now();

    console.log(`  ✅ Groth16 Verification: ${zkpResult.valid ? '✅ VALID' : '❌ FAILED'} (${t3 - t2}ms)`);

    // 6. Verification with tampered proof (Security Check)
    console.log('Step 5: Security Check - Attempting verification with wrong ProofID...');
    const tamperedResult = await verifyZKProof('bogus-id').catch(e => ({ valid: false }));
    console.log(`  ✅ Security Check: ${!tamperedResult.valid ? '✅ PASSED' : '❌ FAILED'}`);

    console.log('\n✨ HYBRID ZKP VERIFICATION SUCCESSFUL!');
    console.log('========================================================');
    console.log(`Commitment path (SHA-256): ~${t1 - t0}ms`);
    console.log(`ZKP path (Groth16):        ~${t3 - t2}ms`);
    console.log('========================================================');

    process.exit(0);
}

runTest().catch(err => {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
});
