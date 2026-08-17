// services/googleAuth.js — verify Google Identity Services ID tokens.
//
// No new dependency: Google publishes its signing keys as a JWKS, Node can turn
// a JWK straight into a KeyObject (`crypto.createPublicKey` with format 'jwk',
// Node 16+), and jsonwebtoken — already a dependency for our own sessions —
// verifies RS256 against it. That keeps verification local after the first key
// fetch, rather than a round-trip to Google's tokeninfo endpoint on every login.
//
// What the browser sends us is an *assertion*, not a credential: it is only
// trustworthy once the signature, the audience and the issuer all check out.
// Decoding it and believing the payload is the classic way to turn "sign in
// with Google" into "sign in as anybody".
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let _jwks = null;          // { keys: { kid: KeyObject }, expiresAt: number }
let _inflight = null;      // de-dupes concurrent refreshes

/** Is Google sign-in switched on for this deployment? */
function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID.trim());
}

function clientId() {
  return (process.env.GOOGLE_CLIENT_ID || '').trim();
}

async function fetchKeys() {
  const res = await axios.get(JWKS_URL, { timeout: 8000 });
  const keys = {};
  for (const jwk of res.data.keys || []) {
    try {
      keys[jwk.kid] = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (e) {
      // A key we cannot import is not fatal — Google publishes several and
      // tokens are signed by one of them.
      console.warn('Google JWKS: unusable key', jwk.kid, e.message);
    }
  }
  if (!Object.keys(keys).length) throw new Error('Google JWKS contained no usable keys');

  // Honour Cache-Control so we rotate roughly when Google does, with a floor
  // so a missing header cannot turn this into a fetch per login.
  const cc = res.headers['cache-control'] || '';
  const maxAge = /max-age=(\d+)/.exec(cc);
  const ttlMs = Math.max(maxAge ? parseInt(maxAge[1], 10) * 1000 : 0, 10 * 60 * 1000);
  return { keys, expiresAt: Date.now() + ttlMs };
}

async function getKeys(forceRefresh = false) {
  if (!forceRefresh && _jwks && Date.now() < _jwks.expiresAt) return _jwks.keys;
  if (!_inflight) {
    _inflight = fetchKeys()
      .then(j => { _jwks = j; return j.keys; })
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

/**
 * Verify a Google ID token and return the identity it asserts.
 * @param {string} idToken the `credential` from Google Identity Services
 * @returns {Promise<{sub,email,emailVerified,name,picture}>}
 * @throws {Error} with a user-safe `.message` when the token is not acceptable
 */
async function verifyIdToken(idToken) {
  if (!isConfigured()) throw new Error('Google sign-in is not configured on this server');
  if (!idToken || typeof idToken !== 'string') throw new Error('Missing Google credential');

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) throw new Error('Malformed Google credential');

  let keys = await getKeys();
  // An unknown kid usually means Google rotated; refresh once before failing.
  if (!keys[decoded.header.kid]) keys = await getKeys(true);
  const key = keys[decoded.header.kid];
  if (!key) throw new Error('Google credential signed by an unknown key');

  let payload;
  try {
    payload = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      audience: clientId(),
      issuer: ISSUERS
    });
  } catch (err) {
    // jsonwebtoken's messages ("jwt audience invalid...") are the useful signal
    // when GOOGLE_CLIENT_ID does not match the one the button was built with.
    throw new Error(`Google credential rejected: ${err.message}`);
  }

  if (!payload.email) throw new Error('Google account has no email address');
  // An unverified address could belong to someone else, and we key accounts on
  // email — accepting it would let a Google user claim a FinChat account.
  if (payload.email_verified === false || payload.email_verified === 'false') {
    throw new Error('Google account email is not verified');
  }

  return {
    sub: payload.sub,
    email: String(payload.email).toLowerCase(),
    emailVerified: true,
    name: payload.name || payload.given_name || String(payload.email).split('@')[0],
    picture: payload.picture || null
  };
}

module.exports = { isConfigured, clientId, verifyIdToken };
