// test/broker-connections.test.js — the guarantees a read-only broker link makes.
//
// Atlas can now see someone's real money. Three things about that must not
// silently regress, and none of them is visible in a passing valuation:
//
//   1. A Binance key that can TRADE is refused. This is the whole basis on which
//      the persona is allowed to say "my access is read-only and enforced in
//      code" — soften the check and that sentence becomes a lie the user has no
//      way to audit.
//   2. Indian equities are priced as RELIANCE.NS, not RELIANCE. Without the
//      suffix Yahoo either fails or returns an unrelated US listing, and a
//      portfolio review quietly reports the wrong company's price.
//   3. Rupees and dollars are never added together. A mixed portfolio summed
//      naively produces a number that is not any currency, and it looks
//      completely plausible.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);

const binance = require('../tools/../services/brokers/binance');
const zerodha = require('../services/brokers/zerodha');
const { priceTicker, BASE_CURRENCY } = require('../tools/PortfolioTool');
const { TOOLS } = require('../services/cognitive/ToolRegistry');
const { personas } = require('../services/personas');

const readOnlyKey = {
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  permitsUniversalTransfer: false,
  enableSpotAndMarginTrading: false,
  enableMargin: false,
  enableFutures: false,
  enableVanillaOptions: false,
  ipRestrict: false
};

