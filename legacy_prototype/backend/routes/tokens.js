// routes/tokens.js — Token balance, history, and top-up
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const { requireAuth, clearUserCache } = require('../middleware/auth');

// ── GET /api/tokens/balance ─────────────────────────────────
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const resUser = await query('SELECT token_balance, is_frozen FROM users WHERE user_id = $1', [req.user.id]);
    const user = resUser.rows[0];
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
router.get('/history', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const resTx = await query(`
      SELECT ledger_id as id, amount, balance, type, reason, created_at
      FROM token_ledger
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [req.user.id, limit]);

    res.json({ transactions: resTx.rows });
  } catch (err) {
    console.error('Token history error:', err);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// ── POST /api/tokens/topup ──────────────────────────────────
router.post('/topup', requireAuth, async (req, res) => {
  try {
    const { amount, walletAddress, tier } = req.body;

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

    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [req.user.id]);
    const user = resUser.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tokensToAdd = selectedTier.tokens;
    const newBalance = user.token_balance + tokensToAdd;

    await query('UPDATE users SET token_balance = $1, is_frozen = 0 WHERE user_id = $2', [newBalance, req.user.id]);
    clearUserCache(req.user.id);

    await query(`
      INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
      VALUES ($1, $2, $3, $4, 'purchase', $5)
    `, [
      uuidv4(),
      req.user.id,
      tokensToAdd,
      newBalance,
      `Token purchase: ${tier} tier (${selectedTier.sol} SOL) via Phantom wallet ${walletAddress.substring(0, 8)}...`
    ]);

    if (!user.wallet_address && walletAddress) {
      await query('UPDATE users SET wallet_address = $1 WHERE user_id = $2', [walletAddress.toLowerCase(), req.user.id]);
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
router.post('/unfreeze', requireAuth, async (req, res) => {
  try {
    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [req.user.id]);
    const user = resUser.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.is_frozen) {
      return res.json({ message: 'Account is not frozen', balance: user.token_balance });
    }

    const recoveryTokens = 50;
    const newBalance = user.token_balance + recoveryTokens;

    await query('UPDATE users SET token_balance = $1, is_frozen = 0 WHERE user_id = $2', [newBalance, req.user.id]);
    clearUserCache(req.user.id);

    await query(`
      INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
      VALUES ($1, $2, $3, $4, 'grant', 'Account recovery — unfreeze grant')
    `, [uuidv4(), req.user.id, recoveryTokens, newBalance]);

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
