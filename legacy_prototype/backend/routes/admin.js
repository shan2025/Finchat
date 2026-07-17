// routes/admin.js — Admin user management + Hybrid ZKP-backed unblock
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateUnblockProof, verifyUnblockProof, verifyZKProof, getUnblockProofs } = require('../services/zkp');

router.use(requireAuth, requireRole('admin'));

// ── GET /api/admin/users ─────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const resUsers = await query(`
      SELECT user_id as id, name, email, role, wallet_address, auth_method,
             token_balance, is_frozen, created_at, last_login
      FROM users
      ORDER BY created_at DESC
    `);
    const users = resUsers.rows;

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
router.post('/unblock/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [userId]);
    const targetUser = resUser.rows[0];
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!targetUser.is_frozen) {
      return res.status(400).json({ error: 'User is not frozen', user: targetUser.name });
    }

    const zkpProof = await generateUnblockProof(req.user.id, userId, reason || 'Admin unblock');

    const recoveryTokens = 50;
    const newBalance = targetUser.token_balance + recoveryTokens;

    await query('UPDATE users SET token_balance = $1, is_frozen = 0 WHERE user_id = $2', [newBalance, userId]);

    await query(`
      INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
      VALUES ($1, $2, $3, $4, 'grant', $5)
    `, [
      uuidv4(),
      userId,
      recoveryTokens,
      newBalance,
      `Admin unblock by ${req.user.name} — Commitment: ${zkpProof.commitmentHash.substring(0, 16)}...`
    ]);

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
        nonce: zkpProof.nonce,
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
router.post('/unblock-all', async (req, res) => {
  try {
    const { reason } = req.body;
    const resFrozen = await query('SELECT *, user_id as id FROM users WHERE is_frozen = 1');
    const frozenUsers = resFrozen.rows;

    if (frozenUsers.length === 0) {
      return res.json({ success: true, message: 'No frozen users found', unblocked: 0 });
    }

    const results = [];
    const recoveryTokens = 50;

    for (const user of frozenUsers) {
      const zkpProof = await generateUnblockProof(req.user.id, user.id, reason || 'Bulk admin unblock');
      const newBalance = user.token_balance + recoveryTokens;

      await query('UPDATE users SET token_balance = $1, is_frozen = 0 WHERE user_id = $2', [newBalance, user.id]);
      await query(`
        INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
        VALUES ($1, $2, $3, $4, 'grant', $5)
      `, [uuidv4(), user.id, recoveryTokens, newBalance, `Bulk unblock — ZKP: ${zkpProof.commitmentHash.substring(0, 8)}...`]);

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
router.get('/unblock-proofs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const proofs = await getUnblockProofs(limit);
    res.json({ proofs, total: proofs.length });
  } catch (err) {
    console.error('Admin get proofs error:', err);
    res.status(500).json({ error: 'Failed to get unblock proofs' });
  }
});

// ── GET /api/admin/zkp-status/:proofId ───────────────────────
router.get('/zkp-status/:proofId', async (req, res) => {
  try {
    const { proofId } = req.params;
    const resProof = await query('SELECT zkp_verified, created_at FROM zkp_proofs WHERE proof_id = $1', [proofId]);
    const proof = resProof.rows[0];

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
router.post('/verify-proof/:proofId', async (req, res) => {
  try {
    const { proofId } = req.params;
    const { nonce } = req.body;
    const result = await verifyUnblockProof(proofId, nonce || null);
    res.json(result);
  } catch (err) {
    console.error('Admin verify proof error:', err);
    res.status(500).json({ error: 'Failed to verify proof' });
  }
});

module.exports = router;