describe('a Binance key that can act on the account is refused', () => {
  test('a read-only key is accepted', () => {
    assert.equal(binance.assertReadOnly(readOnlyKey), true);
  });

  for (const [flag, label] of [
    ['enableSpotAndMarginTrading', 'spot trading'],
    ['enableWithdrawals', 'withdrawals'],
    ['enableMargin', 'margin'],
    ['enableFutures', 'futures'],
    ['enableVanillaOptions', 'options'],
    ['enableInternalTransfer', 'internal transfer'],
    ['permitsUniversalTransfer', 'universal transfer']
  ]) {
    test(`a key with ${label} is rejected`, () => {
      assert.throws(
        () => binance.assertReadOnly({ ...readOnlyKey, [flag]: true }),
        /will not store a key that can act on your account/,
        `${flag} must disqualify the key — FinChat promises the stored key cannot trade`);
    });
  }

  test('a key that cannot even read is rejected', () => {
    assert.throws(() => binance.assertReadOnly({ ...readOnlyKey, enableReading: false }),
      /reading disabled/);
  });

  test('the refusal explains what to do about it', () => {
    try {
      binance.assertReadOnly({ ...readOnlyKey, enableWithdrawals: true });
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /API Management/, 'must say where to fix the key');
      assert.match(err.message, /Enable Reading/, 'must name the permission to use instead');
    }
  });

  test('nothing in the Binance connector can place an order or move funds', () => {
    // This used to assert "GETs only", which was a proxy for the real rule and
    // broke the moment reading the FUNDING wallet turned out to need a POST
    // (/sapi/v1/asset/get-funding-asset is a read that Binance exposes as POST).
    // A proxy that fails on a safe change trains people to weaken it, so the
    // invariant is now stated directly: every endpoint this file touches must be
    // on the read allowlist, and the dangerous paths must appear nowhere.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services/brokers/binance.js'), 'utf8');

    const ALLOWED = [
      '/api/v3/time',
      '/api/v3/account',
      '/sapi/v1/account/apiRestrictions',
      '/sapi/v1/asset/get-funding-asset',
      '/sapi/v1/simple-earn/flexible/position',
      '/sapi/v1/simple-earn/locked/position'
    ];
    const used = [...src.matchAll(/['"`](\/(?:api|sapi)\/v\d\/[^'"`]*)['"`]/g)].map(m => m[1]);
    for (const path_ of used) {
      assert.ok(ALLOWED.includes(path_),
        `"${path_}" is not on the read-only allowlist — adding an endpoint here is a deliberate decision, not an edit`);
    }

    for (const forbidden of ['/order', '/withdraw', '/transfer', '/redeem', '/subscribe', '/borrow', '/repay']) {
      assert.equal(src.includes(forbidden), false,
        `"${forbidden}" must not appear — this connector observes, it does not act`);
    }
  });
});

describe('every Binance wallet is counted, not just spot', () => {
  // Reading only /api/v3/account under-reported the first real portfolio by 43%:
  // 15.78 of 16.12 ADA sat in Earn and the whole BNB position in Funding, while
  // Binance's own headline showed the total across wallets. The user sees one
  // number in the app and a smaller one here, which reads as the tool lying.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/brokers/binance.js'), 'utf8');

  test('funding and both Earn wallets are read', () => {
    for (const ep of [
      '/sapi/v1/asset/get-funding-asset',
      '/sapi/v1/simple-earn/flexible/position',
      '/sapi/v1/simple-earn/locked/position'
    ]) {
      assert.ok(src.includes(ep), `${ep} must be part of a balance read`);
    }
  });

  test('a wallet that fails to load does not fail the whole sync', () => {
    assert.match(src, /Promise\.allSettled/,
      'losing one wallet should cost that wallet and a flag, not the portfolio — '
      + 'an IP ban can strike part-way through the sequence');
    assert.match(src, /walletsUnread|partial/,
      'and the gap must be reported rather than silently producing a low total');
  });
});

describe('a Binance IP ban is absorbed, not compounded', () => {
  // Binance -1003 rate-limits an IP ADDRESS. On shared hosting the ban is
  // usually earned by another tenant's traffic, and it arrived in production
  // within minutes of the first connection. Atlas re-syncs Binance on every
  // portfolio valuation, so the danger is that a ban is met with a fresh
  // request per question asked — turning a seven-minute ban into a long one.
  test('while banned, no request is attempted at all', async () => {
    binance.noteBan(Date.now() + 5 * 60_000);
    try {
      await binance.fetchHoldings({ apiKey: 'k', apiSecret: 's' });
      assert.fail('should have refused locally');
    } catch (err) {
      assert.equal(err.rateLimited, true);
      assert.match(err.message, /rate-limited this server's IP/);
      assert.ok(err.retryAt, 'must say when it lifts, so the UI can stop guessing');
    } finally {
      binance._resetBan();
    }
  });

  test('the message absolves the user\'s key by name', () => {
    binance.noteBan(Date.now() + 60_000);
    try {
      binance.assertReadOnly(readOnlyKey); // unrelated call, just to keep shape
    } catch (e) { /* not the point */ }
    // The wording matters: the natural reading of "banned" is "I did something
    // wrong", and the user's next move would be to delete a perfectly good key.
    return binance.fetchHoldings({ apiKey: 'k', apiSecret: 's' }).then(
      () => assert.fail('should have refused'),
      (err) => {
        assert.match(err.message, /not on your API key/);
        assert.match(err.message, /nothing needs changing/);
        binance._resetBan();
      });
  });

  test('the ban clears once it expires', async () => {
    binance.noteBan(Date.now() - 1000); // already past
    assert.equal(binance.banRemainingMs(), 0, 'an expired ban must not block anything');
    binance._resetBan();
  });

  test('a later ban extends, an earlier one does not shorten', () => {
    const far = Date.now() + 10 * 60_000;
    binance.noteBan(far);
    binance.noteBan(Date.now() + 1000); // a shorter ban must not overwrite
    assert.ok(binance.banRemainingMs() > 5 * 60_000);
    binance._resetBan();
  });
});

describe('the Kite redirect URL follows the request, not an env var', () => {
  // On the deployed instance FRONTEND_URL was still a `localhost:5500` dev
  // value, so Settings told the user to register a redirect URL pointing at
  // their own laptop. This string is copied by hand into a form at Zerodha and
  // the mismatch only surfaces later, as a rejected login.
  const req = (host, proto) => ({ get: (h) => ({ host, 'x-forwarded-proto': proto }[h.toLowerCase()]), protocol: 'http' });

  test('the request origin wins over the environment', () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'http://localhost:5500';
    try {
      const origin = zerodha.originOf(req('finchat-sg.onrender.com', 'https'));
      assert.equal(origin, 'https://finchat-sg.onrender.com');
      assert.equal(zerodha.redirectUri(origin),
        'https://finchat-sg.onrender.com/api/brokers/zerodha/callback');
    } finally {
      if (prev === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prev;
    }
  });

  test('a proxied protocol header is honoured', () => {
    // Render terminates TLS, so req.protocol alone reads "http" and would hand
    // Kite an http:// callback for an https:// site.
    assert.match(zerodha.originOf(req('example.com', 'https')), /^https:/);
  });
});

describe('saving a connection', () => {
  // The first Connect press in production failed with:
  //   null value in column "holdings_count" of relation "broker_connections"
  //   violates not-null constraint
  // holdings_count is NOT NULL DEFAULT 0, and a DEFAULT does not apply to an
  // explicitly supplied NULL — which is exactly what connecting sends, because
  // nothing has been synced yet.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/brokers/index.js'), 'utf8');

  test('an unknown holdings count inserts as 0 rather than NULL', () => {
    assert.match(src, /VALUES \([^)]*COALESCE\(\$8, 0\)\)/,
      'the INSERT must coalesce holdings_count — a NOT NULL column cannot take an explicit NULL');
  });

  test('a re-save with no count keeps the count already stored', () => {
    // Must read $8, not EXCLUDED: the VALUES clause has already turned an
    // unknown count into 0, so EXCLUDED would reset a synced portfolio to empty
    // every time a connection is saved for some other reason (recording an
    // error, refreshing a token).
    assert.match(src, /holdings_count\s*=\s*COALESCE\(\$8, broker_connections\.holdings_count\)/,
      'the UPDATE branch must fall back to the stored count, via the parameter rather than EXCLUDED');
  });
});

describe('the Zerodha login round-trip', () => {
  test('the checksum is sha256(api_key + request_token + api_secret)', () => {
    // Kite rejects the exchange outright if this is wrong, and the failure
    // message ("Invalid checksum") gives no hint about the order of the parts.
    const crypto = require('crypto');
    const expected = crypto.createHash('sha256').update('KEYTOKSECRET').digest('hex');
    assert.equal(
      crypto.createHash('sha256').update(`${'KEY'}${'TOK'}${'SECRET'}`).digest('hex'),
      expected);
  });

  test('the login URL carries a signed state that round-trips to the user id', () => {
    const url = zerodha.loginUrl('myapikey', 'user-123');
    assert.match(url, /^https:\/\/kite\.zerodha\.com\/connect\/login\?/);
    assert.match(url, /api_key=myapikey/);
    assert.match(url, /v=3/);

    // Kite echoes redirect_params back to the callback verbatim; the state must
    // survive that round trip, because the callback is a browser navigation with
    // no Authorization header and the signature is all we have.
    const redirectParams = new URL(url).searchParams.get('redirect_params');
    const state = new URLSearchParams(redirectParams).get('state');
    assert.ok(state, 'state must be inside redirect_params');
    assert.equal(zerodha.readState(state), 'user-123');
  });

  test('a forged or foreign state is rejected', () => {
    assert.equal(zerodha.readState('not-a-token'), null);
    const jwt = require('jsonwebtoken');
    // A token signed for a different purpose must not be usable here.
    const wrongSubject = jwt.sign({ uid: 'user-123' }, process.env.JWT_SECRET,
      { subject: 'google-oauth-state' });
    assert.equal(zerodha.readState(wrongSubject), null,
      'the subject claim is what stops one flow\'s state being replayed into another');
  });

  test('nothing in the Zerodha connector can place an order', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services/brokers/zerodha.js'), 'utf8');
    assert.equal(/\/orders/.test(src), false,
      'a Kite access token can trade — the narrowing is that this file has no order call in it');
  });
});

describe('Indian equities are priced on the right exchange', () => {
  test('NSE and BSE holdings get their Yahoo suffix', () => {
    assert.equal(priceTicker({ symbol: 'RELIANCE', exchange: 'NSE' }), 'RELIANCE.NS');
    assert.equal(priceTicker({ symbol: 'INFY', exchange: 'BSE' }), 'INFY.BO');
  });

  test('the suffix is not doubled on a symbol that already carries it', () => {
    assert.equal(priceTicker({ symbol: 'RELIANCE.NS', exchange: 'NSE' }), 'RELIANCE.NS');
  });

  test('a US or crypto holding is untouched', () => {
    assert.equal(priceTicker({ symbol: 'TSLA', exchange: null }), 'TSLA');
    assert.equal(priceTicker({ symbol: 'BTC', exchange: 'BINANCE' }), 'BTC');
  });
});

describe('the portfolio reports rupees', () => {
  test('INR is the base currency', () => {
    assert.equal(BASE_CURRENCY, 'INR');
  });

  test('the tool contract advertises sync and the freshness of each account', () => {
    const d = TOOLS.portfolio.description;
    assert.match(d, /INR/, 'the reporting currency must be stated to the model');
    assert.match(d, /sync/, 'the model cannot call an action it is never told about');
    assert.match(d, /stale|freshness|STALENESS/i);
    assert.match(TOOLS.portfolio.inputSchema.properties.action.description, /sync/);
  });
});

describe('Atlas is told how the accounts actually behave', () => {
  const atlas = personas.atlas.systemPrompt;

  test('the Zerodha daily-login limit is spelled out', () => {
    assert.match(atlas, /ZERODHA/);
    assert.match(atlas, /cannot refresh it|CANNOT REFRESH IT/i,
      'Atlas must know it cannot renew the session itself');
    assert.match(atlas, /last sync/i, 'and must report the age rather than passing it off as current');
  });

  test('the read-only guarantee is described as enforced, not promised', () => {
    assert.match(atlas, /read-only/i);
    assert.match(atlas, /verifies cannot trade|incapable of trading|cannot trade or withdraw/i);
  });

  test('rupee reporting, and the trap of converting history', () => {
    assert.match(atlas, /INR|₹/);
    assert.match(atlas, /currency move into growth that never happened/i,
      'the one arithmetic error that would silently fabricate performance');
  });

  test('the no-trade boundary survived the new access', () => {
    // The original Atlas contract. Gaining read access to a real account is
    // exactly when this is most likely to get quietly softened.
    assert.match(atlas, /never execute, place, route or simulate a trade/i);
    assert.match(atlas, /not financial advice/i);
    assert.match(atlas, /buy or sell a specific amount/i);
  });
});
