// routes/auth.js — Register, Login, Wallet auth, Profile
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, getPool } = require('../database');
const { requireAuth } = require('../middleware/auth');

const TOKEN_EXPIRY = '7d';

function generateJWT(userId) {
  const secret = process.env.JWT_SECRET || 'dev_finchat_secret_change_me';
  return jwt.sign({ userId }, secret, { expiresIn: TOKEN_EXPIRY });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, user_id, ...safe } = user;
  return { ...safe, id: user.id || user_id, avatar_url: user.avatar_url || null };
}

// ── POST /api/auth/register ─────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, walletAddress } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!email && !walletAddress)
      return res.status(400).json({ error: 'Email or wallet address required' });
    if (email && !password)
      return res.status(400).json({ error: 'Password required for email registration' });
    if (password && password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const validRoles = ['admin', 'staff', 'auditor', 'user'];
    const userRole = validRoles.includes(role) ? role : 'staff';

    // Check duplicates
    if (email) {
      const exists = await query('SELECT user_id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (exists.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });
    }
    if (walletAddress) {
      const exists = await query('SELECT user_id FROM users WHERE wallet_address = $1', [walletAddress.toLowerCase()]);
      if (exists.rows.length > 0) return res.status(409).json({ error: 'Wallet already registered' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const authMethod = walletAddress && password ? 'wallet+password'
      : walletAddress ? 'wallet' : 'password';

    const userId = uuidv4();
    await query(`
      INSERT INTO users (user_id, name, email, password_hash, role, wallet_address, auth_method, token_balance, is_frozen)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, 0)
    `, [
      userId,
      name,
      email?.toLowerCase() || null,
      passwordHash,
      userRole,
      walletAddress?.toLowerCase() || null,
      authMethod
    ]);

    // Initial token grant ledger entry
    try {
      await query(`
        INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
        VALUES ($1, $2, 1000, 1000, 'grant', 'Initial token grant on registration')
      `, [uuidv4(), userId]);
    } catch (ledgerErr) {
      console.error('Token ledger grant error (non-fatal):', ledgerErr.message);
    }

    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [userId]);
    const user = resUser.rows[0];
    const token = generateJWT(userId);

    console.log(`✅ Registered: ${name} (${userRole}) — ${email || walletAddress}`);
    res.status(201).json({ token, user: sanitizeUser(user) });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const resUser = await query('SELECT *, user_id as id FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = resUser.rows[0];

    if (!user || !user.password_hash)
      return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or password' });

    if (user.is_frozen)
      return res.status(403).json({ error: 'Account frozen — token balance depleted' });

    try {
      await query("UPDATE users SET last_login = NOW() WHERE user_id = $1", [user.id]);
    } catch (e) {
      console.error('Update last_login failed:', e.message);
    }

    const token = generateJWT(user.id);
    console.log(`✅ Login: ${user.name} (${user.role})`);
    res.json({ token, user: sanitizeUser(user) });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/forgot ────────────────────────────────────
router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const resUser = await query('SELECT user_id as id, email FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = resUser.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(resetCode, 12);
    const resetId = uuidv4();

    const resExp = await query(`SELECT (NOW() + interval '15 minutes')::text as expires`);
    const expiresAt = resExp.rows[0].expires;

    await query(`
      INSERT INTO password_resets (reset_id, user_id, code_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [resetId, user.id, codeHash, expiresAt]);

    console.log(`🔐 Password reset code for ${user.email}: ${resetCode} (valid until ${expiresAt})`);

    res.json({ message: 'Reset code generated' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Could not start password reset' });
  }
});

// ── POST /api/auth/reset ─────────────────────────────────────
router.post('/reset', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const resUser = await query('SELECT *, user_id as id FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = resUser.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const resReset = await query(`
      SELECT *, reset_id as id FROM password_resets
      WHERE user_id = $1 AND used = 0 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `, [user.id]);
    const reset = resReset.rows[0];

    if (!reset) {
      return res.status(400).json({ error: 'Reset code expired or not found' });
    }

    const valid = await bcrypt.compare(code, reset.code_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Incorrect reset code' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [newHash, user.id]);
      await client.query('UPDATE password_resets SET used = 1 WHERE reset_id = $1', [reset.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    console.log(`✅ Password reset for ${user.email}`);
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

// ── POST /api/auth/wallet ────────────────────────────────────
router.post('/wallet', async (req, res) => {
  try {
    const { walletAddress, role } = req.body;

    if (!walletAddress)
      return res.status(400).json({ error: 'Wallet address required' });

    const resUser = await query('SELECT *, user_id as id FROM users WHERE wallet_address = $1', [walletAddress.toLowerCase()]);
    let user = resUser.rows[0];

    if (!user) {
      const validRoles = ['admin', 'staff', 'auditor', 'user'];
      const userRole = validRoles.includes(role) ? role : 'user';
      const userId = uuidv4();
      const shortAddr = walletAddress.substring(0, 6) + '…' + walletAddress.slice(-4);

      await query(`
        INSERT INTO users (user_id, name, wallet_address, role, auth_method, token_balance, is_frozen)
        VALUES ($1, $2, $3, $4, 'wallet', 1000, 0)
      `, [userId, `Wallet User (${shortAddr})`, walletAddress.toLowerCase(), userRole]);

      await query(`
        INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
        VALUES ($1, $2, 1000, 1000, 'grant', 'Initial token grant — wallet login')
      `, [uuidv4(), userId]);

      const resNew = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [userId]);
      user = resNew.rows[0];
      console.log(`✅ Wallet registered: ${walletAddress.substring(0, 10)}… (${userRole})`);
    }

    await query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.id]);

    const token = generateJWT(user.id);
    res.json({ token, user: sanitizeUser(user) });

  } catch (err) {
    console.error('Wallet login error:', err);
    res.status(500).json({ error: 'Wallet login failed' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [req.user.id]);
  res.json({ user: sanitizeUser(resUser.rows[0]) });
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

// ── POST /api/auth/profile/avatar ────────────────────────────
router.post('/profile/avatar', requireAuth, async (req, res) => {
  try {
    const { avatarUrl } = req.body;
    if (!avatarUrl) {
      return res.status(400).json({ error: 'avatarUrl data is required' });
    }
    await query('UPDATE users SET avatar_url = $1 WHERE user_id = $2', [avatarUrl, req.user.id]);
    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Avatar updated', user: sanitizeUser(resUser.rows[0]) });
  } catch (err) {
    console.error('Avatar update error:', err);
    res.status(500).json({ error: 'Could not update avatar' });
  }
});

module.exports = router;
