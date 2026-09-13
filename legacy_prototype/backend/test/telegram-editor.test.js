// test/telegram-editor.test.js — what reaches Telegram, and in what shape.
//
// Fixtures are trimmed from real reports delivered on 13 Sep 2026, when every
// mission report still went to Telegram verbatim.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const ed = require('../services/telegramEditor');

const CRYPTO_ALL_UNAVAILABLE = `# ₿ CRYPTO INTELLIGENCE BRIEF

## MARKET PULSE
The crypto market remains in a cautious stance today, with major coins hovering near key support levels. While Bitcoin and Ethereum have shown modest 24-hour declines, the broader market is largely influenced by regulatory chatter and institutional sentiment rather than macro-economic data.

## BTC — PRICE UNAVAILABLE (24H CHANGE UNAVAILABLE)
1. Regulatory pressure: ongoing regulatory scrutiny, especially from the SEC and EU regulators.

## ETH — PRICE UNAVAILABLE (24H CHANGE UNAVAILABLE)
1. Protocol upgrades: the market is still digesting the recent "London" hard fork.

## SOL — PRICE UNAVAILABLE (24H CHANGE UNAVAILABLE)
1. Regulatory uncertainty around DeFi platforms, many of which rely on Solana's infrastructure.

## 🎯 KEY TAKEAWAY
Today's crypto market is largely shaped by regulatory uncertainty and institutional moves rather than macro-economic shocks.`;

const CRYPTO_WITH_PRICES = `# ₿ CRYPTO INTELLIGENCE BRIEF

## MARKET PULSE
Crypto markets are trading in a narrow range today, with Bitcoin (BTC) barely up 0.01% and Ethereum (ETH) down 0.01% over the past 24 hours. The overall sentiment is neutral-to-cautious as investors digest a mix of macro-risk factors.

## BTC — $77,275.50 (+0.01%)
Bitcoin's price is essentially flat. Signal: NEUTRAL.

## ETH — $2,525.19 (-0.01%)
A recent whale movement of $108 M worth of ETH to exchanges sparked speculation of short-term selling pressure.
Signal: NEUTRAL-SLIGHT BEARISH.

## SOL — $22.34 (+0.15%)
Solana posted a modest gain. Signal: SLIGHT BULLISH.

## 🎯 KEY TAKEAWAY
Crypto markets are in a hold-steady phase. Investors should keep an eye on SEC regulatory releases and any large-scale whale movements.

Sources
[1] https://www.sec.gov/newsroom/press-releases/2026-76-sec-proposes-new-regulation-crypto-assets`;

const mission = (content, extra = {}) => ({
  notification_id: 'notif_1', user_id: 'u1', type: 'mission',
  title: '🗓️ Mission report: Crypto brief (6h)', content, link: null, ...extra
});
const verdict = (v) => async () => JSON.stringify(v);

