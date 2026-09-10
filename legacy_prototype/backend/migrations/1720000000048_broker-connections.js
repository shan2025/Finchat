/* eslint-disable camelcase */

// Broker connections — the user's REAL positions, read from where they live.
//
// Atlas shipped able to watch a portfolio the user had typed in by hand, which
// is a portfolio almost nobody maintains. Asked "what do I own?", he correctly
// answered "your portfolio is currently empty" while the person asking held a
// Binance account and a Zerodha account. The steward was honest and useless.
//
// So: read-only connections to the two venues, and holdings that carry where
// they came from.
//
//   broker_connections — one row per user per broker, credentials sealed with
//                        the same AES-256-GCM box that holds Google refresh
//                        tokens (services/secretBox.js).
//   portfolio_holdings — gains `source` (manual | binance | zerodha), `exchange`
//                        and `synced_at`. A sync replaces only its own source's
//                        rows, so a broker refresh can never delete something
//                        the user entered by hand.
//
// THE BOUNDARY FROM MIGRATION 044 IS UNCHANGED, and this is the migration where
// that has to be said carefully, because "Atlas holds no broker credentials" is
// no longer literally true. What is true, and enforced in code rather than
// promised in a prompt:
//
//   • Binance keys are VERIFIED read-only before they are stored. The connector
//     calls GET /sapi/v1/account/apiRestrictions and REFUSES any key with
//     trading or withdrawal enabled — see services/brokers/binance.js. A key
//     that could place an order is not accepted, so the capability to trade
//     never enters the system in the first place.
//   • Zerodha's Kite Connect access token is a full-privilege session by design
//     — the venue offers no read-only variant — so the code path is narrowed
//     instead: the connector issues GET /portfolio/holdings and nothing else,
//     and there is no order-placing function anywhere for it to call.
//   • No agent can reach any of this. The tool layer exposes `sync`, which
//     refreshes positions; connecting, re-authorising and disconnecting are
//     user actions on the Settings page behind requireAuth.
//
// Zerodha is a special case worth writing down: the exchange mandates a manual
// login once a day and flushes the access token every morning (~7:30 IST). An
// unattended daily watch therefore CANNOT refresh the Zerodha side on its own.
// The connection carries `status` and `last_synced_at` so Atlas can say "your
// Zerodha side is from yesterday morning" instead of quietly reporting a stale
// number as today's.

exports.up = async (pgm) => {
  pgm.createTable('broker_connections', {
    connection_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    // 'binance' | 'zerodha'
    broker: { type: 'text', notNull: true },
    // Sealed JSON. Binance: { apiKey, apiSecret }. Zerodha: { apiKey, apiSecret,
    // accessToken, accessTokenAt }. Never selected into a response — the routes
    // return status and a last-4, never the material.
    credentials_enc: { type: 'text', notNull: true },
    // Shown in Settings so the user can tell which account is connected:
    // the Binance key's last 4, or the Kite user id.
    account_label: { type: 'text' },
    // connected  — usable right now
    // needs_login — Zerodha's daily token has been flushed; holdings are stale
    //               but still readable from the last sync
    // error      — the last attempt failed for a reason the user must act on
    status: { type: 'text', notNull: true, default: 'connected' },
    last_synced_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    holdings_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('broker_connections', 'broker_connections_user_broker_unique',
    { unique: ['user_id', 'broker'] });

  // Same posture as 023/024/038/044: RLS on with no policies denies Supabase's
  // anon and authenticated roles outright. The backend connects as owner and
  // enforces ownership in the route and tool layers. This table holds API
  // credentials to someone's exchange account — if anything in the schema
  // belongs behind that, it is this.
  pgm.sql('ALTER TABLE "broker_connections" ENABLE ROW LEVEL SECURITY');

  // ── Holdings learn where they came from ────────────────────────
  pgm.addColumns('portfolio_holdings', {
    source: { type: 'text', notNull: true, default: 'manual' },
    // NSE / BSE / BINANCE. Pricing needs it: Yahoo quotes Indian equities as
    // RELIANCE.NS, not RELIANCE — without this an NSE holding either fails to
    // price or, worse, silently prices some unrelated US ticker of the same name.
    exchange: { type: 'text' },
    synced_at: { type: 'timestamptz' },
    // The price the broker itself reported at sync time, in the holding's own
    // currency. A fallback, not the primary: valuations still price live so a
    // portfolio total and a spot-price question cannot disagree. But Kite knows
    // the price of every Indian small-cap and Yahoo does not, and "could not be
    // priced" is a poor answer when the broker just told us the number.
    broker_price: { type: 'numeric' },
    broker_price_at: { type: 'timestamptz' }
  });

  // The old key was (user_id, symbol, kind), which cannot hold the same asset in
  // two places — and BTC on Binance alongside BTC entered by hand is a normal
  // thing to own. Source is part of the identity of a position now.
  pgm.dropConstraint('portfolio_holdings', 'portfolio_holdings_user_symbol_kind_unique',
    { ifExists: true });
  pgm.addConstraint('portfolio_holdings', 'portfolio_holdings_user_symbol_kind_source_unique',
    { unique: ['user_id', 'symbol', 'kind', 'source'] });
  pgm.createIndex('portfolio_holdings', ['user_id', 'source']);

  // ── The series learns rupees ───────────────────────────────────
  // The user is in India and their equity book is INR, so INR is the currency
  // the totals are reported in. The snapshot series was USD-only, and converting
  // a historical USD total at TODAY's rate would invent a return that never
  // happened — a 3% rupee move would read as portfolio growth. So each day
  // records its own rate alongside both totals, and a day that predates this
  // column is reported as USD-only rather than silently converted.
  pgm.addColumns('portfolio_snapshots', {
    total_value_inr: { type: 'numeric' },
    total_cost_basis_inr: { type: 'numeric' },
    fx_usd_inr: { type: 'numeric' }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('portfolio_snapshots', ['total_value_inr', 'total_cost_basis_inr', 'fx_usd_inr']);
  pgm.dropConstraint('portfolio_holdings', 'portfolio_holdings_user_symbol_kind_source_unique',
    { ifExists: true });
  pgm.addConstraint('portfolio_holdings', 'portfolio_holdings_user_symbol_kind_unique',
    { unique: ['user_id', 'symbol', 'kind'] });
  pgm.dropColumns('portfolio_holdings',
    ['source', 'exchange', 'synced_at', 'broker_price', 'broker_price_at']);
  pgm.dropTable('broker_connections');
};
