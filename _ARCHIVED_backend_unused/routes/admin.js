// routes/admin.js — Admin user management + Hybrid ZKP-backed unblock
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateUnblockProof, verifyUnblockProof, verifyZKProof, getUnblockProofs } = require('../services/zkp');

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// ── GET /api/admin/users ─────────────────────────────────────
// List all registered users with status info
router.get('/users', (req, res) => {
    try {
        const db = getDB();
        const users = db.prepare(`
      SELECT id, name, email, role, wallet_address, auth_method,
             token_balance, is_frozen, created_at, last_login
      FROM users
      ORDER BY created_at DESC
    `).all();

        res.json({
            users: users.map(u => ({
                ...u,
                is_frozen: !!u.is_frozen
            })),
            total: users.length,
            frozen: users.filter(u => u.is_frozen).length
        });
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: 'Failed to list users' });
    }
});

// ── POST /api/admin/unblock/:userId ──────────────────────────
// Unblock a specific frozen user with ZKP proof generation
router.post('/unblock/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;
        const db = getDB();

        const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!targetUser.is_frozen) {
            return res.status(400).json({ error: 'User is not frozen', user: targetUser.name });
        }

        // Generate hybrid ZKP proof for this unblock action
        // (Starts async Groth16 generation in background)
        const zkpProof = generateUnblockProof(req.user.id, userId, reason || 'Admin unblock');

        // Unfreeze the user and grant recovery tokens
        const recoveryTokens = 50;
        const newBalance = targetUser.token_balance + recoveryTokens;

        db.prepare('UPDATE users SET token_balance = ?, is_frozen = 0 WHERE id = ?')
            .run(newBalance, userId);

        // Record in token ledger
        db.prepare(`
      INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
      VALUES (?, ?, ?, ?, 'grant', ?)
    `).run(
            uuidv4(),
            userId,
            recoveryTokens,
            newBalance,
            `Admin unblock by ${req.user.name} — Commitment: ${zkpProof.commitmentHash.substring(0, 16)}...`
        );

        console.log(`🔓 Admin ${req.user.name} unblocked ${targetUser.name} — Commitment: ${zkpProof.commitmentHash.substring(0, 8)}...`);

        res.json({
            success: true,
            message: `User ${targetUser.name} has been unblocked`,
            user: {
                id: targetUser.id,
                name: targetUser.name,
                email: targetUser.email,
                newBalance,
                tokensGranted: recoveryTokens
            },
            zkpProof: {
                proofId: zkpProof.proofId,
                commitmentHash: zkpProof.commitmentHash,
                publicInputs: zkpProof.publicInputs,
                nonce: zkpProof.nonce, // Admin receives the nonce for their records
                timestamp: zkpProof.timestamp,
                zkpStatus: 'generating'
            }
        });
    } catch (err) {
        console.error('Admin unblock error:', err);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// ── POST /api/admin/unblock-all ──────────────────────────────
router.post('/unblock-all', (req, res) => {
    try {
        const { reason } = req.body;
        const db = getDB();
        const frozenUsers = db.prepare('SELECT * FROM users WHERE is_frozen = 1').all();

        if (frozenUsers.length === 0) {
            return res.json({ success: true, message: 'No frozen users found', unblocked: 0 });
        }

        const results = [];
        const recoveryTokens = 50;

        for (const user of frozenUsers) {
            const zkpProof = generateUnblockProof(req.user.id, user.id, reason || 'Bulk admin unblock');
            const newBalance = user.token_balance + recoveryTokens;

            db.prepare('UPDATE users SET token_balance = ?, is_frozen = 0 WHERE id = ?').run(newBalance, user.id);
            db.prepare(`
                INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
                VALUES (?, ?, ?, ?, 'grant', ?)
            `).run(uuidv4(), user.id, recoveryTokens, newBalance, `Bulk unblock — ZKP: ${zkpProof.commitmentHash.substring(0, 8)}...`);

            results.push({
                userId: user.id,
                name: user.name,
                zkpCommitment: zkpProof.commitmentHash
            });
        }

        res.json({ success: true, message: `Unblocked ${results.length} users`, unblocked: results.length, users: results });
    } catch (err) {
        console.error('Admin bulk unblock error:', err);
        res.status(500).json({ error: 'Failed to bulk unblock users' });
    }
});

// ── GET /api/admin/unblock-proofs ────────────────────────────
router.get('/unblock-proofs', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const proofs = getUnblockProofs(limit);
        res.json({ proofs, total: proofs.length });
    } catch (err) {
        console.error('Admin get proofs error:', err);
        res.status(500).json({ error: 'Failed to get unblock proofs' });
    }
});

// ── GET /api/admin/zkp-status/:proofId ───────────────────────
// Check if the actual ZKP has been generated for a commitment
router.get('/zkp-status/:proofId', (req, res) => {
    try {
        const { proofId } = req.params;
        const db = getDB();
        const proof = db.prepare('SELECT zkp_verified, created_at FROM zkp_proofs WHERE id = ?').get(proofId);

        if (!proof) return res.status(404).json({ error: 'Proof not found' });

        res.json({
            proofId,
            zkpGenerated: !!proof.zkp_verified,
            createdAt: proof.created_at
        });
    } catch (err) {
        console.error('Admin ZKP status error:', err);
        res.status(500).json({ error: 'Failed to check ZKP status' });
    }
});

// ── POST /api/admin/verify-zkp/:proofId ──────────────────────
// Perform actual Groth16 cryptographic verification
router.post('/verify-zkp/:proofId', async (req, res) => {
    try {
        const { proofId } = req.params;
        const result = await verifyZKProof(proofId);
        res.json({
            success: result.valid,
            proofId: result.proofId,
            mechanism: 'Groth16 (Poseidon)',
            message: result.valid ? 'Cryptographic proof verified successfully' : 'Proof verification failed'
        });
    } catch (err) {
        console.error('Admin verify ZKP error:', err);
        res.status(500).json({ error: 'Verification failed - ZKP may still be generating' });
    }
});

// ── POST /api/admin/verify-proof/:proofId ────────────────────
// Verify a specific commitment (legacy/fast path helper)
router.post('/verify-proof/:proofId', (req, res) => {
    try {
        const { proofId } = req.params;
        const { nonce } = req.body;
        const result = verifyUnblockProof(proofId, nonce || null);
        res.json(result);
    } catch (err) {
        console.error('Admin verify proof error:', err);
        res.status(500).json({ error: 'Failed to verify proof' });
    }
});

module.exports = router;