describe('telegramEditor — delivery decision', () => {
  test('importance 5 alerts, 4 is silent, 1–3 is held', () => {
    assert.deepStrictEqual(ed.decide(5), { send: true, silent: false });
    assert.deepStrictEqual(ed.decide(4), { send: true, silent: true });
    assert.strictEqual(ed.decide(3).send, false);
    assert.strictEqual(ed.decide(2).send, false);
    assert.strictEqual(ed.decide(1).send, false);
  });

  test('past the daily alert cap, a 5 still arrives but silently', async () => {
    assert.deepStrictEqual(ed.decide(5, ed.MAX_ALERTS_PER_DAY), { send: true, silent: true });
    const r = await ed.reviewForTelegram(mission(CRYPTO_WITH_PRICES), {
      previous: null, alertsToday: ed.MAX_ALERTS_PER_DAY,
      infer: verdict({ importance: 5, reason: 'whale deposit', headline: 'A $108 M ETH deposit hit exchanges.', points: [] })
    });
    assert.strictEqual(r.send, true);
    assert.strictEqual(r.silent, true);
    assert.match(r.reason, /alerts already today/);
  });

  test('a short failed run is reviewed, not passed through', async () => {
    let called = false;
    const r = await ed.reviewForTelegram(mission(
      'I’m ready to craft the Crypto Market Intelligence Brief, but I still need the latest price. Could you let me pull that data?'), {
      previous: null,
      infer: async () => { called = true; return '{"importance":1,"reason":"asked a question instead of reporting","headline":"No brief.","points":[]}'; }
    });
    assert.ok(called);
    assert.strictEqual(r.send, false);
  });

  test('a brief whose prices were all unavailable is held even if the reviewer rates it highly', async () => {
    const r = await ed.reviewForTelegram(mission(CRYPTO_ALL_UNAVAILABLE), {
      previous: null,
      infer: verdict({ importance: 5, reason: 'big', headline: 'Crypto is cautious today.', points: [], action: '' })
    });
    assert.strictEqual(r.send, false);
    assert.strictEqual(r.importance, 1);
    assert.match(r.reason, /unavailable/);
  });

  test('a flat brief the reviewer calls routine is held', async () => {
    const r = await ed.reviewForTelegram(mission(CRYPTO_WITH_PRICES), {
      previous: { payload: 'Crypto brief (6h)\nMarkets flat.', created_at: new Date() },
      infer: verdict({ importance: 2, reason: 'same as last brief', headline: 'Markets flat.', points: [], action: '' })
    });
    assert.strictEqual(r.send, false);
    assert.strictEqual(r.importance, 2);
  });

  test('the reviewer is shown the last card sent on the topic', async () => {
    let seen = '';
    await ed.reviewForTelegram(mission(CRYPTO_WITH_PRICES), {
      previous: { payload: 'PREVIOUS CARD TEXT', created_at: new Date('2026-09-13T01:00:00Z') },
      infer: async ({ messages }) => { seen = messages[1].content; return '{"importance":3,"headline":"x","points":[]}'; }
    });
    assert.match(seen, /PREVIOUS CARD TEXT/);
    assert.match(seen, /TOPIC: Crypto brief \(6h\)/);
  });

  test('a reviewer failure still delivers a short excerpt, silently, unless the data was missing', async () => {
    const held = await ed.reviewForTelegram(mission(CRYPTO_ALL_UNAVAILABLE), {
      previous: null, infer: async () => { throw new Error('all providers down'); }
    });
    assert.strictEqual(held.send, false);

    const long = CRYPTO_WITH_PRICES + '\n\n' + 'Liquidity remains solid across majors and no panic selling was observed. '.repeat(12);
    const r = await ed.reviewForTelegram(mission(long), {
      previous: null,
      infer: async () => { throw new Error('all providers down'); }
    });
    assert.strictEqual(r.send, true);
    assert.strictEqual(r.silent, true);
    assert.match(r.reason, /reviewer unavailable/);
    assert.match(r.text, /hold-steady phase/);
    assert.ok(r.text.length < 600, `excerpt should be short, got ${r.text.length}`);

    const short = await ed.reviewForTelegram(mission(CRYPTO_WITH_PRICES), {
      previous: null, infer: async () => { throw new Error('all providers down'); }
    });
    assert.strictEqual(short.send, false, 'a short report is not sent unreviewed');
  });

  test('unparseable reviewer output is treated as a reviewer failure', async () => {
    const r = await ed.reviewForTelegram(mission(CRYPTO_WITH_PRICES), { previous: null, infer: async () => 'sure! here you go' });
    assert.match(r.reason, /no usable verdict/);
  });

  test('almost-JSON from the reviewer is salvaged, not discarded', () => {
    // Verbatim DeepSeek output for the 288-char failed crypto run, 13 Sep 2026.
    const raw = '{"importance":1,"reason":"Run asked for data instead of reporting; no substance","headline":"Crypto brief could not be produced; no price or headline data was gathered","points":[],"action":"","}';
    const v = ed.parseReview(raw);
    assert.strictEqual(v.importance, 1);
    assert.match(v.headline, /could not be produced/);
    assert.deepStrictEqual(v.points, []);
  });

  test('the fallback headline does not split sentences on decimal points', () => {
    const h = ed.fallbackHeadline('KEY TAKEAWAY\nBitcoin is flat at +0.15% near $77,386.50 today. Watch the SEC. Third sentence.');
    assert.strictEqual(h, 'Bitcoin is flat at +0.15% near $77,386.50 today. Watch the SEC.');
  });

  test('short notifications pass straight through', async () => {
    let called = false;
    const r = await ed.reviewForTelegram(
      { notification_id: 'n', user_id: 'u', type: 'system', title: '🔔 Test notification', content: 'This is a test.' },
      { infer: async () => { called = true; return ''; } });
    assert.strictEqual(called, false);
    assert.strictEqual(r.send, true);
    assert.strictEqual(r.silent, false);
    assert.strictEqual(r.html, '<b>Test notification</b>\nThis is a test.');
  });
});

