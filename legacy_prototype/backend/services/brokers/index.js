// services/brokers/index.js — connect a broker, keep the credentials sealed,
// and fold what it reports into the portfolio.
//
// This is the seam between "an account somewhere on the internet" and
// portfolio_holdings, which everything else (valuation, the daily snapshot
// series, Atlas's whole job) already reads. Getting the seam right is mostly
// about one rule:
//
//   A SYNC OWNS ONLY ITS OWN SOURCE.
//
// Syncing Binance replaces the rows whose source is 'binance' and touches
// nothing else. A holding the user typed in by hand survives every sync; a coin
// they sold on Binance disappears on the next one. Without that rule the first
// broker connection would either wipe the manual entries or accumulate ghosts of
// positions that were closed months ago.
//
// Credentials live in one sealed blob per connection (AES-256-GCM, the same box
// as Google's refresh tokens). Nothing in this module returns them: `list`
// returns status, and the routes return what `list` gives them.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../database');
const { seal, open } = require('../secretBox');
const binance = require('./binance');
const zerodha = require('./zerodha');

const BROKERS = {
  binance: {
    label: 'Binance',
    kind: 'crypto',
    autoSync: true,
    docs: 'https://www.binance.com/en/my/settings/api-management',
    note: 'Read-only API key. FinChat verifies the key cannot trade or withdraw before storing it.'
  },
  zerodha: {
    label: 'Zerodha',
    kind: 'equity',
    // The one that shapes the UX: Kite tokens are flushed every morning and the
    // exchange requires a manual login, so nothing here can refresh unattended.
    autoSync: false,
    docs: 'https://developers.kite.trade/apps',
    note: 'Kite Connect Personal (free for individuals). Zerodha requires you to log in once a day, so holdings go stale until you reconnect each morning.'
  }
};

const isBroker = (b) => Object.prototype.hasOwnProperty.call(BROKERS, String(b || '').toLowerCase());

// ── Connection records ───────────────────────────────────────────

async function getRow(userId, broker) {
  const res = await query(
    'SELECT * FROM broker_connections WHERE user_id = $1 AND broker = $2', [userId, broker]);
  return res.rows[0] || null;
}

/** Credentials for a connection, or null when the row is unreadable. */
function credsOf(row) {
  if (!row) return null;
  const raw = open(row.credentials_enc);
  if (!raw) return null; // signing key rotated — the user must reconnect
  try { return JSON.parse(raw); } catch (err) { return null; }
}

async function saveRow(userId, broker, { creds, label, status, error, holdingsCount }) {
  const existing = await getRow(userId, broker);
  const merged = { ...(credsOf(existing) || {}), ...(creds || {}) };
  // holdings_count is NOT NULL with a default of 0, and a DEFAULT never applies
  // to an explicitly supplied NULL — so the column has to be coalesced here.
  // Connecting an account calls this before anything has been synced and passes
  // no count at all, which is how the very first Connect press failed with
  // "null value in column holdings_count violates not-null constraint".
  //
  // The two branches differ on purpose. On INSERT an unknown count is 0, because
  // nothing has been fetched yet. On UPDATE it must fall back to the count
  // ALREADY STORED, not to 0 — a later save that happens not to carry a count
  // (recording an error, say) would otherwise report the portfolio as empty.
  // That is why the SET clause reads $8 directly rather than EXCLUDED, which
  // would already have been coalesced to 0 by the VALUES clause.
  await query(`
    INSERT INTO broker_connections
      (connection_id, user_id, broker, credentials_enc, account_label, status, last_error, holdings_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, 0))
    ON CONFLICT (user_id, broker) DO UPDATE SET
      credentials_enc = EXCLUDED.credentials_enc,
      account_label   = COALESCE(EXCLUDED.account_label, broker_connections.account_label),
      status          = EXCLUDED.status,
      last_error      = EXCLUDED.last_error,
      holdings_count  = COALESCE($8, broker_connections.holdings_count),
      updated_at      = now()
  `, [uuidv4(), userId, broker, seal(JSON.stringify(merged)), label || null,
    status || 'connected', error || null, holdingsCount ?? null]);
  return getRow(userId, broker);
}

/** Safe view — never includes credentials. */
function publicView(row) {
  const meta = BROKERS[row.broker] || {};
  return {
    broker: row.broker,
    label: meta.label || row.broker,
    account: row.account_label,
    status: row.status,
    autoSync: meta.autoSync === true,
    holdingsCount: row.holdings_count,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    connectedAt: row.created_at,
    note: meta.note
  };
}

