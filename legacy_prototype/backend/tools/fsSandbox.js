// tools/fsSandbox.js — where file_read and glob are allowed to look.
//
// Hopper (and plato) read code to diagnose failures. The tools used to accept
// any path the process could open, and any user can address Hopper — so
// "read /proc/self/environ" would have printed DATABASE_URL, JWT_SECRET and
// every provider key into the chat. With JWT_SECRET a reader could then mint a
// session for any account.
//
// Two rules, both enforced on the REAL path (symlinks resolved), because a
// check on the string the model typed is bypassed by `..` or a link:
//   1. The path must sit inside the app's own code: the backend directory or
//      the frontend directory.
//   2. Even inside them, secrets are refused: env files, keys, key pairs, the
//      local database, uploads and .git (whose config can carry credentials).
//
// The roots are named explicitly rather than taken as "the repository", because
// the layouts differ: locally both sit under legacy_prototype/, but the Docker
// image puts the backend at /app and the frontend at /frontend, where "three
// directories up from tools/" is the filesystem root.
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const ROOTS = [BACKEND_DIR, path.resolve(BACKEND_DIR, '..', 'frontend')];

const DENIED_SEGMENTS = new Set(['.git', 'uploads']);
const DENIED_BASENAME = [
  /^\.env($|\.)/i,            // .env, .env.local, .env.production …
  /^\.solana-keypair\.json$/i,
  /^\.vapid-keys\.json$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^finchat\.db/i,
  /^id_(rsa|ed25519|ecdsa)/i
];
// The template is documentation, not a secret, and is useful when diagnosing
// a missing variable.
const ALLOWED_BASENAME = [/^\.env\.example$/i];

let _rootsReal = null;
function rootsReal() {
  if (!_rootsReal) {
    _rootsReal = ROOTS.map(r => { try { return fs.realpathSync(r); } catch { return r; } });
  }
  return _rootsReal;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function containingRoot(p) {
  return rootsReal().find(r => isInside(r, p)) || null;
}

/** Why this path is off-limits, or null if it may be read. `real` must be resolved. */
function denialReason(real) {
  const root = containingRoot(real);
  if (!root) return 'outside the application code';
  const parts = path.relative(root, real).split(path.sep).filter(Boolean);
  if (parts.some(p => DENIED_SEGMENTS.has(p.toLowerCase()))) return 'in a protected directory';
  const base = parts[parts.length - 1] || '';
  if (ALLOWED_BASENAME.some(rx => rx.test(base))) return null;
  if (DENIED_BASENAME.some(rx => rx.test(base))) return 'a secrets file';
  return null;
}

/**
 * Resolve a path the model supplied and check it. Relative paths resolve from
 * the process cwd, as before. Throws with a reason the agent can act on.
 * @returns {string} the real, permitted path
 */
function resolveReadable(p) {
  const abs = path.resolve(String(p));
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    // Don't confirm or deny that anything exists outside the roots.
    if (!containingRoot(abs)) throw new Error(`Access denied: ${p} is outside the application code`);
    throw err;
  }
  const reason = denialReason(real);
  if (reason) throw new Error(`Access denied: ${p} is ${reason}`);
  return real;
}

module.exports = { ROOTS, resolveReadable, denialReason };
