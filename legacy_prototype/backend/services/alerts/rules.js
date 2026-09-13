// services/alerts/rules.js — when is a risk line crossed, and when do we say so.
//
// Pure: no network, no database, no clock except the `now` passed in. The
// monitor gathers prices and hands them here; this decides. Keeping the
// decision pure is what lets the anti-spam behaviour be tested exhaustively —
// and anti-spam is most of the difficulty. A drawdown lasts days. A monitor that
// simply re-checked "is it below the line?" every 15 minutes would send the same
// warning to someone's phone ~96 times a day, and they would mute it by lunch,
// which is the one outcome that makes an alert system worse than none.
//
// So a rule is a small state machine:
//
//   armed ──breach──▶ FIRE ──▶ triggered
//   triggered ──worsens by a step, after cooldown──▶ ESCALATE (stays triggered)
//   triggered ──clears past the hysteresis line──▶ REARM (silent) ──▶ armed
//
// Hysteresis matters as much as the cooldown: a price hovering around a line
// would otherwise fire, re-arm and fire again on every wobble. A 15% drawdown
// rule only re-arms once the drawdown has recovered to 7.5%.
//
// NOTHING HERE PREDICTS. Every rule describes a move that has already begun.
// That is the honest version of "warn me before it goes wrong": catch it within
// minutes of crossing a line, rather than whenever the user next looks.

const m = require('../quant/metrics');

const TYPES = {
  drawdown_from_peak: { needs: ['live', 'closes'], unit: '%', defaultThreshold: 15, defaultWindow: 30 },
  sharp_drop: { needs: ['live'], unit: '%', defaultThreshold: 10 },
  price_below: { needs: ['live'], unit: 'price' },
  price_above: { needs: ['live'], unit: 'price' },
  trend_break: { needs: ['live', 'closes'], unit: '%', defaultThreshold: 0, defaultWindow: 200 },
  volatility_spike: { needs: ['closes'], unit: 'x', defaultThreshold: 2, defaultWindow: 90 },
  depeg: { needs: ['live'], unit: '%', defaultThreshold: 1 },
  portfolio_drawdown: { needs: ['portfolio'], unit: '%', defaultThreshold: 15, defaultWindow: 30 }
};

// Escalations need BOTH a deeper move and this much quiet time since the last
// message. Six hours: long enough that a volatile afternoon is one message,
// short enough that a real overnight collapse is not slept through.
const ESCALATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

/**
 * Measure a rule against current market data.
 * @returns {{ ok:boolean, breached?:boolean, value?:number, detail?:object, error?:string }}
 */
function evaluate(rule, market = {}) {
  const t = Number(rule.threshold);
  const type = rule.rule_type;
  const spec = TYPES[type];
  if (!spec) return { ok: false, error: `Unknown rule type "${type}".` };

  const live = market.live;
  const closes = Array.isArray(market.closes) ? market.closes : [];

  if (spec.needs.includes('live') && (!live || !Number.isFinite(live.price))) {
    return { ok: false, error: 'No live price available.' };
  }

  switch (type) {
    case 'drawdown_from_peak': {
      const win = rule.window_days || spec.defaultWindow;
      const recent = closes.slice(-win);
      if (!recent.length) return { ok: false, error: 'No price history for the drawdown window.' };
      // The live price counts toward the peak: an asset making a new high today
      // is at 0% drawdown, not measured against yesterday's close.
      const peak = Math.max(...recent, live.price);
      const dd = (live.price / peak - 1) * 100;
      return { ok: true, breached: dd <= -t, value: round(dd), detail: { peak, price: live.price, windowDays: win } };
    }
    case 'sharp_drop': {
      const c = Number(live.change24hPct);
      if (!Number.isFinite(c)) return { ok: false, error: 'No 24-hour change available.' };
      return { ok: true, breached: c <= -t, value: round(c), detail: { price: live.price } };
    }
    case 'price_below':
      return { ok: true, breached: live.price <= t, value: live.price, detail: { price: live.price } };
    case 'price_above':
      return { ok: true, breached: live.price >= t, value: live.price, detail: { price: live.price } };
    case 'trend_break': {
      const win = rule.window_days || spec.defaultWindow;
      const avg = m.sma(closes, win);
      if (avg == null) return { ok: false, error: `Needs ${win} days of history for the ${win}-day average.` };
      const gap = (live.price / avg - 1) * 100;
      return { ok: true, breached: live.price < avg, value: round(gap), detail: { average: avg, price: live.price, windowDays: win } };
    }
    case 'volatility_spike': {
      const win = rule.window_days || spec.defaultWindow;
      const longR = m.returns(closes.slice(-(win + 1)));
      const shortR = m.returns(closes.slice(-8)); // the last 7 daily returns
      const longSd = m.stdev(longR);
      const shortSd = m.stdev(shortR);
      if (!longSd || shortSd == null) return { ok: false, error: 'Not enough history to compare volatility regimes.' };
      const ratio = shortSd / longSd;
      return {
        ok: true,
        breached: ratio >= t,
        value: round(ratio),
        detail: {
          shortAnnualPct: round(shortSd * Math.sqrt(365) * 100, 1),
          longAnnualPct: round(longSd * Math.sqrt(365) * 100, 1),
          windowDays: win
        }
      };
    }
    case 'depeg': {
      const dev = Math.abs(live.price - 1) * 100;
      return { ok: true, breached: dev >= t, value: round(dev, 3), detail: { price: live.price } };
    }
    case 'portfolio_drawdown': {
      const p = market.portfolio;
      if (!p || !Number.isFinite(p.latest) || !Number.isFinite(p.peak) || p.peak <= 0) {
        return { ok: false, error: 'Not enough recorded portfolio history yet.' };
      }
      const dd = (p.latest / p.peak - 1) * 100;
      return { ok: true, breached: dd <= -t, value: round(dd), detail: { latest: p.latest, peak: p.peak, peakDate: p.peakDate } };
    }
    default:
      return { ok: false, error: `Unhandled rule type "${type}".` };
  }
}

