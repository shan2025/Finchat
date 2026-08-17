// routes/auth.js — Register, Login, Google, Wallet auth, Password reset, Profile
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, getPool } = require('../database');
const { requireAuth, clearUserCache } = require('../middleware/auth');
const usernames = require('../services/usernames');
const google = require('../services/googleAuth');
const { sendEmail, channelConfigStatus } = require('../services/notificationChannels');

// render.yaml has always declared JWT_EXPIRES_IN, but nothing read it: the
// lifetime was hardcoded here, so changing the variable did nothing.
const TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || '7d';

function generateJWT(userId) {
  // No fallback secret. This used to sign with a literal committed to the
  // repository whenever JWT_SECRET was unset — while middleware/auth.js and the
  // Socket.io handshake verify against process.env.JWT_SECRET with no fallback,
  // so the two halves disagreed and every token minted that way was unusable.
  // server.js refuses to boot without the variable, so reaching here means it
  // is set.
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, user_id, ...safe } = user;
  return { ...safe, id: user.id || user_id, avatar_url: user.avatar_url || null };
}

// Every client-fixable failure names the input that caused it. The login and
// signup forms attach the message to that field instead of firing an alert(),
// which is why "Email already registered" used to arrive as a modal with no
// indication of which box to go fix.
function fail(res, status, code, error, field = null) {
  return res.status(status).json({ error, code, ...(field ? { field } : {}) });
}

// ── GET /api/auth/config ─────────────────────────────────────
// Public. Lets the login and signup pages render only the providers this
// deployment can actually complete, so "Continue with Google" is never a button
// that exists purely to apologise for itself.
router.get('/config', (req, res) => {
  res.json({
    google: {
      enabled: google.isConfigured(),
      clientId: google.isConfigured() ? google.clientId() : null
    },
    passwordReset: {
      // Reset codes go out over the notification e-mail channel. Without SMTP
      // credentials the flow cannot deliver, and the form should say so up
      // front rather than after the user has typed their address.
      enabled: Boolean(channelConfigStatus().email)
    },
    username: { min: usernames.MIN, max: usernames.MAX }
  });
});

// ── GET /api/auth/username-available?u=… ─────────────────────
// Public, and deliberately so: it runs while the signup field is being typed,
// before any account exists. It reveals whether a handle is taken, which is the
// entire point of a handle — unlike the e-mail endpoints, there is nothing to
// enumerate here that the eventual 409 would not also reveal.
router.get('/username-available', async (req, res) => {
  try {
    const check = usernames.validate(req.query.u);
    if (!check.ok) return res.json({ available: false, valid: false, reason: check.error });

    const available = await usernames.isAvailable(check.username);
    res.json({
      available,
      valid: true,
      username: check.username,
      reason: available ? null : 'That username is taken',
      // Only worth computing when they need it.
      suggestion: available ? null : await usernames.generateUnique(check.username)
    });
  } catch (err) {
    console.error('Username availability error:', err);
    res.status(500).json({ error: 'Could not check that username' });
  }
});

