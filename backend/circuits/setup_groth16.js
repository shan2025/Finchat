// circuits/setup_groth16.js — One-time trusted setup for AdminUnblock circuit
// Generates: Powers of Tau → Groth16 zkey → verification_key.json
const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');

const CIRCUITS_DIR = __dirname;
const R1CS = path.join(CIRCUITS_DIR, 'adminUnblock.r1cs');

async function setup() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║  FinChat ZKP — Groth16 Trusted Setup                 ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');

    const ptau0 = path.join(CIRCUITS_DIR, 'pot12_0000.ptau');
    const ptau1 = path.join(CIRCUITS_DIR, 'pot12_0001.ptau');
    const ptauFinal = path.join(CIRCUITS_DIR, 'pot12_final.ptau');
    const zkey0 = path.join(CIRCUITS_DIR, 'adminUnblock_0000.zkey');
    const zkeyFinal = path.join(CIRCUITS_DIR, 'adminUnblock_final.zkey');
    const vkPath = path.join(CIRCUITS_DIR, 'verification_key.json');

    // Step 1: New Powers of Tau ceremony (2^12 = 4096 constraints, enough for Poseidon)
    console.log('Step 1/6: Creating new Powers of Tau ceremony (2^12)...');
    const curve = await snarkjs.curves.getCurveFromName("bn128");
    await snarkjs.powersOfTau.newAccumulator(
        curve,
        12,
        ptau0
    );
    console.log('  ✅ Ceremony created\n');

    // Step 2: Contribute randomness
    console.log('Step 2/6: Contributing randomness to ceremony...');
    await snarkjs.powersOfTau.contribute(
        ptau0, ptau1,
        'FinChat Contribution',
        'finchat-entropy-' + Date.now() + '-' + Math.random().toString(36)
    );
    console.log('  ✅ Contribution applied\n');

    // Step 3: Prepare for phase 2
    console.log('Step 3/6: Preparing phase 2...');
    await snarkjs.powersOfTau.preparePhase2(ptau1, ptauFinal);
    console.log('  ✅ Phase 2 ready\n');

    // Step 4: Groth16 setup with the circuit
    console.log('Step 4/6: Running Groth16 setup with adminUnblock circuit...');
    await snarkjs.zKey.newZKey(R1CS, ptauFinal, zkey0);
    console.log('  ✅ Initial zkey generated\n');

    // Step 5: Contribute to zkey (phase 2 contribution)
    console.log('Step 5/6: Contributing to proving key...');
    await snarkjs.zKey.contribute(
        zkey0, zkeyFinal,
        'FinChat Phase 2',
        'finchat-phase2-' + Date.now() + '-' + Math.random().toString(36)
    );
    console.log('  ✅ Final proving key generated\n');

    // Step 6: Export verification key
    console.log('Step 6/6: Exporting verification key...');
    const vk = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
    fs.writeFileSync(vkPath, JSON.stringify(vk, null, 2));
    console.log('  ✅ Verification key exported\n');

    // Cleanup intermediate files
    for (const f of [ptau0, ptau1, zkey0]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║  Setup Complete!                                     ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  R1CS:             adminUnblock.r1cs                  ║`);
    console.log(`║  WASM:             adminUnblock_js/adminUnblock.wasm  ║`);
    console.log(`║  Proving Key:      adminUnblock_final.zkey            ║`);
    console.log(`║  Verification Key: verification_key.json              ║`);
    console.log(`║  Powers of Tau:    pot12_final.ptau                   ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');

    process.exit(0);
}

setup().catch(err => {
    console.error('❌ Setup failed:', err.message || err);
    process.exit(1);
});