async function list(userId) {
  const res = await query(
    'SELECT * FROM broker_connections WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
  return {
    available: Object.entries(BROKERS).map(([id, m]) => ({
      broker: id, label: m.label, kind: m.kind, autoSync: m.autoSync, docs: m.docs, note: m.note
    })),
    connections: res.rows.map(publicView),
    zerodhaRedirectUri: zerodha.redirectUri()
  };
}

async function disconnect(userId, broker) {
  const row = await getRow(userId, broker);
  if (!row) return false;

  if (broker === 'zerodha') {
    const creds = credsOf(row);
    if (creds && creds.accessToken) await zerodha.invalidate(creds);
  }

  await query('DELETE FROM broker_connections WHERE user_id = $1 AND broker = $2', [userId, broker]);
  // The positions came from an account we can no longer see. Leaving them would
  // mean Atlas keeps reporting a book the user has disconnected as if it were
  // still being watched.
  const del = await query(
    'DELETE FROM portfolio_holdings WHERE user_id = $1 AND source = $2', [userId, broker]);
  return { disconnected: true, holdingsRemoved: del.rowCount };
}

// ── Connecting ───────────────────────────────────────────────────

async function connectBinance(userId, apiKey, apiSecret) {
  const creds = { apiKey: String(apiKey || '').trim(), apiSecret: String(apiSecret || '').trim() };
  if (!creds.apiKey || !creds.apiSecret) throw new Error('Both the API key and the API secret are required.');

  // Verify BEFORE storing: a key that can trade is refused outright, and a key
  // that does not work should never leave the Settings page looking connected.
  const { label } = await binance.verify(creds);
  await saveRow(userId, 'binance', { creds, label, status: 'connected', error: null });
  return sync(userId, 'binance');
}

/**
 * Zerodha is two steps, because the app credentials and the daily session are
 * different things. Step one stores the user's own Kite app key/secret.
 */
async function saveZerodhaApp(userId, apiKey, apiSecret) {
  const creds = { apiKey: String(apiKey || '').trim(), apiSecret: String(apiSecret || '').trim() };
  if (!creds.apiKey || !creds.apiSecret) throw new Error('Both the Kite API key and API secret are required.');
  await saveRow(userId, 'zerodha', {
    creds: { ...creds, accessToken: null, accessTokenAt: null },
    status: 'needs_login',
    error: null
  });
  return { loginUrl: zerodha.loginUrl(creds.apiKey, userId), redirectUri: zerodha.redirectUri() };
}

async function zerodhaLoginUrl(userId) {
  const creds = credsOf(await getRow(userId, 'zerodha'));
  if (!creds || !creds.apiKey) {
    throw new Error('Add your Kite API key and secret first — they come from your own app at developers.kite.trade.');
  }
  return { loginUrl: zerodha.loginUrl(creds.apiKey, userId), redirectUri: zerodha.redirectUri() };
}

/** Step two: the browser came back from Kite with a one-time request_token. */
async function completeZerodhaLogin(userId, requestToken) {
  const row = await getRow(userId, 'zerodha');
  const creds = credsOf(row);
  if (!creds || !creds.apiKey || !creds.apiSecret) {
    throw new Error('No Kite app credentials on file for this account. Add them in Settings and start again.');
  }

  const session = await zerodha.exchangeRequestToken(creds, requestToken);
  await saveRow(userId, 'zerodha', {
    creds: { accessToken: session.accessToken, accessTokenAt: new Date().toISOString() },
    label: `Zerodha ${session.kiteUserId || ''}`.trim(),
    status: 'connected',
    error: null
  });
  return sync(userId, 'zerodha');
}

// ── Syncing ──────────────────────────────────────────────────────

/**
 * Replace this source's holdings with what the broker currently reports.
 *
 * Deliberately NOT a transaction spanning the network call: the fetch happens
 * first and the write only runs if it succeeded, so a broker outage leaves the
 * previous holdings in place rather than emptying someone's portfolio.
 */
async function writeHoldings(userId, source, holdings) {
  const now = new Date();
  const keptKeys = [];

  for (const h of holdings) {
    if (!h.symbol || !isFinite(h.quantity) || h.quantity <= 0) continue;
    keptKeys.push(`${h.symbol}|${h.kind}`);
    await query(`
      INSERT INTO portfolio_holdings
        (holding_id, user_id, symbol, kind, quantity, avg_cost, currency, source, exchange,
         synced_at, broker_price, broker_price_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (user_id, symbol, kind, source) DO UPDATE SET
        quantity        = EXCLUDED.quantity,
        -- COALESCE, not overwrite: Binance does not report what you paid, and a
        -- cost basis the user filled in by hand must survive the next sync.
        avg_cost        = COALESCE(EXCLUDED.avg_cost, portfolio_holdings.avg_cost),
        currency        = EXCLUDED.currency,
        exchange        = EXCLUDED.exchange,
        synced_at       = EXCLUDED.synced_at,
        broker_price    = EXCLUDED.broker_price,
        broker_price_at = EXCLUDED.broker_price_at,
        updated_at      = now()
    `, [uuidv4(), userId, h.symbol, h.kind, h.quantity, h.avgCost ?? null,
      (h.currency || 'USD').toUpperCase(), source, h.exchange || null,
      now, h.lastPrice ?? null, h.lastPrice != null ? now : null]);
  }

  // Anything this source used to report and no longer does has been sold or
  // withdrawn. Scoped to the source, so manual entries are untouched.
  const del = await query(`
    DELETE FROM portfolio_holdings
     WHERE user_id = $1 AND source = $2
       AND (symbol || '|' || kind) <> ALL($3::text[])
  `, [userId, source, keptKeys.length ? keptKeys : ['']]);

  return { written: keptKeys.length, removed: del.rowCount };
}

/**
 * Refresh one broker. Never throws for an expected failure — an expired Zerodha
 * token is a normal Tuesday, not an error the caller should crash on. The
 * outcome is recorded on the connection so the Settings page and Atlas can both
 * see it.
 */
async function sync(userId, broker) {
  const row = await getRow(userId, broker);
  if (!row) return { broker, ok: false, reason: 'not_connected', message: `${BROKERS[broker]?.label || broker} is not connected.` };

  const creds = credsOf(row);
  if (!creds) {
    await query(`UPDATE broker_connections SET status='error', last_error=$3, updated_at=now()
                  WHERE user_id=$1 AND broker=$2`,
    [userId, broker, 'stored credentials could not be decrypted — reconnect']);
    return { broker, ok: false, reason: 'unreadable_credentials', message: `${BROKERS[broker].label} needs reconnecting — the stored credentials could not be read.` };
  }

  if (broker === 'zerodha' && !creds.accessToken) {
    return { broker, ok: false, reason: 'needs_login', message: 'Zerodha needs a fresh login — Kite clears the session every morning.' };
  }

  try {
    const fetched = broker === 'binance'
      ? await binance.fetchHoldings(creds)
      : await zerodha.fetchHoldings(creds);

    const result = await writeHoldings(userId, broker, fetched.holdings);
    await query(`
      UPDATE broker_connections
         SET status='connected', last_error=NULL, last_synced_at=now(),
             holdings_count=$3, updated_at=now()
       WHERE user_id=$1 AND broker=$2
    `, [userId, broker, fetched.holdings.length]);

    return {
      broker, ok: true, ...result,
      holdings: fetched.holdings.length,
      dustSkipped: fetched.dustSkipped,
      pledgedCount: fetched.pledgedCount,
      note: fetched.note
    };
  } catch (err) {
    // A flushed Kite token is expected daily; anything else is a real fault.
    const needsLogin = err.needsLogin === true;
    await query(`
      UPDATE broker_connections SET status=$3, last_error=$4, updated_at=now()
       WHERE user_id=$1 AND broker=$2
    `, [userId, broker, needsLogin ? 'needs_login' : 'error', err.message]);
    return {
      broker, ok: false,
      reason: needsLogin ? 'needs_login' : 'error',
      message: err.message
    };
  }
}

/**
 * Refresh every connected broker that can refresh unattended.
 *
 * `includeManualOnes` is what a person pressing "Sync now" gets; a valuation run
 * by an agent leaves them alone, because attempting Zerodha with a dead token on
 * every single valuation would just write the same error over and over.
 */
async function syncAll(userId, { includeManualOnes = false } = {}) {
  const res = await query('SELECT broker FROM broker_connections WHERE user_id = $1', [userId]);
  const out = [];
  for (const { broker } of res.rows) {
    if (!includeManualOnes && BROKERS[broker] && !BROKERS[broker].autoSync) {
      const row = await getRow(userId, broker);
      out.push({ broker, ok: false, reason: 'manual_only', skipped: true, lastSyncedAt: row.last_synced_at });
      continue;
    }
    out.push(await sync(userId, broker));
  }
  return out;
}

/**
 * How current is each connected broker's data? Atlas reports this alongside any
 * valuation — a portfolio total assembled from a live crypto balance and a
 * three-day-old equity book is two different claims, and saying so is the whole
 * difference between a steward and a dashboard.
 */
async function freshness(userId) {
  const res = await query(
    'SELECT broker, status, last_synced_at, holdings_count, last_error FROM broker_connections WHERE user_id = $1',
    [userId]);
  return res.rows.map(r => {
    const ageMs = r.last_synced_at ? Date.now() - new Date(r.last_synced_at).getTime() : null;
    const ageHours = ageMs != null ? Math.round(ageMs / 36e5 * 10) / 10 : null;
    return {
      broker: r.broker,
      label: BROKERS[r.broker]?.label || r.broker,
      status: r.status,
      holdingsCount: r.holdings_count,
      lastSyncedAt: r.last_synced_at,
      ageHours,
      stale: ageHours == null || ageHours > 24,
      lastError: r.last_error,
      needsUserAction: r.status === 'needs_login'
        ? "Zerodha's daily session has expired — the user must reconnect it in Settings before these numbers can be refreshed."
        : undefined
    };
  });
}

module.exports = {
  BROKERS, isBroker, list, disconnect,
  connectBinance, saveZerodhaApp, zerodhaLoginUrl, completeZerodhaLogin,
  sync, syncAll, freshness,
  // Exported for tests: the source-scoping rule at the top of this file is the
  // one invariant that silently corrupts a portfolio when it breaks, and it
  // cannot be exercised through sync() without live broker credentials.
  writeHoldings
};