/** Has a triggered rule recovered far enough to re-arm? (hysteresis) */
function cleared(rule, value) {
  const t = Number(rule.threshold);
  switch (rule.rule_type) {
    case 'drawdown_from_peak':
    case 'portfolio_drawdown':
    case 'sharp_drop': return value > -t * 0.5;
    case 'price_below': return value >= t * 1.02;
    case 'price_above': return value <= t * 0.98;
    case 'trend_break': return value >= 1;
    case 'volatility_spike': return value <= t * 0.75;
    case 'depeg': return value <= t * 0.5;
    default: return false;
  }
}

/** Has a triggered rule got materially worse since the last message? */
function worsened(rule, value) {
  const t = Number(rule.threshold);
  const last = rule.last_value == null ? null : Number(rule.last_value);
  if (last == null || !Number.isFinite(last)) return false;
  switch (rule.rule_type) {
    // Another half-threshold deeper: a 15% rule fired at -15 escalates at -22.5.
    case 'drawdown_from_peak':
    case 'portfolio_drawdown':
    case 'sharp_drop': return value <= last - Math.max(t * 0.5, 1);
    case 'price_below': return value <= last * 0.95;
    case 'volatility_spike': return value >= last + 1;
    case 'depeg': return value >= last * 2;
    // A trend break and an upside level are single events, not a descent.
    default: return false;
  }
}

/**
 * Decide what to do with an evaluation.
 * @returns {'fire'|'escalate'|'rearm'|'none'}
 */
function decide(rule, evaluation, now = Date.now()) {
  if (!evaluation || !evaluation.ok) return 'none';
  const state = rule.state || 'armed';

  if (state === 'armed') return evaluation.breached ? 'fire' : 'none';

  // triggered
  if (cleared(rule, evaluation.value)) return 'rearm';
  if (evaluation.breached && worsened(rule, evaluation.value)) {
    const last = rule.last_fired_at ? new Date(rule.last_fired_at).getTime() : 0;
    if (now - last >= ESCALATION_COOLDOWN_MS) return 'escalate';
  }
  return 'none';
}

