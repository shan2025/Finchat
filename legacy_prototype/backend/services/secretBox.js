// services/secretBox.js — authenticated encryption for secrets held at rest.
//
// A Google refresh token is a long-lived key to someone's mailbox. It must not
// sit in a database column in plaintext, where a backup, a log of a query, or a
// read-only Supabase session hands it over intact.
//
// AES-256-GCM: the tag means a tampered ciphertext fails to decrypt rather than
// decrypting to garbage that some caller then treats as a token.
//
// The key is derived (scrypt) from GOOGLE_TOKEN_KEY when set, and from
// JWT_SECRET otherwise, so this works on an existing deployment with no new
// configuration. The trade-off is explicit: rotating JWT_SECRET makes stored
// tokens undecryptable, and every affected user simply reconnects — which is
// the correct outcome for a secret-rotation event anyway. Set GOOGLE_TOKEN_KEY
// to decouple the two.
const crypto = require('crypto');

const VERSION = 'v1';
let _key = null;
let _keySource = null;

function keyMaterial() {
  const explicit = (process.env.GOOGLE_TOKEN_KEY || '').trim();
  if (explicit) return { secret: explicit, source: 'GOOGLE_TOKEN_KEY' };
  const jwt = (process.env.JWT_SECRET || '').trim();
  if (jwt) return { secret: jwt, source: 'JWT_SECRET' };
  throw new Error('secretBox: neither GOOGLE_TOKEN_KEY nor JWT_SECRET is set — refusing to store a secret unencrypted');
}

function getKey() {
  const { secret, source } = keyMaterial();
  // Re-derive if the source changed (tests swap the env between cases).
  if (_key && _keySource === `${source}:${secret.length}:${secret.slice(0, 4)}`) return _key;
  _key = crypto.scryptSync(secret, 'finchat-secretbox-v1', 32);
  _keySource = `${source}:${secret.length}:${secret.slice(0, 4)}`;
  return _key;
}

/**
 * @param {string} plaintext
 * @returns {string} "v1:<iv>:<tag>:<ciphertext>", all base64url
 */
function seal(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('secretBox.seal requires a non-empty string');
  }
  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/**
 * @returns {string|null} the plaintext, or null if the value cannot be
 *          authenticated — a wrong key, a truncated column, or tampering. The
 *          caller treats null as "not connected" and asks the user to reconnect,
 *          which is safe; throwing here would take down a whole settings page
 *          over one unreadable row.
 */
function open(sealed) {
  if (typeof sealed !== 'string' || !sealed) return null;
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, iv, tag, ct] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

module.exports = { seal, open };
