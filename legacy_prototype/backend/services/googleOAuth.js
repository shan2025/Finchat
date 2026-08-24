// services/googleOAuth.js — the authorization-code half of Google.
//
// googleAuth.js (sign-in) and this file do different jobs and share nothing but
// a client id. Sign-in verifies an assertion the browser hands us and needs no
// secret; this obtains a REFRESH TOKEN, which is a durable key to the user's
// mailbox, and therefore needs the client secret, a registered redirect URI, and
// somewhere safe to keep what comes back.
//
// Scope is deliberately minimal and hard-coded: gmail.readonly, nothing else.
// Not gmail.modify, not send. An agent that can send mail as the user is a
// different risk category, and nothing here needs it — Rasha drafts, the human
// sends. Widening this list is a decision, not a configuration change.
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query } = require('../database');
const { seal, open } = require('./secretBox');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
// Covered by gmail.readonly, unlike userinfo — returns { emailAddress, ... }.
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

// Refresh a little early. A token that expires mid-request fails the call it was
// fetched for, and 60s of slack costs nothing.
const EXPIRY_SKEW_MS = 60_000;

// A client secret only pairs with the client id it was issued under. The
// authorization-code flow may therefore run on a DIFFERENT OAuth client from
// sign-in: GOOGLE_CLIENT_ID doubles as the audience googleAuth.js checks ID
// tokens against, so pointing it at a new client would break "Continue with
// Google". GOOGLE_OAUTH_CLIENT_ID lets the two flows use separate clients;
// falls back to GOOGLE_CLIENT_ID when a single client serves both.
function clientId() {
  return (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
}
function clientSecret() { return (process.env.GOOGLE_CLIENT_SECRET || '').trim(); }

/**
 * The redirect URI must match a value registered in the Google Cloud console
 * EXACTLY, including scheme, host, port and path. Derived from the app's own
 * origin so localhost and the deployed instance each work without a second
 * variable, but overridable when the app sits behind a proxy that rewrites it.
 */
function redirectUri() {
  const explicit = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const origin = (process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000')
    .trim().replace(/\/+$/, '');
  return `${origin}/api/integrations/google/callback`;
}

/** Is the authorization-code flow usable on this deployment? */
function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error(
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and register ' +
      `${redirectUri()} as an authorised redirect URI in the Google Cloud console.`);
  }
}

// ── The consent round-trip ───────────────────────────────────────

/**
 * `state` is a short-lived signed token, not a random string in a session map.
 * It carries the user id, so the callback knows whose mailbox this grant is for
 * without trusting anything in the query string, and its signature is what makes
 * the callback resistant to being invoked with someone else's code.
 */
function makeState(userId) {
  return jwt.sign({ uid: userId, n: crypto.randomBytes(8).toString('hex') },
    process.env.JWT_SECRET, { expiresIn: '10m', subject: 'google-oauth-state' });
}

function readState(state) {
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET, { subject: 'google-oauth-state' });
    return payload.uid || null;
  } catch (err) {
    return null;
  }
}

function buildAuthUrl(userId) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    // Without offline access Google returns no refresh token, and the
    // integration silently stops working an hour after it is connected.
    access_type: 'offline',
    // Google only issues a refresh token on the FIRST consent for a client.
    // A user who reconnects after disconnecting would otherwise get an access
    // token and no refresh token, and land in exactly that broken state.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: makeState(userId)
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  assertConfigured();
  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code'
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
  });
  return res.data; // { access_token, refresh_token, expires_in, scope, token_type }
}

