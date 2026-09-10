// services/brokers/zerodha.js — equity holdings from Zerodha, via Kite Connect.
//
// Two things about this integration are not like the others, and both shape
// everything below.
//
// 1. THE DAILY LOGIN IS NOT OPTIONAL. The exchange mandates that a person log in
//    manually once a day, and Kite flushes every access token each morning
//    (~06:45–07:30 IST). No refresh token, no service account, no way around it:
//    an unattended run CANNOT re-authorise itself. So this connector is built to
//    fail politely — when the token is gone it reports `needs_login`, the last
//    synced holdings stay readable, and Atlas is expected to say how old they
//    are rather than presenting yesterday's book as today's.
//
// 2. THERE IS NO READ-ONLY KITE TOKEN. Unlike Binance, where a key's permissions
//    can be verified and a trading key refused, a Kite access token is a full
//    session by construction. The narrowing is therefore in the code, not the
//    credential: this module can fetch holdings and end a session. It has no
//    function that places, modifies or cancels an order, and nothing in the
//    agent layer can reach it — `sync` is the only verb exposed, and connecting
//    is a user action behind requireAuth on the Settings page.
//
// The app credentials (api_key/api_secret) belong to the USER's own Kite Connect
// app, created at developers.kite.trade. Kite Connect Personal is free for
// individuals and covers holdings, positions and funds; the paid tier only adds
// market data, which FinChat does not need because it prices instruments itself.
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const API = 'https://api.kite.trade';
const LOGIN = 'https://kite.zerodha.com/connect/login';
const KITE_VERSION = '3';
const TIMEOUT_MS = 15000;

/** Kite wraps everything as {status, data} / {status, message, error_type}. */
function unwrap(res) {
  const body = res.data;
  if (body && body.status === 'success') return body.data;
  const msg = (body && body.message) || 'Kite returned an unexpected response';
  const err = new Error(msg);
  err.kiteErrorType = body && body.error_type;
  throw err;
}

function translate(err) {
  const body = err.response && err.response.data;
  const type = (body && body.error_type) || err.kiteErrorType;
  const message = (body && body.message) || err.message;

  if (type === 'TokenException') {
    const e = new Error(
      'Your Zerodha session has expired. Kite clears every access token each morning and the exchange ' +
      'requires you to log in yourself once a day — reconnect Zerodha in Settings to refresh your holdings.'
    );
    e.needsLogin = true;
    return e;
  }
  if (type === 'PermissionException') {
    return new Error(`Kite refused the request: ${message}. Check that your app at developers.kite.trade is active.`);
  }
  if (type === 'InputException') {
    return new Error(`Kite rejected the request: ${message}. Usually the API key or secret is wrong, or the login link was reused.`);
  }
  if (err.code === 'ECONNABORTED') return new Error('Kite did not respond in time.');
  return new Error(message);
}

async function kiteGet(path, { apiKey, accessToken }) {
  try {
    return unwrap(await axios.get(`${API}${path}`, {
      headers: {
        'X-Kite-Version': KITE_VERSION,
        Authorization: `token ${apiKey}:${accessToken}`
      },
      timeout: TIMEOUT_MS
    }));
  } catch (err) {
    throw translate(err);
  }
}

// ── The login round-trip ─────────────────────────────────────────

/**
 * `state` is a signed, short-lived token carrying the user id, exactly as the
 * Google integration does. Kite echoes `redirect_params` back to the redirect
 * URL, which gives us somewhere to put it: the callback arrives as a browser
 * navigation with no Authorization header, so the signature is the only thing
 * that says whose account this session belongs to.
 */
function makeState(userId) {
  return jwt.sign({ uid: userId, n: crypto.randomBytes(8).toString('hex') },
    process.env.JWT_SECRET, { expiresIn: '15m', subject: 'zerodha-login-state' });
}

function readState(state) {
  try {
    return jwt.verify(state, process.env.JWT_SECRET, { subject: 'zerodha-login-state' }).uid || null;
  } catch (err) {
    return null;
  }
}

/**
 * The redirect URL the user must register in their Kite Connect app.
 *
 * Preference order matters, and is not the same as googleOAuth's. The REQUEST's
 * own origin comes first, because it is the only source that is always right:
 * this backend serves the frontend, so whatever host the browser used to reach
 * Settings is the host Kite must send it back to.
 *
 * Env vars are the fallback, and `FRONTEND_URL` is deliberately NOT trusted
 * ahead of the request — on the deployed instance it was still set to a
 * `http://localhost:5500` dev value, so the Settings page told the user to
 * register a redirect URL pointing at their own laptop. A wrong value here is
 * particularly costly: it is copied by hand into a form at Zerodha, and the
 * mismatch only shows up as a rejected login much later.
 *
 * @param {string} [origin] e.g. "https://finchat-sg.onrender.com", from the request
 */