function severityOf(rule, evaluation, escalation) {
  if (escalation) return 'critical';
  const t = Number(rule.threshold);
  const v = evaluation.value;
  switch (rule.rule_type) {
    case 'drawdown_from_peak':
    case 'portfolio_drawdown':
    case 'sharp_drop': return v <= -t * 1.5 ? 'critical' : 'warning';
    case 'depeg': return v >= 3 ? 'critical' : 'warning';
    default: return 'warning';
  }
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/**
 * A price too small for fixed decimals, in the subscript-zero notation crypto
 * screeners use: 0.000009876 -> "0.0₅9876", the subscript counting the zeros
 * after the decimal point.
 *
 * Two problems solved at once. Fixed decimals print a sub-cent token as
 * "0.0000", which says nothing. And writing the zeros out makes a digit run the
 * Telegram editor's phone scrubber treats as a number to remove — ten digits
 * including leading zeros, so the price would vanish from the very alert that is
 * about the price. Subscript digits are not ASCII digits, so the run is broken.
 */
function tinyPrice(p) {
  let exp = Math.floor(Math.log10(p));
  let mant = p / 10 ** exp;
  if (Number(mant.toFixed(3)) >= 10) { exp += 1; mant = p / 10 ** exp; } // 9.9996 rounds up a decade
  const zeros = -exp - 1;
  const sig = mant.toFixed(3).replace('.', '').replace(/0+$/, '') || '0';
  if (zeros < 3) return String(Number(p.toPrecision(4)));
  return `0.0${String(zeros).split('').map((d) => SUBSCRIPT[d]).join('')}${sig}`;
}

const fmtPrice = (p, cur) => {
  if (!Number.isFinite(p)) return '—';
  const sym = cur === 'INR' ? '₹' : '$';
  if (p > 0 && p < 0.01) return `${sym}${tinyPrice(p)}`;
  const digits = p < 1 ? 4 : p < 100 ? 2 : 0;
  return `${sym}${p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

// Every message ends the same way. It is the line that keeps this a notice and
// not an instruction, and it is not negotiable per alert.
const CLOSING = 'This is a notice that a risk line was crossed, not a recommendation. Whether to hold, reduce or exit is your call — ask Atlas for the full risk read first.';

/** Build the notification. Short enough to read on a lock screen. */
function describe(rule, evaluation, { escalation = false, currency = 'USD' } = {}) {
  const s = rule.symbol || 'Your portfolio';
  const d = evaluation.detail || {};
  const v = evaluation.value;
  const again = escalation ? ' — and still falling' : '';
  let title;
  let body;

  switch (rule.rule_type) {
    case 'drawdown_from_peak':
      title = `${s} is ${Math.abs(v)}% below its ${d.windowDays}-day high${again}`;
      body = `${s} is at ${fmtPrice(d.price, currency)}, down ${Math.abs(v)}% from its ${d.windowDays}-day high of ${fmtPrice(d.peak, currency)}. Your line was ${rule.threshold}%.`;
      break;
    case 'portfolio_drawdown':
      title = `Your portfolio is ${Math.abs(v)}% below its ${rule.window_days || 30}-day peak${again}`;
      body = `Recorded value ₹${Math.round(d.latest).toLocaleString('en-IN')} against a peak of ₹${Math.round(d.peak).toLocaleString('en-IN')}${d.peakDate ? ` on ${d.peakDate}` : ''}. Your line was ${rule.threshold}%.`;
      break;
    case 'sharp_drop':
      title = `${s} fell ${Math.abs(v)}% in 24 hours${again}`;
      body = `${s} is at ${fmtPrice(d.price, currency)}, down ${Math.abs(v)}% over the last 24 hours. Your line was ${rule.threshold}%.`;
      break;
    case 'price_below':
      title = `${s} dropped below ${fmtPrice(Number(rule.threshold), currency)}${again}`;
      body = `${s} is at ${fmtPrice(v, currency)}, below the ${fmtPrice(Number(rule.threshold), currency)} level you set.`;
      break;
    case 'price_above':
      title = `${s} rose above ${fmtPrice(Number(rule.threshold), currency)}`;
      body = `${s} is at ${fmtPrice(v, currency)}, above the ${fmtPrice(Number(rule.threshold), currency)} level you set.`;
      break;
    case 'trend_break':
      title = `${s} broke below its ${d.windowDays}-day average`;
      body = `${s} is at ${fmtPrice(d.price, currency)}, ${Math.abs(v)}% under its ${d.windowDays}-day average of ${fmtPrice(d.average, currency)} — the common definition of a long-term downtrend.`;
      break;
    case 'volatility_spike':
      title = `${s} has turned unusually volatile${again}`;
      body = `${s}'s last 7 days swung at ${d.shortAnnualPct}% annualised, ${v}x its ${d.windowDays}-day norm of ${d.longAnnualPct}%. Large moves in either direction are more likely while this lasts.`;
      break;
    case 'depeg':
      title = `${s} is off its $1 peg by ${v}%${again}`;
      body = `${s} is trading at ${fmtPrice(d.price, 'USD')}. A stablecoin that loses its peg can fall much further quickly — this is worth checking now.`;
      break;
    default:
      title = `${s}: alert`;
      body = `A monitored condition was met (value ${v}).`;
  }

  return { title, body: `${body}\n\n${CLOSING}` };
}

module.exports = {
  TYPES, ESCALATION_COOLDOWN_MS, CLOSING,
  evaluate, cleared, worsened, decide, severityOf, describe, fmtPrice
};
