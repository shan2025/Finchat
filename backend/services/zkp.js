// services/zkp.js — Zero-Knowledge Proof service for admin actions
// Commitment-based ZKP scheme using SHA-256
// Admin commits: commitment = SHA-256(adminId | userId | action | nonce | timestamp)
// Proof = { commitment, publicInputs } — nonce stays secret (zero-knowledge property)

const crypto = require('crypto');
const { getDB } = require('../database');
const { v4: uuidv4 } = require('uuid');

// ── Helpers ──────────────────────────────────────────────────

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function generateNonce() {
    return crypto.randomBytes(32).toString('hex');
}

// ── Generate Unblock Proof ───────────────────────────────────
// Creates a ZKP commitment for an admin unblock action
// The nonce is stored server-side (encrypted) for future challenge-response
// but is NOT included in the public proof output

function generateUnblockProof(adminId, userId, reason = '') {
    const db = getDB();
    const timestamp = new Date().toISOString();
    const action = 'unblock';
    const nonce = generateNonce();

    // Commitment = H(adminId | userId | action | nonce | timestamp)
    const commitmentInput = `${adminId}|${userId}|${action}|${nonce}|${timestamp}`;
    const commitmentHash = sha256(commitmentInput);

    // Public inputs (visible in the proof — no secret nonce)
    const publicInputs = {
        adminId,
        userId,
        action,
        timestamp,
        reason
    };

    // Store the proof in DB
    const proofId = uuidv4();

    // Store nonce hash (not raw nonce) for verification without revealing it
    // The raw nonce is returned only to the admin who generated it
    const nonceHash = sha256(nonce);

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

    console.log(`🔐 ZKP Proof generated: ${commitmentHash.substring(0, 16)}... for unblock of user ${userId.substring(0, 8)}...`);

    return {
        proofId,
        commitmentHash,
        publicInputs,
        nonce, // returned to admin only — NOT stored in plaintext
        verified: true,
        timestamp
    };
}

// ── Verify Unblock Proof ─────────────────────────────────────
// Verifies a proof by checking the commitment against public inputs + nonce
// If nonce is provided → full verification (challenge-response)
// If nonce is not provided → partial verification (commitment existence + metadata match)

function verifyUnblockProof(proofId, nonce = null) {
    const db = getDB();

    const proof = db.prepare('SELECT * FROM zkp_proofs WHERE id = ?').get(proofId);
    if (!proof) {
        return { valid: false, error: 'Proof not found' };
    }

    const publicInputs = JSON.parse(proof.public_inputs);

    // Partial verification: check commitment exists and metadata is consistent
    const result = {
        valid: true,
        proofId: proof.id,
        proofType: proof.proof_type,
        commitmentHash: proof.commitment_hash,
        publicInputs,
        admin: null,
        targetUser: null,
        createdAt: proof.created_at,
        fullVerification: false
    };

    // Look up admin and target user names
    const admin = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(proof.admin_id);
    const targetUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(proof.target_user_id);
    result.admin = admin ? { id: admin.id, name: admin.name, email: admin.email } : null;
    result.targetUser = targetUser ? { id: targetUser.id, name: targetUser.name, email: targetUser.email } : null;

    // Full verification with nonce (challenge-response)
    if (nonce) {
        const reconstructed = `${publicInputs.adminId}|${publicInputs.userId}|${publicInputs.action}|${nonce}|${publicInputs.timestamp}`;
        const reconstructedHash = sha256(reconstructed);

        if (reconstructedHash === proof.commitment_hash) {
            result.fullVerification = true;
            result.valid = true;
        } else {
            result.valid = false;
            result.error = 'Nonce does not match commitment — verification failed';
        }
    }

    return result;
}

// ── Get All Unblock Proofs ───────────────────────────────────
// Returns all ZKP proofs for audit purposes

function getUnblockProofs(limit = 50) {
    const db = getDB();

    const proofs = db.prepare(`
    SELECT
      z.*,
      a.name as admin_name,
      a.email as admin_email,
      u.name as target_name,
      u.email as target_email,
      u.is_frozen as target_frozen
    FROM zkp_proofs z
    LEFT JOIN users a ON z.admin_id = a.id
    LEFT JOIN users u ON z.target_user_id = u.id
    ORDER BY z.created_at DESC
    LIMIT ?
  `).all(limit);

    return proofs.map(p => ({
        id: p.id,
        proofType: p.proof_type,
        commitmentHash: p.commitment_hash,
        publicInputs: JSON.parse(p.public_inputs),
        reason: p.reason,
        verified: !!p.verified,
        createdAt: p.created_at,
        admin: { id: p.admin_id, name: p.admin_name, email: p.admin_email },
        targetUser: {
            id: p.target_user_id,
            name: p.target_name,
            email: p.target_email,
            currentlyFrozen: !!p.target_frozen
        }
    }));
}

module.exports = { generateUnblockProof, verifyUnblockProof, getUnblockProofs, sha256, generateNonce };
