// services/brokers/binance.js — read-only spot balances from Binance.
//
// The whole design point of this file is the check in assertReadOnly(): a key
// that CAN trade is refused at connect time, so the capability to place an order
// never enters the system. Atlas's charter is to observe someone's savings and
// explain them; a stored key with trading permission would quietly make that a
// promise about behaviour rather than a fact about access.
//
// Binance's own API tells us which it is. GET /sapi/v1/account/apiRestrictions
// returns the permission flags for the calling key, so we do not have to take
// the user's word that they ticked "Enable Reading" and nothing else.
const crypto = require('crypto');
const axios = require('axios');

// Overridable: binance.us serves a different host, and a user in a restricted
// jurisdiction may be on a regional domain.
const BASE = (process.env.BINANCE_API_BASE || 'https://api.binance.com').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;
const RECV_WINDOW_MS = 10000;

// Balances below this are exchange dust — the residue of past trades, worth
// fractions of a cent. Listing them as positions makes a portfolio review read
// like a database dump. They are counted and reported as a number, not hidden.
const DUST_THRESHOLD = 1e-8;

/** Binance's clock, minus ours. Refreshed lazily; a stale offset causes -1021. */
let _clockSkewMs = 0;
let _skewCheckedAt = 0;

// ── IP bans ──────────────────────────────────────────────────────
// Binance error -1003 rate-limits an IP ADDRESS, not an account or a key, and
// the reply carries the epoch-ms the ban lifts at. This matters more here than
// it would elsewhere: FinChat runs on shared hosting whose outbound IP is used
// by other tenants, so a ban usually arrives having been earned by somebody
// else's traffic — a sync is three requests of trivial weight.
//
// The cooldown is what stops it compounding. Atlas re-syncs Binance on EVERY
// portfolio valuation, so without this a ban would be met with a fresh request
// on every question the user asks, which is how a short ban becomes a long one.
// While the cooldown holds we fail locally and make no network call at all.
//
// Process-local on purpose: it is a property of this container's IP, and after a
// restart (which on Render's free tier may mean a different address anyway) the
// worst case is one probe request.
let _bannedUntilMs = 0;

function banRemainingMs() { return Math.max(0, _bannedUntilMs - Date.now()); }

function noteBan(untilMs) {
  if (Number.isFinite(untilMs) && untilMs > _bannedUntilMs) _bannedUntilMs = untilMs;
}

/** For the UI and for Atlas: when does this lift, in words? */
function banMessage() {
  const until = new Date(_bannedUntilMs);
  const mins = Math.max(1, Math.ceil(banRemainingMs() / 60000));
  return `Binance has rate-limited this server's IP address until ${until.toISOString()} ` +
    `(about ${mins} minute${mins === 1 ? '' : 's'} away). This is a limit on the shared hosting IP, ` +
    'not on your API key — your key is fine and nothing needs changing. Positions will refresh once it lifts.';
}

function rateLimitError() {
  const err = new Error(banMessage());
  err.rateLimited = true;
  err.retryAt = new Date(_bannedUntilMs).toISOString();
  return err;
}

async function syncClock() {
  // Signed requests carry a timestamp Binance rejects if it drifts outside
  // recvWindow. Container clocks drift; this is cheaper than failing the call.
  if (Date.now() - _skewCheckedAt < 5 * 60_000) return;
  try {
    const before = Date.now();
    const res = await axios.get(`${BASE}/api/v3/time`, { timeout: TIMEOUT_MS });
    const rtt = Date.now() - before;
    _clockSkewMs = Number(res.data.serverTime) - (before + rtt / 2);
    _skewCheckedAt = Date.now();
  } catch (err) {
    // Not fatal — the request below may still fall inside recvWindow.
    _skewCheckedAt = Date.now();
  }
}

function sign(params, apiSecret) {
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
  return `${qs}&signature=${signature}`;
}

/**
 * A signed GET. Binance reports failures as {code, msg} with HTTP 4xx, and the
 * codes are far more actionable than the HTTP status — so they are translated
 * here into something a user can act on rather than surfaced as "Request failed
 * with status code 401".
 */
