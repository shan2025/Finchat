// routes/tokens.js — Token balance, history, and top-up
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');

// ── GET /api/tokens/balance ─────────────────────────────────
router.get('/balance', requireAuth, (req, res) => {
    try {
        const db = getDB();
        const user = db.prepare('SELECT token_balance, is_frozen FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({
            balance: user.token_balance,
            frozen: !!user.is_frozen
        });
    } catch (err) {
        console.error('Token balance error:', err);
        res.status(500).json({ error: 'Failed to get balance' });
    }
});

// ── GET /api/tokens/history ─────────────────────────────────
router.get('/history', requireAuth, (req, res) => {
    try {
        const db = getDB();
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);

        const transactions = db.prepare(`
      SELECT id, amount, balance, type, reason, created_at
      FROM token_ledger
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(req.user.id, limit);

        res.json({ transactions });
    } catch (err) {
        console.error('Token history error:', err);
        res.status(500).json({ error: 'Failed to get history' });
    }
});

// ── POST /api/tokens/topup ──────────────────────────────────
// Simulated token purchase via Phantom wallet
router.post('/topup', requireAuth, (req, res) => {
    try {
        const { amount, walletAddress, tier } = req.body;

        // Validate tier
        const tiers = {
            small: { tokens: 100, sol: 0.01 },
            medium: { tokens: 500, sol: 0.05 },
            large: { tokens: 1000, sol: 0.10 }
        };

        const selectedTier = tiers[tier];
        if (!selectedTier) {
            return res.status(400).json({ error: 'Invalid tier. Use: small, medium, or large' });
        }

        if (!walletAddress) {
            return res.status(400).json({ error: 'Wallet address required' });
        }

        const db = getDB();
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const tokensToAdd = selectedTier.tokens;
        const newBalance = user.token_balance + tokensToAdd;

        // Update balance and unfreeze if frozen
        db.prepare('UPDATE users SET token_balance = ?, is_frozen = 0 WHERE id = ?')
            .run(newBalance, req.user.id);

        // Record in ledger
        db.prepare(`
      INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
      VALUES (?, ?, ?, ?, 'purchase', ?)
    `).run(
            uuidv4(),
            req.user.id,
            tokensToAdd,
            newBalance,
            `Token purchase: ${tier} tier (${selectedTier.sol} SOL) via Phantom wallet ${walletAddress.substring(0, 8)}...`
        );

        // Save wallet address if not already stored
        if (!user.wallet_address && walletAddress) {
            db.prepare('UPDATE users SET wallet_address = ? WHERE id = ?')
                .run(walletAddress.toLowerCase(), req.user.id);
        }

        console.log(`💰 Token top-up: ${user.name} +${tokensToAdd} tokens (${tier} tier) via ${walletAddress.substring(0, 8)}...`);

        res.json({
            success: true,
            tokensAdded: tokensToAdd,
            newBalance,
            tier: selectedTier,
            walletAddress
        });

    } catch (err) {
        console.error('Token top-up error:', err);
        res.status(500).json({ error: 'Token purchase failed' });
    }
});

// ── POST /api/tokens/unfreeze ───────────────────────────────
// Admin/self-service unfreeze (restores minimum tokens)
router.post('/unfreeze', requireAuth, (req, res) => {
    try {
        const db = getDB();
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.is_frozen) {
            return res.json({ message: 'Account is not frozen', balance: user.token_balance });
        }

        // Grant 50 recovery tokens
        const recoveryTokens = 50;
        const newBalance = user.token_balance + recoveryTokens;

        db.prepare('UPDATE users SET token_balance = ?, is_frozen = 0 WHERE id = ?')
            .run(newBalance, req.user.id);

        db.prepare(`
      INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
      VALUES (?, ?, ?, ?, 'grant', 'Account recovery — unfreeze grant')
    `).run(uuidv4(), req.user.id, recoveryTokens, newBalance);

        console.log(`🔓 Account unfrozen: ${user.name} +${recoveryTokens} recovery tokens`);

        res.json({
            success: true,
            message: 'Account unfrozen',
            tokensGranted: recoveryTokens,
            newBalance
        });
    } catch (err) {
        console.error('Unfreeze error:', err);
        res.status(500).json({ error: 'Failed to unfreeze account' });
    }
});

module.exports = router;
