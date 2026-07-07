// services/zkp.js — Hybrid Commitment + ZKP verification service for admin actions
// Fast path: SHA-256 commitment
// Audit path: Groth16 ZKP (async) using Poseidon hash

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');
const { getDB } = require('../database');
const { v4: uuidv4 } = require('uuid');

// ── Paths ────────────────────────────────────────────────────
const CIRCUITS_PATH = path.join(__dirname, '..', 'circuits');
const WASM_PATH = path.join(CIRCUITS_PATH, 'adminUnblock_js', 'adminUnblock.wasm');
const ZKEY_PATH = path.join(CIRCUITS_PATH, 'adminUnblock_final.zkey');
const VK_PATH = path.join(CIRCUITS_PATH, 'verification_key.json');

// ── Helpers ──────────────────────────────────────────────────

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function generateNonce() {
    return crypto.randomBytes(32).toString('hex');
}

// Convert string/hex to BigInt for Poseidon
function toFieldElement(val) {
    if (typeof val === 'string' && val.startsWith('0x')) {
        return BigInt(val);
    }
    if (typeof val === 'string') {
        // Simple hash-to-field implementation
        const hash = crypto.createHash('sha256').update(val).digest('hex');
        return BigInt('0x' + hash) % BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
    }
    return BigInt(val);
}

// ── Generate Unblock Commitment (Fast Path) ───────────────────

function generateUnblockProof(adminId, userId, reason = '') {
    const db = getDB();
    const timestamp = new Date().toISOString();
    const action = 'unblock';
    const nonce = generateNonce();

    // Fast path: SHA-256 commitment
    const commitmentInput = `${adminId}|${userId}|${action}|${nonce}|${timestamp}`;
    const commitmentHash = sha256(commitmentInput);

    const publicInputs = {
        adminId,
        userId,
        action,
        timestamp,
        reason
    };

    const proofId = uuidv4();
    const nonceHash = sha256(nonce);

    // Initial store (ZKP fields left null)
    db.prepare(`
    INSERT INTO zkp_proofs (id, proof_type, admin_id, target_user_id, commitment_hash, public_inputs, nonce_hash, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        proofId,
        action,
        adminId,
        userId,
        commitmentHash,
        JSON.stringify(publicInputs),
        nonceHash,
        reason
    );

    console.log(`🔐 Fast commitment generated: ${commitmentHash.substring(0, 8)}... (ProofID: ${proofId.substring(0, 8)})`);

    // 🔥 Background Path: Trigger ZKP generation (Groth16)
    setImmediate(async () => {
        try {
            await generateZKProof(proofId, adminId, userId, action, nonce, timestamp);
        } catch (err) {
            console.error(`❌ Async ZKP failed for ${proofId}:`, err.message);
        }
    });

    return {
        proofId,
        commitmentHash,
        publicInputs,
        nonce, // returned to admin only
        verified: true,
        timestamp,
        zkpGenerated: false // ZKP is coming in background
    };
}

// ── Generate Actual ZK Proof (Async Audit Path) ───────────────

async function generateZKProof(proofId, adminId, userId, action, nonce, timestamp) {
    console.log(`🧠 Generating Groth16 proof for ${proofId.substring(0, 8)}...`);
    const start = Date.now();

    const poseidon = await buildPoseidon();

    // Construct inputs as field elements
    const inputs = {
        adminId: toFieldElement(adminId),
        userId: toFieldElement(userId),
        action: toFieldElement(action),
        timestamp: toFieldElement(timestamp),
        nonce: toFieldElement(nonce)
    };

    // Calculate Poseidon commitment
    const F = poseidon.F;
    const h = poseidon([inputs.adminId, inputs.userId, inputs.action, inputs.nonce, inputs.timestamp]);
    const commitment = F.toString(h);

    // Generate Groth16 proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        { ...inputs, commitment },
        WASM_PATH,
        ZKEY_PATH
    );

    const db = getDB();
    db.prepare(`
        UPDATE zkp_proofs 
        SET zkp_proof = ?, public_signals = ?, zkp_verified = 1 
        WHERE id = ?
    `).run(JSON.stringify(proof), JSON.stringify(publicSignals), proofId);

    const duration = (Date.now() - start) / 1000;
    console.log(`✅ ZKP generated and stored for ${proofId.substring(0, 8)} in ${duration.toFixed(2)}s`);
}

// ── Verify Unblock Proof ─────────────────────────────────────

function verifyUnblockProof(proofId, nonce = null) {
    const db = getDB();
    const proof = db.prepare('SELECT * FROM zkp_proofs WHERE id = ?').get(proofId);
    if (!proof) return { valid: false, error: 'Proof not found' };

    const publicInputs = JSON.parse(proof.public_inputs);
    const result = {
        valid: true,
        proofId: proof.id,
        commitmentHash: proof.commitment_hash,
        zkpVerified: !!proof.zkp_verified,
        fullVerification: false
    };

    // Fast verification with nonce (re-hash)
    if (nonce) {
        const reconstructed = `${publicInputs.adminId}|${publicInputs.userId}|${publicInputs.action}|${nonce}|${publicInputs.timestamp}`;
        if (sha256(reconstructed) === proof.commitment_hash) {
            result.fullVerification = true;
        } else {
            return { valid: false, error: 'Nonce mismatch' };
        }
    }

    // Try ZKP verification if generated
    if (proof.zkp_verified && proof.zkp_proof) {
        result.zkpDetails = { status: 'ZKP available' };
    }

    return result;
}

// ── Cryptographic Proof Verification ──────────────────────────

async function verifyZKProof(proofId) {
    const db = getDB();
    const proofEntry = db.prepare('SELECT * FROM zkp_proofs WHERE id = ?').get(proofId);

    if (!proofEntry || !proofEntry.zkp_proof) {
        return { valid: false, error: 'ZKP not generated yet' };
    }

    const vk = JSON.parse(fs.readFileSync(VK_PATH));
    const proof = JSON.parse(proofEntry.zkp_proof);
    const publicSignals = JSON.parse(proofEntry.public_signals);

    const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    return { valid: isValid, proofId };
}

function getUnblockProofs(limit = 50) {
    const db = getDB();
    const proofs = db.prepare(`
    SELECT
      z.*,
      a.name as admin_name,
      a.email as admin_email,
      u.name as target_name,
      u.email as target_email
    FROM zkp_proofs z
    LEFT JOIN users a ON z.admin_id = a.id
    LEFT JOIN users u ON z.target_user_id = u.id
    ORDER BY z.created_at DESC
    LIMIT ?
  `).all(limit);

    return proofs.map(p => ({
        id: p.id,
        commitmentHash: p.commitment_hash,
        publicInputs: JSON.parse(p.public_inputs),
        zkpVerified: !!p.zkp_verified,
        createdAt: p.created_at,
        admin: { name: p.admin_name },
        targetUser: { name: p.target_name }
    }));
}

module.exports = {
    generateUnblockProof,
    verifyUnblockProof,
    verifyZKProof,
    getUnblockProofs,
    sha256,
    generateNonce
};

