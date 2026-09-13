// test/portfolio-alerts.test.js — alerts that fire once, and mean it.
//
// An alert system fails in two opposite ways, and both end the same: the user
// stops reading it. Too quiet and a crash goes unreported; too loud and a single
// drawdown texts them every 15 minutes until they mute the channel — after
// which the next real warning is never seen. The state machine in
// services/alerts/rules.js exists to sit between those, and these tests pin it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rules = require('../services/alerts/rules');
const { TOOLS } = require('../services/cognitive/ToolRegistry');
const { personas } = require('../services/personas');

const rule = (over = {}) => ({
  rule_id: 'r1', user_id: 'u1', symbol: 'ETH', kind: 'crypto',
  rule_type: 'drawdown_from_peak', threshold: 15, window_days: 30,
  state: 'armed', last_value: null, last_fired_at: null, ...over
});

const HOUR = 60 * 60 * 1000;

describe('evaluating a rule against the market', () => {
  test('drawdown is measured from the highest close in the window', () => {
    // Peak 120, live 96 -> 96/120 - 1 = -20%.
    const e = rules.evaluate(rule(), { live: { price: 96 }, closes: [100, 120, 110] });
    assert.equal(e.ok, true);
    assert.equal(e.value, -20);
    assert.equal(e.breached, true);
    assert.equal(rules.evaluate(rule({ threshold: 25 }), { live: { price: 96 }, closes: [100, 120, 110] }).breached, false);
  });

  test('a live price above every close is a new high, not a drawdown', () => {
    const e = rules.evaluate(rule(), { live: { price: 130 }, closes: [100, 120, 110] });
    assert.equal(e.value, 0);
    assert.equal(e.breached, false);
  });

  test('sharp 24-hour drop', () => {
    assert.equal(rules.evaluate(rule({ rule_type: 'sharp_drop', threshold: 10 }), { live: { price: 1, change24hPct: -12 } }).breached, true);
    assert.equal(rules.evaluate(rule({ rule_type: 'sharp_drop', threshold: 10 }), { live: { price: 1, change24hPct: -5 } }).breached, false);
  });

  test('price levels', () => {
    assert.equal(rules.evaluate(rule({ rule_type: 'price_below', threshold: 2000 }), { live: { price: 1990 } }).breached, true);
    assert.equal(rules.evaluate(rule({ rule_type: 'price_above', threshold: 3000 }), { live: { price: 3010 } }).breached, true);
  });

  test('a stablecoin off its peg', () => {
    // 0.985 is 1.5% off $1.
    const e = rules.evaluate(rule({ symbol: 'USDT', rule_type: 'depeg', threshold: 1 }), { live: { price: 0.985 } });
    assert.equal(e.breached, true);
    assert.equal(e.value, 1.5);
  });

  test('a break below the long-term average', () => {
    const e = rules.evaluate(rule({ rule_type: 'trend_break', threshold: 0, window_days: 200 }),
      { live: { price: 90 }, closes: Array(200).fill(100) });
    assert.equal(e.breached, true);
    assert.equal(e.value, -10);
  });

  test('a volatility regime change', () => {
    // 90 calm days alternating +/-0.5%, then 7 days swinging +/-5%.
    const closes = [100];
    for (let i = 0; i < 90; i++) closes.push(closes[closes.length - 1] * (i % 2 ? 1.005 : 0.995));
    for (let i = 0; i < 7; i++) closes.push(closes[closes.length - 1] * (i % 2 ? 1.05 : 0.95));
    const e = rules.evaluate(rule({ rule_type: 'volatility_spike', threshold: 2, window_days: 90 }), { closes });
    assert.equal(e.ok, true);
    assert.ok(e.value >= 2, `expected a spike ratio >= 2, got ${e.value}`);
    assert.equal(e.breached, true);
  });

  test('whole-portfolio drawdown from recorded snapshots', () => {
    const e = rules.evaluate(rule({ symbol: null, rule_type: 'portfolio_drawdown', threshold: 15 }),
      { portfolio: { latest: 850, peak: 1000, peakDate: '2026-09-01' } });
    assert.equal(e.value, -15);
    assert.equal(e.breached, true);
  });

  test('no price means no verdict, not a false all-clear', () => {
    const e = rules.evaluate(rule(), { closes: [100, 120] });
    assert.equal(e.ok, false);
  });
});