describe('telegramEditor — the card', () => {
  test('is short, HTML-escaped, and ends with a link to the full report', async () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://finchat-sg.onrender.com/';
    try {
      const r = await ed.reviewForTelegram(mission(CRYPTO_WITH_PRICES), {
        previous: null, alertsToday: 0,
        infer: verdict({
          importance: 5, reason: 'whale deposit',
          headline: 'A $108 M ETH deposit to exchanges <may> signal selling [4].',
          points: ['BTC $77,275.50 (+0.01%)', 'ETH $2,525.19 (-0.01%)', 'SOL $22.34 (+0.15%)', 'a fourth point'],
          action: 'Watch SEC regulatory releases'
        })
      });
      assert.strictEqual(r.send, true);
      assert.strictEqual(r.silent, false);
      assert.ok(r.html.startsWith('<b>Crypto brief (6h)</b>\n'));
      assert.match(r.html, /&lt;may&gt; signal selling\./);
      assert.doesNotMatch(r.html, /\[4\]/, 'citation markers are stripped');
      assert.strictEqual((r.html.match(/^• /gm) || []).length, 3, 'at most three points');
      assert.match(r.html, /<i>Next:<\/i> Watch SEC regulatory releases/);
      assert.match(r.html, /<a href="https:\/\/finchat-sg\.onrender\.com\/finchat_agents\.html\?report=notif_1">Read full report<\/a>$/);
      assert.ok(r.html.length < 700, `card should be short, got ${r.html.length}`);
      assert.doesNotMatch(r.html, /sec\.gov/, 'no source dump');
    } finally {
      if (prev === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prev;
    }
  });

  test('a point quoting a number that is not in the report is dropped', () => {
    const src = ed.numbersIn('BTC — $77,275.50 (+0.01%) ETH $2,525.19');
    assert.ok(ed.isGrounded('BTC $77,275.50', src));
    assert.ok(ed.isGrounded('BTC around $77,276', src), 'rounding is allowed');
    assert.ok(!ed.isGrounded('BTC $81,000', src));

    const card = ed.buildCard({
      title: 'Mission report: Crypto brief (6h)',
      sourcePlain: 'BTC — $77,275.50 (+0.01%). Markets are flat today and nothing much moved.',
      review: { headline: 'Markets are flat.', points: ['BTC $77,275.50', 'SOL jumped 40%'], action: '' },
      link: null
    });
    assert.match(card.text, /BTC \$77,275\.50/);
    assert.doesNotMatch(card.text, /40%/);
  });

  test('an ungrounded headline falls back to a real one', () => {
    const card = ed.buildCard({
      title: 'x',
      sourcePlain: 'Flat day.\n\nKEY TAKEAWAY\nNothing moved more than 1% today. Stay patient.',
      review: { headline: 'BTC fell 12% overnight.', points: [], action: '' },
      link: null
    });
    assert.doesNotMatch(card.text, /12%/);
    assert.match(card.text, /Nothing moved more than 1% today\./);
  });

  test('email addresses and phone numbers never go out', () => {
    const s = ed.scrubPersonal('Reach Muhammed at +91 7593948066 or shadin2266@gmail.com. BTC $77,275.50 on 2026-09-12.');
    assert.doesNotMatch(s, /7593948066|gmail/);
    assert.match(s, /\$77,275\.50/);
    assert.match(s, /2026-09-12/);
    // Long numbers that are clearly amounts survive; separators alone make a phone.
    const n = ed.scrubPersonal('PEPE at $0.000009876; 1,800,000,000 roles; call 555.123.4567 or 7593948066');
    assert.match(n, /\$0\.000009876/);
    assert.match(n, /1,800,000,000/);
    assert.doesNotMatch(n, /555\.123\.4567|7593948066/);
  });

  test('no link without a public https origin', () => {
    const prevF = process.env.FRONTEND_URL, prevR = process.env.RENDER_EXTERNAL_URL;
    process.env.FRONTEND_URL = 'http://localhost:3000';
    delete process.env.RENDER_EXTERNAL_URL;
    try {
      assert.strictEqual(ed.reportLink({ notification_id: 'n1' }), null);
      process.env.FRONTEND_URL = 'https://finchat-sg.onrender.com';
      assert.strictEqual(
        ed.reportLink({ notification_id: 'n1', link: 'finchat_chat.html?session=s1' }),
        'https://finchat-sg.onrender.com/finchat_chat.html?session=s1');
    } finally {
      if (prevF === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prevF;
      if (prevR !== undefined) process.env.RENDER_EXTERNAL_URL = prevR;
    }
  });

  test('topic labels lose the emoji and mission framing', () => {
    assert.strictEqual(ed.topicLabel('🗓️ Mission report: Daily job hunt'), 'Daily job hunt');
    assert.strictEqual(ed.topicLabel('🌅 Morning Intelligence Brief'), 'Morning Intelligence Brief');
  });
});
