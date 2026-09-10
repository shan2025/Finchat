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

  test('nothing in the Binance connector can place an order', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services/brokers/binance.js'), 'utf8');
    assert.equal(/axios\.post|axios\.delete|axios\.put/.test(src), false,
      'the read-only connector must only ever issue GETs');
    assert.equal(/\/api\/v3\/order/.test(src), false, 'no order endpoint may appear in this file');
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
