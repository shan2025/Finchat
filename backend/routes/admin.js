// routes/admin.js — Admin user management + ZKP-backed unblock
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateUnblockProof, verifyUnblockProof, getUnblockProofs } = require('../services/zkp');

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

        // Generate ZKP proof for this unblock action
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
            `Admin unblock by ${req.user.name} — ZKP proof: ${zkpProof.commitmentHash.substring(0, 16)}...`
        );

        console.log(`🔓 Admin ${req.user.name} unblocked ${targetUser.name} — ZKP: ${zkpProof.commitmentHash.substring(0, 16)}...`);

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
                timestamp: zkpProof.timestamp
            }
        });
    } catch (err) {
        console.error('Admin unblock error:', err);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// ── POST /api/admin/unblock-all ──────────────────────────────
// Bulk unblock all frozen users with individual ZKP proofs
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
            // Generate individual ZKP proof for each unblock
            const zkpProof = generateUnblockProof(
                req.user.id,
                user.id,
                reason || 'Bulk admin unblock'
            );

            const newBalance = user.token_balance + recoveryTokens;

            db.prepare('UPDATE users SET token_balance = ?, is_frozen = 0 WHERE id = ?')
                .run(newBalance, user.id);

            db.prepare(`
        INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
        VALUES (?, ?, ?, ?, 'grant', ?)
      `).run(
                uuidv4(),
                user.id,
                recoveryTokens,
                newBalance,
                `Bulk admin unblock by ${req.user.name} — ZKP: ${zkpProof.commitmentHash.substring(0, 16)}...`
            );

            results.push({
                userId: user.id,
                name: user.name,
                email: user.email,
                newBalance,
                zkpCommitment: zkpProof.commitmentHash
            });
        }

        console.log(`🔓 Admin ${req.user.name} bulk-unblocked ${results.length} users`);

        res.json({
            success: true,
            message: `Unblocked ${results.length} users`,
            unblocked: results.length,
            users: results
        });
    } catch (err) {
        console.error('Admin bulk unblock error:', err);
        res.status(500).json({ error: 'Failed to bulk unblock users' });
    }
});

// ── GET /api/admin/unblock-proofs ────────────────────────────
// Get all ZKP unblock proofs for audit
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

// ── POST /api/admin/verify-proof/:proofId ────────────────────
// Verify a specific ZKP proof (optionally with nonce for full verification)
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