function redirectUri(origin) {
  const explicit = (process.env.ZERODHA_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const base = (origin || process.env.RENDER_EXTERNAL_URL || process.env.FRONTEND_URL || 'http://localhost:3000')
    .trim().replace(/\/+$/, '');
  return `${base}/api/brokers/zerodha/callback`;
}

/** The origin the browser actually used, honouring Render's proxy headers. */
function originOf(req) {
  if (!req || typeof req.get !== 'function') return null;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${String(proto).split(',')[0].trim()}://${host}` : null;
}

function loginUrl(apiKey, userId) {
  const params = new URLSearchParams({ v: KITE_VERSION, api_key: apiKey });
  // Kite appends redirect_params to the redirect URL verbatim, as a query string.
  params.set('redirect_params', new URLSearchParams({ state: makeState(userId) }).toString());
  return `${LOGIN}?${params.toString()}`;
}

/**
 * Trade the one-time request_token for a day-long access token.
 * checksum = SHA-256(api_key + request_token + api_secret).
 */
async function exchangeRequestToken({ apiKey, apiSecret }, requestToken) {
  const checksum = crypto.createHash('sha256')
    .update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
  try {
    const data = unwrap(await axios.post(`${API}/session/token`,
      new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }).toString(), {
        headers: {
          'X-Kite-Version': KITE_VERSION,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: TIMEOUT_MS
      }));
    return {
      accessToken: data.access_token,
      kiteUserId: data.user_id,
      userName: data.user_name || null,
      email: data.email || null,
      loginTime: data.login_time || null
    };
  } catch (err) {
    throw translate(err);
  }
}

/** End the Kite session. Best-effort: the token expires this morning regardless. */
async function invalidate({ apiKey, accessToken }) {
  if (!accessToken) return false;
  try {
    await axios.delete(`${API}/session/token`, {
      params: { api_key: apiKey, access_token: accessToken },
      headers: { 'X-Kite-Version': KITE_VERSION, Authorization: `token ${apiKey}:${accessToken}` },
      timeout: TIMEOUT_MS
    });
    return true;
  } catch (err) {
    return false; // already dead is the outcome we wanted
  }
}

// ── Holdings ─────────────────────────────────────────────────────

/**
 * Long-term equity holdings, in INR.
 *
 * Quantity is the sum of what the user actually owns, not just what is freely
 * sellable today:
 *   quantity            — settled, in the demat account
 *   t1_quantity         — bought, not yet settled (T+1). Owned.
 *   collateral_quantity — pledged for margin. Still owned, and leaving it out
 *                         would understate a pledged portfolio badly.
 * Kite's own `last_price` is kept as a fallback price, so a holding still values
 * even when the ticker cannot be resolved on Yahoo.
 */
async function fetchHoldings(creds) {
  const rows = await kiteGet('/portfolio/holdings', creds);
  const holdings = [];
  let pledged = 0;

  for (const h of Array.isArray(rows) ? rows : []) {
    const qty = Number(h.quantity || 0) + Number(h.t1_quantity || 0) + Number(h.collateral_quantity || 0);
    if (!isFinite(qty) || qty <= 0) continue;
    if (Number(h.collateral_quantity || 0) > 0) pledged++;

    holdings.push({
      symbol: String(h.tradingsymbol || '').toUpperCase(),
      kind: 'stock',
      quantity: qty,
      avgCost: Number(h.average_price) || null,
      currency: 'INR',
      exchange: String(h.exchange || 'NSE').toUpperCase(),
      // Kite already knows the price; keeping it means an Indian equity values
      // correctly even if Yahoo has no quote for it.
      lastPrice: Number(h.last_price) || null,
      isin: h.isin || null
    });
  }

  return {
    holdings,
    pledgedCount: pledged,
    // Said out loud because a user with F&O positions would otherwise assume
    // this is their whole Zerodha book.
    note: 'Equity holdings only. Intraday and F&O positions are not included.'
  };
}

/** Prove the credentials work and report who they belong to. */
async function verify(creds) {
  const profile = await kiteGet('/user/profile', creds);
  return {
    label: `Zerodha ${profile.user_id || ''}`.trim(),
    kiteUserId: profile.user_id || null,
    userName: profile.user_name || null
  };
}

module.exports = {
  loginUrl, redirectUri, originOf, makeState, readState, exchangeRequestToken,
  fetchHoldings, verify, invalidate, API
};
