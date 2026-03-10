// routes/auth.js — Register, Login, Wallet auth, Profile
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');

const TOKEN_EXPIRY = '7d';

function generateJWT(userId) {
  const secret = process.env.JWT_SECRET || 'dev_finchat_secret_change_me';
  return jwt.sign({ userId }, secret, { expiresIn: TOKEN_EXPIRY });
}

function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
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

    const db = getDB();

    // Check duplicates
    if (email) {
      const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      if (exists) return res.status(409).json({ error: 'Email already registered' });
    }
    if (walletAddress) {
      const exists = db.prepare('SELECT id FROM users WHERE wallet_address = ?').get(walletAddress.toLowerCase());
      if (exists) return res.status(409).json({ error: 'Wallet already registered' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const authMethod = walletAddress && password ? 'wallet+password'
      : walletAddress ? 'wallet' : 'password';

    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, wallet_address, auth_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      name,
      email?.toLowerCase() || null,
      passwordHash,
      userRole,
      walletAddress?.toLowerCase() || null,
      authMethod
    );

    // Initial token grant ledger entry (best-effort, non-fatal on error)
    try {
      db.prepare(`
        INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
        VALUES (?, ?, 1000, 1000, 'grant', 'Initial token grant on registration')
      `).run(uuidv4(), userId);
    } catch (ledgerErr) {
      console.error('Token ledger grant error (non-fatal):', ledgerErr.message);
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
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

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

    if (!user || !user.password_hash)
      return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or password' });

    if (user.is_frozen)
      return res.status(403).json({ error: 'Account frozen — token balance depleted' });

    // Update last login
    // Update last login (non-fatal)
    try {
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
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

    const db = getDB();
    const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email.toLowerCase());

    if (!user) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(resetCode, 12);
    const resetId = uuidv4();

    // Expire in 15 minutes
    const expiresAt = db.prepare(`SELECT datetime('now', '+15 minutes') as expires`).get().expires;

    db.prepare(`
      INSERT INTO password_resets (id, user_id, code_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(resetId, user.id, codeHash, expiresAt);

    // In production: send email. For now, log to server console.
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

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const reset = db.prepare(`
      SELECT * FROM password_resets
      WHERE user_id = ? AND used = 0 AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(user.id);

    if (!reset) {
      return res.status(400).json({ error: 'Reset code expired or not found' });
    }

    const valid = await bcrypt.compare(code, reset.code_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Incorrect reset code' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(newHash, user.id);

      db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?')
        .run(reset.id);
    });
    tx();

    console.log(`✅ Password reset for ${user.email}`);
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

// ── POST /api/auth/wallet ────────────────────────────────────
// Wallet-only login (Phantom wallet)
router.post('/wallet', async (req, res) => {
  try {
    const { walletAddress, role } = req.body;

    if (!walletAddress)
      return res.status(400).json({ error: 'Wallet address required' });

    const db = getDB();
    let user = db.prepare('SELECT * FROM users WHERE wallet_address = ?')
      .get(walletAddress.toLowerCase());

    // Auto-register wallet users on first login
    if (!user) {
      const validRoles = ['admin', 'staff', 'auditor', 'user'];
      const userRole = validRoles.includes(role) ? role : 'user';
      const userId = uuidv4();
      const shortAddr = walletAddress.substring(0, 6) + '…' + walletAddress.slice(-4);

      db.prepare(`
        INSERT INTO users (id, name, wallet_address, role, auth_method)
        VALUES (?, ?, ?, ?, 'wallet')
      `).run(userId, `Wallet User (${shortAddr})`, walletAddress.toLowerCase(), userRole);

      db.prepare(`
        INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
        VALUES (?, ?, 1000, 1000, 'grant', 'Initial token grant — wallet login')
      `).run(uuidv4(), userId);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      console.log(`✅ Wallet registered: ${walletAddress.substring(0, 10)}… (${userRole})`);
    }

    db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);

    const token = generateJWT(user.id);
    res.json({ token, user: sanitizeUser(user) });

  } catch (err) {
    console.error('Wallet login error:', err);
    res.status(500).json({ error: 'Wallet login failed' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: sanitizeUser(user) });
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  // In production: invalidate token in a blacklist / Redis cache
  res.json({ message: 'Logged out' });
});

module.exports = router;
