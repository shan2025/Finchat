// services/usernames.js — handle format rules, shared by every writer.
//
// The rules live here rather than inside routes/auth.js because three separate
// paths mint or check a username (register, the availability probe, and the
// Google/wallet auto-provision paths) and they have to agree exactly — a
// suggestion the probe calls free but register then rejects is worse than no
// suggestion at all.
const { query } = require('../database');

const MIN = 3;
const MAX = 20;

// Handles that would let an account impersonate part of the product or read as
// an official channel. Checked case-insensitively against the normalised form.
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'security',
  'finchat', 'official', 'staff', 'team', 'moderator', 'mod', 'api', 'auth',
  'login', 'signup', 'register', 'settings', 'billing', 'null', 'undefined',
  'me', 'you', 'user', 'anonymous', 'guest', 'bot', 'agent'
]);

/** Lowercase + trim. Does not strip invalid characters — validate() reports those. */
function normalize(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * @returns {{ ok: boolean, username?: string, error?: string }}
 * `error` is written for the end user; it is what the signup field displays.
 */
function validate(raw) {
  const username = normalize(raw);
  if (!username) return { ok: false, error: 'Username is required' };
  if (username.length < MIN) return { ok: false, error: `Username must be at least ${MIN} characters` };
  if (username.length > MAX) return { ok: false, error: `Username must be ${MAX} characters or fewer` };
  if (!/^[a-z]/.test(username)) return { ok: false, error: 'Username must start with a letter' };
  if (!/^[a-z0-9_]+$/.test(username)) return { ok: false, error: 'Use only letters, numbers and underscores' };
  if (RESERVED.has(username)) return { ok: false, error: 'That username is reserved' };
  return { ok: true, username };
}

/** True when no account holds this handle. Assumes an already-validated value. */
async function isAvailable(username, excludeUserId = null) {
  const res = excludeUserId
    ? await query('SELECT 1 FROM users WHERE lower(username) = $1 AND user_id <> $2 LIMIT 1', [username, excludeUserId])
    : await query('SELECT 1 FROM users WHERE lower(username) = $1 LIMIT 1', [username]);
  return res.rows.length === 0;
}

/**
 * Shape an arbitrary string (an email local-part, a display name) into a legal
 * handle and walk a numeric suffix until it is free. Used by the paths that
 * have no signup form to ask — Google sign-in and wallet login.
 */
async function generateUnique(seed) {
  let base = normalize(seed).replace(/[^a-z0-9_]/g, '');
  if (!/^[a-z]/.test(base)) base = 'u' + base;
  base = base.slice(0, MAX - 3) || 'user';
  while (base.length < MIN) base += '0';

  // Reserved bases would fail validate() for the un-suffixed candidate only,
  // so nudge them rather than looping to base2 and leaving a gap at base.
  if (RESERVED.has(base)) base = base + '1';

  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}${n}`;
    if (!RESERVED.has(candidate) && await isAvailable(candidate)) return candidate;
  }
  // Practically unreachable; falls back to something collision-proof by length.
  return `${base}${Date.now().toString(36).slice(-5)}`;
}

module.exports = { MIN, MAX, RESERVED, normalize, validate, isAvailable, generateUnique };