describe('the anti-spam state machine', () => {
  const breach = (value) => ({ ok: true, breached: value <= -15, value });

  test('an armed rule fires on its first breach', () => {
    assert.equal(rules.decide(rule(), breach(-16)), 'fire');
    assert.equal(rules.decide(rule(), breach(-10)), 'none');
  });

  test('a triggered rule stays QUIET while the move merely persists', () => {
    const fired = rule({ state: 'triggered', last_value: -16, last_fired_at: new Date(Date.now() - 10 * HOUR) });
    assert.equal(rules.decide(fired, breach(-17)), 'none',
      'still under the line but not meaningfully worse — sending again is the spam this exists to prevent');
  });

  test('a full day under the line sends ONE message, not ninety-six', () => {
    let r = rule();
    let sent = 0;
    let now = Date.now();
    for (let tick = 0; tick < 96; tick++) {
      const value = -16 - (tick % 3) * 0.5; // wobbling between -16 and -17
      const d = rules.decide(r, breach(value), now);
      if (d === 'fire' || d === 'escalate') {
        sent++;
        r = { ...r, state: 'triggered', last_value: value, last_fired_at: new Date(now) };
      }
      now += 15 * 60 * 1000;
    }
    assert.equal(sent, 1);
  });

  test('a deepening fall escalates, but only after the cooldown', () => {
    const recent = rule({ state: 'triggered', last_value: -15, last_fired_at: new Date(Date.now() - 1 * HOUR) });
    const old = rule({ state: 'triggered', last_value: -15, last_fired_at: new Date(Date.now() - 7 * HOUR) });
    // Half a threshold deeper: -15 -> -22.5.
    assert.equal(rules.decide(recent, breach(-23)), 'none', 'too soon after the last message');
    assert.equal(rules.decide(old, breach(-23)), 'escalate');
  });

  test('recovery re-arms only past the hysteresis line', () => {
    const fired = rule({ state: 'triggered', last_value: -16, last_fired_at: new Date(Date.now() - 10 * HOUR) });
    // A 15% rule re-arms once the drawdown is shallower than 7.5%.
    assert.equal(rules.decide(fired, breach(-10)), 'none', 'hovering near the line must not flap');
    assert.equal(rules.decide(fired, breach(-7)), 'rearm');
  });

  test('re-arming is what lets the NEXT fall be reported', () => {
    const rearmed = rule({ state: 'armed', last_value: -7 });
    assert.equal(rules.decide(rearmed, breach(-18)), 'fire');
  });
});

describe('what the message says', () => {
  const kinds = [
    [rule(), { ok: true, value: -20, detail: { peak: 120, price: 96, windowDays: 30 } }],
    [rule({ rule_type: 'sharp_drop', threshold: 10 }), { ok: true, value: -12, detail: { price: 2000 } }],
    [rule({ symbol: 'USDT', rule_type: 'depeg', threshold: 1 }), { ok: true, value: 1.5, detail: { price: 0.985 } }],
    [rule({ symbol: null, rule_type: 'portfolio_drawdown', threshold: 15 }), { ok: true, value: -15, detail: { latest: 850, peak: 1000 } }]
  ];

  test('every alert ends with the same not-a-recommendation line', () => {
    for (const [r, e] of kinds) {
      const { body } = rules.describe(r, e);
      assert.ok(body.endsWith(rules.CLOSING), `${r.rule_type} must end with the closing line`);
    }
  });

  test('no alert tells the user what to do with their money', () => {
    for (const [r, e] of kinds) {
      const { title, body } = rules.describe(r, e, { escalation: true });
      const text = `${title} ${body}`.replace(rules.CLOSING, '');
      assert.doesNotMatch(text, /\b(sell|buy|exit now|get out|withdraw)\b/i,
        `${r.rule_type} message must describe the move, not instruct: ${text}`);
    }
  });

  test('the closing line itself does not promise escape', () => {
    assert.doesNotMatch(rules.CLOSING, /in time|before it|guarantee|safe/i);
    assert.match(rules.CLOSING, /not a recommendation/);
  });
});