// Which address did the user connect? The obvious call — the OpenID userinfo
// endpoint — needs the `userinfo.email` scope, which this integration does NOT
// request (it asks for gmail.readonly and nothing else), so that call always
// returned null and the Settings card showed no account. The Gmail profile
// endpoint returns the same address and IS covered by gmail.readonly, so ask it
// first and keep userinfo only as a fallback for a future wider grant.
async function fetchEmail(accessToken) {
  try {
    const res = await axios.get(`${GMAIL_PROFILE_URL}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000
    });
    if (res.data && res.data.emailAddress) return res.data.emailAddress;
  } catch (err) { /* fall through to userinfo */ }
  try {
    const res = await axios.get(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000
    });
    return (res.data && res.data.email) || null;
  } catch (err) {
    return null; // cosmetic — the grant works without knowing the address
  }
}

/** Persist a fresh grant. Called once, from the callback. */
async function storeGrant(userId, tokens) {
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh token. This happens when the account has already granted access — ' +
      'remove FinChat at myaccount.google.com/permissions and connect again.');
  }
  const email = await fetchEmail(tokens.access_token);
  const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000);

  await query(`
    INSERT INTO google_oauth_tokens
      (user_id, google_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id) DO UPDATE SET
      google_email = EXCLUDED.google_email,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      access_token_enc = EXCLUDED.access_token_enc,
      access_expires_at = EXCLUDED.access_expires_at,
      scope = EXCLUDED.scope,
      updated_at = now()
  `, [userId, email, seal(tokens.refresh_token),
    tokens.access_token ? seal(tokens.access_token) : null,
    expiresAt, tokens.scope || SCOPES.join(' ')]);

  return { email, scope: tokens.scope || SCOPES.join(' ') };
}

async function getGrant(userId) {
  const res = await query('SELECT * FROM google_oauth_tokens WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

/**
 * A usable access token for this user, refreshing if the cached one has expired.
 *
 * @returns {Promise<string|null>} null when the user has not connected, or when
 *          the stored refresh token no longer works (revoked from Google's side,
 *          password changed, key rotated). Callers surface "reconnect", never a
 *          stack trace.
 */
async function getAccessToken(userId) {
  const row = await getGrant(userId);
  if (!row) return null;

  const cached = open(row.access_token_enc);
  if (cached && row.access_expires_at &&
      new Date(row.access_expires_at).getTime() - EXPIRY_SKEW_MS > Date.now()) {
    return cached;
  }

  const refresh = open(row.refresh_token_enc);
  if (!refresh) {
    console.warn(`⚠️ googleOAuth: refresh token for ${userId} could not be decrypted — the signing key changed; user must reconnect`);
    return null;
  }

  assertConfigured();
  let data;
  try {
    const res = await axios.post(TOKEN_URL, new URLSearchParams({
      refresh_token: refresh,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token'
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
    });
    data = res.data;
  } catch (err) {
    // invalid_grant means the grant is gone for good — the user revoked it, or
    // it expired through disuse. Clear the row so the UI stops claiming the
    // integration is connected.
    const reason = err.response && err.response.data && err.response.data.error;
    if (reason === 'invalid_grant') {
      await disconnect(userId, { revoke: false });
      console.warn(`⚠️ googleOAuth: grant for ${userId} was revoked at Google — cleared`);
      return null;
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000);
  await query(
    'UPDATE google_oauth_tokens SET access_token_enc = $1, access_expires_at = $2, updated_at = now() WHERE user_id = $3',
    [seal(data.access_token), expiresAt, userId]);
  return data.access_token;
}

/** Note that the mailbox was actually read, for the Settings page. */
async function touch(userId) {
  await query('UPDATE google_oauth_tokens SET last_used_at = now() WHERE user_id = $1', [userId])
    .catch(() => { /* telemetry only — never fail a read over it */ });
}

/**
 * Disconnect. Revoking at Google matters: deleting our row alone leaves FinChat
 * listed on the user's account permissions page with a live grant.
 */
async function disconnect(userId, { revoke = true } = {}) {
  const row = await getGrant(userId);
  if (row && revoke) {
    const refresh = open(row.refresh_token_enc);
    if (refresh) {
      try {
        await axios.post(REVOKE_URL, new URLSearchParams({ token: refresh }).toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000
        });
      } catch (err) {
        // Already invalid at Google is the outcome we wanted anyway.
        console.warn(`⚠️ googleOAuth: revoke failed for ${userId}: ${err.message}`);
      }
    }
  }
  await query('DELETE FROM google_oauth_tokens WHERE user_id = $1', [userId]);
  return Boolean(row);
}

async function status(userId) {
  const row = await getGrant(userId);
  return {
    configured: isConfigured(),
    connected: Boolean(row),
    email: row ? row.google_email : null,
    scope: row ? row.scope : null,
    // Stated in the UI so "what does this let it do" is answerable without
    // reading the code.
    access: 'read-only, and only mail matching the job-alert filter',
    connectedAt: row ? row.connected_at : null,
    lastUsedAt: row ? row.last_used_at : null,
    redirectUri: redirectUri()
  };
}

module.exports = {
  SCOPES, isConfigured, redirectUri, buildAuthUrl, readState, exchangeCode,
  storeGrant, getGrant, getAccessToken, touch, disconnect, status
};