async function signedGet(path, { apiKey, apiSecret }, extra = {}) {
  // Refuse locally while the IP is banned. Sending the request anyway is what
  // extends the ban.
  if (banRemainingMs() > 0) throw rateLimitError();

  await syncClock();
  const qs = sign({
    ...extra,
    recvWindow: RECV_WINDOW_MS,
    timestamp: Date.now() + Math.round(_clockSkewMs)
  }, apiSecret);

  try {
    const res = await axios.get(`${BASE}${path}?${qs}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
      timeout: TIMEOUT_MS
    });
    return res.data;
  } catch (err) {
    const data = err.response && err.response.data;
    const code = data && data.code;
    if (code === -2015 || code === -2014) {
      throw new Error(
        'Binance rejected the API key. Usual causes: the key or secret was pasted incompletely, ' +
        'the key has an IP whitelist that does not include this server, or it has been deleted. ' +
        'FinChat runs on shared hosting with no fixed outbound IP, so the key must be created without an IP restriction.'
      );
    }
    // -1003: too much request weight from this IP. The message carries the epoch
    // milliseconds the ban lifts ("IP banned until 1789015432402"); record it so
    // every later call fails locally instead of adding to the pile.
    if (code === -1003) {
      const m = /banned until (\d+)/i.exec(String((data && data.msg) || ''));
      // No timestamp in the message means a soft weight warning rather than a
      // ban; back off for a minute so a retry loop cannot turn it into one.
      noteBan(m ? Number(m[1]) : Date.now() + 60_000);
      throw rateLimitError();
    }
    if (code === -1022) throw new Error('Binance rejected the request signature — the API secret does not match the API key.');
    if (code === -1021) throw new Error('Binance rejected the request timestamp (server clock drift). Try again in a moment.');
    if (code === -2008) throw new Error('Binance does not recognise that API key.');
    if (data && data.msg) throw new Error(`Binance: ${data.msg}`);
    if (err.code === 'ECONNABORTED') throw new Error('Binance did not respond in time.');
    throw err;
  }
}

/**
 * Refuse any key that can move money.
 *
 * Not advisory. A key with trading enabled is rejected outright rather than
 * stored with a warning, because the honest description of what FinChat holds
 * must stay "a key that can only read". Withdrawals, spot/margin trading,
 * futures, options, internal transfer and universal transfer are all grounds
 * for refusal; reading is required.
 */
function assertReadOnly(restrictions) {
  const forbidden = [
    ['enableWithdrawals', 'withdraw funds'],
    ['enableInternalTransfer', 'transfer between accounts'],
    ['permitsUniversalTransfer', 'move funds between wallets'],
    ['enableSpotAndMarginTrading', 'place spot and margin orders'],
    ['enableMargin', 'trade on margin'],
    ['enableFutures', 'trade futures'],
    ['enableFuture', 'trade futures'],
    ['enableVanillaOptions', 'trade options']
  ];
  const granted = forbidden
    .filter(([flag]) => restrictions[flag] === true)
    .map(([, what]) => what);

  if (granted.length) {
    throw new Error(
      `This key can ${granted.join(', ')}. FinChat only ever reads your balances, so it will not store a key ` +
      'that can act on your account. In Binance → API Management, either untick those permissions on this key ' +
      'or create a new key with "Enable Reading" alone, then connect that one.'
    );
  }
  if (restrictions.enableReading === false) {
    throw new Error('This key has reading disabled, so it cannot see your balances. Tick "Enable Reading" on it in Binance → API Management.');
  }
  return true;
}

/** Permission flags for a key. Also the cheapest proof the credentials work. */
async function fetchRestrictions(creds) {
  return signedGet('/sapi/v1/account/apiRestrictions', creds);
}

/**
 * Validate a pasted key pair. Throws with a user-actionable message on anything
 * that would make the connection useless or unsafe; returns the label to show.
 */
async function verify(creds) {
  const restrictions = await fetchRestrictions(creds);
  assertReadOnly(restrictions);
  return {
    label: `Binance ····${String(creds.apiKey).slice(-4)}`,
    ipRestricted: restrictions.ipRestrict === true,
    permissions: { reading: restrictions.enableReading !== false, trading: false, withdrawals: false }
  };
}

/**
 * Current spot balances, as holdings.
 *
 * free + locked, because a coin sitting in an open order is still owned — a
 * portfolio review that silently drops it understates what the user has.
 */
async function fetchHoldings(creds) {
  const account = await signedGet('/api/v3/account', creds, { omitZeroBalances: 'true' });
  const balances = Array.isArray(account.balances) ? account.balances : [];

  let dust = 0;
  const holdings = [];
  for (const b of balances) {
    const qty = Number(b.free || 0) + Number(b.locked || 0);
    if (!isFinite(qty) || qty <= 0) continue;
    if (qty < DUST_THRESHOLD) { dust++; continue; }
    holdings.push({
      symbol: String(b.asset).toUpperCase(),
      kind: 'crypto',
      quantity: qty,
      // Binance does not report what you paid — cost basis would need the whole
      // trade history per asset, and a wrong cost basis is worse than none
      // because it turns into a fabricated P/L. Left null, reported as unknown.
      avgCost: null,
      currency: 'USD',
      exchange: 'BINANCE'
    });
  }

  return {
    holdings,
    dustSkipped: dust,
    accountType: account.accountType || null,
    canTrade: account.canTrade === true,
    canWithdraw: account.canWithdraw === true
  };
}

module.exports = {
  verify, fetchHoldings, fetchRestrictions, assertReadOnly, BASE,
  banRemainingMs, noteBan, _resetBan: () => { _bannedUntilMs = 0; }
};