// ── POST /api/auth/register ─────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, walletAddress } = req.body;

    if (!name || !String(name).trim()) return fail(res, 400, 'name_required', 'Name is required', 'name');
    if (!email && !walletAddress)
      return fail(res, 400, 'identifier_required', 'Email or wallet address required', 'email');
    if (email && !password)
      return fail(res, 400, 'password_required', 'Password required for email registration', 'password');
    if (password && password.length < 8)
      return fail(res, 400, 'password_too_short', 'Password must be at least 8 characters', 'password');

    // Handle is optional over the API so wallet-only and scripted registrations
    // keep working; the signup form always sends one.
    let username = null;
    if (req.body.username != null && String(req.body.username).trim() !== '') {
      const check = usernames.validate(req.body.username);
      if (!check.ok) return fail(res, 400, 'username_invalid', check.error, 'username');
      if (!(await usernames.isAvailable(check.username)))
        return fail(res, 409, 'username_taken', 'That username is already taken', 'username');
      username = check.username;
    } else {
      username = await usernames.generateUnique(email || name);
    }

    const validRoles = ['admin', 'staff', 'auditor', 'user'];
    const userRole = validRoles.includes(role) ? role : 'staff';

    // Check duplicates
    if (email) {
      const exists = await query('SELECT user_id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (exists.rows.length > 0)
        return fail(res, 409, 'email_taken', 'An account with this email already exists', 'email');
    }
    if (walletAddress) {
      const exists = await query('SELECT user_id FROM users WHERE wallet_address = $1', [walletAddress.toLowerCase()]);
      if (exists.rows.length > 0)
        return fail(res, 409, 'wallet_taken', 'Wallet already registered', 'walletAddress');
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const authMethod = walletAddress && password ? 'wallet+password'
      : walletAddress ? 'wallet' : 'password';

    const userId = uuidv4();
    try {
      await query(`
        INSERT INTO users (user_id, name, username, email, password_hash, role, wallet_address, auth_method, token_balance, is_frozen)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1000, 0)
      `, [
        userId,
        String(name).trim(),
        username,
        email?.toLowerCase() || null,
        passwordHash,
        userRole,
        walletAddress?.toLowerCase() || null,
        authMethod
      ]);
    } catch (insertErr) {
      // The checks above are a read followed by a write, so two simultaneous
      // signups for the same handle or address both pass and one loses at the
      // index. Report that as the field conflict it is rather than a 500.
      if (insertErr.code === '23505') {
        const c = String(insertErr.constraint || '');
        if (c.includes('username')) return fail(res, 409, 'username_taken', 'That username is already taken', 'username');
        if (c.includes('email')) return fail(res, 409, 'email_taken', 'An account with this email already exists', 'email');
        if (c.includes('wallet')) return fail(res, 409, 'wallet_taken', 'Wallet already registered', 'walletAddress');
      }
      throw insertErr;
    }

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

    console.log(`✅ Registered: ${name} @${username} (${userRole}) — ${email || walletAddress}`);
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

    if (!email) return fail(res, 400, 'email_required', 'Email is required', 'email');
    if (!password) return fail(res, 400, 'password_required', 'Password is required', 'password');

    // Accept a username here too. People who registered with a handle reach for
    // it at the login box, and telling them "invalid email or password" when
    // they typed a valid handle is a dead end with no way out.
    const identifier = String(email).trim().toLowerCase();
    const resUser = identifier.includes('@')
      ? await query('SELECT *, user_id as id FROM users WHERE email = $1', [identifier])
      : await query('SELECT *, user_id as id FROM users WHERE lower(username) = $1', [identifier]);
    const user = resUser.rows[0];

    // One shared message for "no such account" and "wrong password", on the
    // field the user can act on. Splitting them turns the login form into an
    // account-existence oracle.
    if (!user || !user.password_hash)
      return fail(res, 401, 'invalid_credentials', 'Incorrect email or password', 'password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return fail(res, 401, 'invalid_credentials', 'Incorrect email or password', 'password');

    if (user.is_frozen)
      return fail(res, 403, 'account_frozen', 'Account frozen — token balance depleted');

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

// ── POST /api/auth/google ────────────────────────────────────
// Takes the `credential` (an ID token) from Google Identity Services, verifies
// it against Google's published keys, then signs in or provisions the account.
router.post('/google', async (req, res) => {
  try {
    if (!google.isConfigured()) {
      return fail(res, 503, 'google_unconfigured',
        'Google sign-in is not configured on this server');
    }

    let identity;
    try {
      identity = await google.verifyIdToken(req.body.credential);
    } catch (verifyErr) {
      console.warn('Google verify failed:', verifyErr.message);
      return fail(res, 401, 'google_invalid', verifyErr.message);
    }

    const resUser = await query('SELECT *, user_id as id FROM users WHERE email = $1', [identity.email]);
    let user = resUser.rows[0];

    if (user) {
      if (user.is_frozen)
        return fail(res, 403, 'account_frozen', 'Account frozen — token balance depleted');
      // A password account signing in with the same verified address is the
      // same person; widen auth_method rather than forking a second account.
      if (user.auth_method === 'password' || user.auth_method === 'google') {
        const method = user.password_hash ? 'google+password' : 'google';
        await query('UPDATE users SET auth_method = $1 WHERE user_id = $2', [method, user.id]);
      }
      if (!user.avatar_url && identity.picture) {
        await query('UPDATE users SET avatar_url = $1 WHERE user_id = $2', [identity.picture, user.id]);
      }
      await query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.id]);
      clearUserCache(user.id);
    } else {
      const userId = uuidv4();
      const username = await usernames.generateUnique(identity.email);
      await query(`
        INSERT INTO users (user_id, name, username, email, role, auth_method, avatar_url, token_balance, is_frozen, last_login)
        VALUES ($1, $2, $3, $4, 'staff', 'google', $5, 1000, 0, NOW())
      `, [userId, identity.name, username, identity.email, identity.picture]);

      try {
        await query(`
          INSERT INTO token_ledger (ledger_id, user_id, amount, balance, type, reason)
          VALUES ($1, $2, 1000, 1000, 'grant', 'Initial token grant — Google sign-in')
        `, [uuidv4(), userId]);
      } catch (ledgerErr) {
        console.error('Token ledger grant error (non-fatal):', ledgerErr.message);
      }
      console.log(`✅ Google sign-up: ${identity.name} @${username} — ${identity.email}`);
    }

    const fresh = await query('SELECT *, user_id as id FROM users WHERE email = $1', [identity.email]);
    user = fresh.rows[0];
    const token = generateJWT(user.id);
    res.json({ token, user: sanitizeUser(user), isNew: !resUser.rows[0] });

  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

// ── POST /api/auth/forgot ────────────────────────────────────
// Mails a six-digit code. The response is identical whether or not the address
// has an account: this endpoint used to answer 404 "Email not found", which
// made it a free membership oracle for anyone with a list of addresses.
router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) return fail(res, 400, 'email_required', 'Email is required', 'email');

    // Constant for every address, so it leaks nothing about this one. Worth
    // returning because a user staring at "check your inbox" on a server with
    // no SMTP credentials would wait forever.
    const emailConfigured = Boolean(channelConfigStatus().email);
    const generic = {
      message: 'If an account exists for that email, a reset code is on its way.',
      delivery: emailConfigured ? 'sent' : 'unconfigured'
    };

    const resUser = await query('SELECT user_id as id, name, email FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = resUser.rows[0];
    if (!user) return res.json(generic);

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(resetCode, 12);
    const resetId = uuidv4();

    const resExp = await query(`SELECT (NOW() + interval '15 minutes')::text as expires`);
    const expiresAt = resExp.rows[0].expires;

    await query(`
      INSERT INTO password_resets (reset_id, user_id, code_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [resetId, user.id, codeHash, expiresAt]);

    if (emailConfigured) {
      // Awaited, so a bounce or an auth failure is logged against this request
      // rather than surfacing as an unhandled rejection minutes later.
      try {
        await sendEmail(
          user.email,
          'Your FinChat password reset code',
          `Hi ${user.name || 'there'},\n\n` +
          `Your FinChat password reset code is ${resetCode}\n\n` +
          'It expires in 15 minutes. If you did not ask to reset your password, ' +
          'you can ignore this email — nothing has changed.\n',
          `<p>Hi ${user.name || 'there'},</p>
           <p>Your FinChat password reset code is:</p>
           <p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${resetCode}</p>
           <p>It expires in 15 minutes. If you did not ask to reset your password,
              you can ignore this email — nothing has changed.</p>`
        );
        console.log(`🔐 Password reset code emailed to ${user.email}`);
      } catch (mailErr) {
        // Still a generic response: whether our SMTP hop succeeded says nothing
        // about the user, and telling the caller would re-open the oracle.
        console.error(`Password reset email to ${user.email} failed:`, mailErr.message);
      }
    } else {
      // Development fallback — without it there is no way to complete a reset
      // on a machine with no SMTP credentials.
      console.log(`🔐 SMTP not configured. Password reset code for ${user.email}: ${resetCode} (valid until ${expiresAt})`);
    }

    res.json(generic);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Could not start password reset' });
  }
});

// ── POST /api/auth/reset ─────────────────────────────────────
router.post('/reset', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email) return fail(res, 400, 'email_required', 'Email is required', 'email');
    if (!code) return fail(res, 400, 'code_required', 'Enter the code from your email', 'code');
    if (!newPassword) return fail(res, 400, 'password_required', 'Choose a new password', 'newPassword');
    if (newPassword.length < 8) {
      return fail(res, 400, 'password_too_short', 'Password must be at least 8 characters', 'newPassword');
    }

    const resUser = await query('SELECT *, user_id as id FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = resUser.rows[0];
    // Same wording as a wrong code, for the same reason as /forgot: a distinct
    // "email not found" here would restore the oracle that endpoint closed.
    if (!user) {
      return fail(res, 400, 'code_invalid', 'That code is incorrect or has expired', 'code');
    }

    const resReset = await query(`
      SELECT *, reset_id as id FROM password_resets
      WHERE user_id = $1 AND used = 0 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `, [user.id]);
    const reset = resReset.rows[0];

    if (!reset) {
      return fail(res, 400, 'code_invalid', 'That code is incorrect or has expired', 'code');
    }

    const valid = await bcrypt.compare(String(code).trim(), reset.code_hash);
    if (!valid) {
      return fail(res, 400, 'code_invalid', 'That code is incorrect or has expired', 'code');
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

    clearUserCache(user.id);
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
      return fail(res, 400, 'wallet_required', 'Wallet address required', 'walletAddress');

    const resUser = await query('SELECT *, user_id as id FROM users WHERE wallet_address = $1', [walletAddress.toLowerCase()]);
    let user = resUser.rows[0];

    if (!user) {
      const validRoles = ['admin', 'staff', 'auditor', 'user'];
      const userRole = validRoles.includes(role) ? role : 'user';
      const userId = uuidv4();
      const shortAddr = walletAddress.substring(0, 6) + '…' + walletAddress.slice(-4);
      const username = await usernames.generateUnique(`wallet${walletAddress.slice(0, 8)}`);

      await query(`
        INSERT INTO users (user_id, name, username, wallet_address, role, auth_method, token_balance, is_frozen)
        VALUES ($1, $2, $3, $4, $5, 'wallet', 1000, 0)
      `, [userId, `Wallet User (${shortAddr})`, username, walletAddress.toLowerCase(), userRole]);

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
  clearUserCache(req.user.id);
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
    clearUserCache(req.user.id);
    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Avatar updated', user: sanitizeUser(resUser.rows[0]) });
  } catch (err) {
    console.error('Avatar update error:', err);
    res.status(500).json({ error: 'Could not update avatar' });
  }
});

module.exports = router;