describe('a risk alert is never gated by the Telegram editor', () => {
  // services/telegramEditor.js scores mission and briefing reports 1-5 and HOLDS
  // anything below 4 in the app, with a cap of three audible alerts a day. That
  // is right for a research digest and exactly wrong for "your stablecoin has
  // lost its peg". Portfolio alerts pass through because they carry their own
  // type — and this pins it, so adding the type to the reviewed set later fails
  // here first instead of silently muting the one message that is time-critical.
  test('portfolio_alert is sent immediately, with sound, without an inference call', async () => {
    let editor;
    try {
      editor = require('../services/telegramEditor');
    } catch (err) {
      return; // the editor is not present in this build; nothing gates delivery
    }
    const { title, body } = rules.describe(
      rule({ symbol: 'USDT', rule_type: 'depeg', threshold: 1 }),
      { ok: true, value: 1.5, detail: { price: 0.985 } });

    const card = await editor.reviewForTelegram(
      { notification_id: 'n1', user_id: 'u1', type: 'portfolio_alert', title, content: body, link: null },
      { infer: () => { throw new Error('a risk alert must not wait on a model call'); }, previous: null, alertsToday: 99 });

    assert.equal(card.send, true, 'a risk alert must never be held in the app');
    assert.equal(card.silent, false, 'nor delivered silently');
    assert.equal(card.importance, null, 'nor scored by the reviewer');
  });

  test('tiny prices use subscript-zero notation', () => {
    assert.equal(rules.fmtPrice(0.000009876, 'USD'), '$0.0₅9876'); // five zeros after the point
    assert.equal(rules.fmtPrice(0.0016, 'USD'), '$0.0016');         // too few zeros to abbreviate
    assert.equal(rules.fmtPrice(2464.69, 'USD'), '$2,465');
    assert.equal(rules.fmtPrice(0.2121, 'USD'), '$0.2121');
  });

  test('a sub-cent price survives the editor\'s phone-number scrubber', () => {
    const { body } = rules.describe(
      rule({ symbol: 'PEPE', rule_type: 'price_below', threshold: 0.00001 }),
      { ok: true, value: 0.000009876, detail: { price: 0.000009876 } });
    const digitRun = (body.match(/\d[\d.,]*/g) || []).map((s) => s.replace(/\D/g, '').length);
    assert.ok(Math.max(...digitRun) < 10,
      'a 10+ digit run is scrubbed as a phone number, which would erase the price from the alert');
  });
});

describe('wiring', () => {
  test('both tools are registered and implemented', () => {
    assert.ok(TOOLS.analytics && TOOLS.alerts);
    const tm = fs.readFileSync(path.join(__dirname, '..', 'services/cognitive/ToolManager.js'), 'utf8');
    assert.match(tm, /analytics:\s*require\('\.\.\/\.\.\/tools\/AnalyticsTool'\)/);
    assert.match(tm, /alerts:\s*require\('\.\.\/\.\.\/tools\/AlertsTool'\)/);
  });

  test('the monitor runs even on ticks with no missions due', () => {
    // Most ticks claim nothing, and /tick returns early when that happens. An
    // alert check placed after that return would never run at all.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes/cron.js'), 'utf8');
    const monitorAt = src.indexOf("require('../services/alerts/monitor')");
    const earlyReturnAt = src.indexOf('claimed.length === 0');
    assert.ok(monitorAt > 0, 'the tick must start the alert monitor');
    assert.ok(monitorAt < earlyReturnAt, 'and must start it BEFORE the no-missions early return');
  });

  test('the migration gives atlas both tools and aurelius analytics only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'migrations/1720000000052_portfolio-alerts.js'), 'utf8');
    assert.match(src, /\['atlas', \['analytics', 'alerts'\]\]/);
    assert.match(src, /\['aurelius', \['analytics'\]\]/);
  });

  test('a disabled default is never recreated', () => {
    // ON CONFLICT DO NOTHING against the partial unique index: the disabled row
    // still occupies the slot, so ensureDefaults cannot bring it back.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services/alerts/monitor.js'), 'utf8');
    assert.match(src, /ON CONFLICT \(user_id, \(COALESCE\(symbol, '\*'\)\), rule_type\) WHERE created_by = 'default'\s+DO NOTHING/);
    const tool = fs.readFileSync(path.join(__dirname, '..', 'tools/AlertsTool.js'), 'utf8');
    assert.match(tool, /created_by === 'default'[\s\S]{0,300}enabled = false/,
      'removing a default must disable it, not delete it');
  });
});

describe('Atlas holds the line on advice', () => {
  const atlas = personas.atlas.systemPrompt;

  test('he knows the new tools exist', () => {
    assert.match(atlas, /"analytics"/);
    assert.match(atlas, /"alerts"/);
  });

  test('analytics are framed as the past, never a forecast', () => {
    assert.match(atlas, /describes the PAST/);
    assert.match(atlas, /never "it's going to fall"/);
  });

  test('"what should I buy and for how long" gets evidence, not a directive', () => {
    assert.match(atlas, /Answer with the evidence, not a directive/);
    assert.match(atlas, /won't tell them what to buy or how long to hold/);
    assert.match(atlas, /Never pick a winner, never name a holding period as the right one, never size a position/);
  });

  test('alerts are not oversold', () => {
    assert.match(atlas, /CANNOT see a fall coming/);
    assert.match(atlas, /Never promise "you'll get out in time"/);
  });

  test('the original no-trade boundary is untouched', () => {
    assert.match(atlas, /never execute, place, route or simulate a trade/i);
    assert.match(atlas, /buy or sell a specific amount/i);
  });
});
