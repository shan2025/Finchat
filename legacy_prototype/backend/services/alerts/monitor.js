// services/alerts/monitor.js — the 15-minute watch over what people hold.
//
// Driven by the existing cron tick (pg_cron -> /api/cron/tick every 15 min), so
// it needs no scheduler of its own and survives Render's free-tier spin-down:
// the tick's request is what wakes the container.
//
// For each user holding anything:
//   1. keep their portfolio valuation no more than six hours old — that is what
//      keeps the snapshot series (and so the portfolio-drawdown rule) current;
//   2. make sure every material holding has default protection;
//   3. claim their due rules atomically, so two overlapping ticks cannot both
//      fire the same alert;
//   4. fetch each needed price once, evaluate every rule, and act on the
//      decision from rules.js — fire, escalate, re-arm, or stay quiet.
//
// Decisions live in rules.js and are pure. This file is only I/O, and its most
// important property is that one user's failure (a delisted coin, a price feed
// outage, a Binance IP ban) never stops anyone else's alerts from running.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../database');
const history = require('../quant/history');
const rules = require('./rules');

const VALUATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Holdings below this share of the portfolio get no default rules. A ₹0.03 coin
// crashing 90% is noise, and a Telegram message about it teaches the user to
// ignore the next one.
const DEFAULT_MIN_WEIGHT_PCT = 5;
// A rule is claimed at most this often, however many ticks overlap.
const MIN_EVAL_INTERVAL_MIN = 10;
const MAX_USERS_PER_RUN = 25;

// The protection every material holding gets unless the user switches it off.
// Chosen to be rare and meaningful rather than sensitive: these fire on moves
// a person would genuinely want to be interrupted for.
const DEFAULTS = {
  risky: [
    { rule_type: 'drawdown_from_peak', threshold: 15, window_days: 30 },
    { rule_type: 'sharp_drop', threshold: 10 }
  ],
  stable: [
    { rule_type: 'depeg', threshold: 1 }
  ],
  portfolio: [
    { rule_type: 'portfolio_drawdown', threshold: 15, window_days: 30 }
  ]
};

// ── Portfolio context ────────────────────────────────────────────

async function latestSnapshot(userId) {
  const r = await query(`
    SELECT captured_at, holdings FROM portfolio_snapshots
     WHERE user_id = $1 ORDER BY captured_on DESC LIMIT 1`, [userId]);
  return r.rows[0] || null;
}

/** Material holdings, with kind/exchange from the live table and weight from the valuation. */
async function materialHoldings(userId, { refresh = true } = {}) {
  let snap = await latestSnapshot(userId);
  const stale = !snap || Date.now() - new Date(snap.captured_at).getTime() > VALUATION_MAX_AGE_MS;

  if (stale && refresh) {
    try {
      await require('../../tools/PortfolioTool').execute({ action: 'value' }, { userId });
      snap = await latestSnapshot(userId);
    } catch (err) {
      // A failed valuation still leaves yesterday's weights usable.
      console.warn(`[alerts] valuation refresh failed for ${userId}: ${err.message}`);
    }
  }
  if (!snap) return [];

  const held = typeof snap.holdings === 'string' ? JSON.parse(snap.holdings) : (snap.holdings || []);
  const rows = await query(
    'SELECT symbol, kind, exchange FROM portfolio_holdings WHERE user_id = $1', [userId]);
  const meta = new Map(rows.rows.map((r) => [`${r.symbol}|${r.kind}`, r]));

  return held
    .filter((h) => (h.weightPct || 0) >= DEFAULT_MIN_WEIGHT_PCT)
    .map((h) => {
      const x = meta.get(`${h.symbol}|${h.kind}`) || {};
      return { symbol: h.symbol, kind: h.kind, exchange: x.exchange || null, weightPct: h.weightPct };
    });
}

/**
 * Create default rules that do not exist yet. ON CONFLICT DO NOTHING against
 * the partial unique index is what makes this safe to call every tick: a
 * default the user DISABLED is still a row, so it is never recreated.
 */
async function ensureDefaults(userId, holdings) {
  if (!holdings.length) return 0;
  const want = [];
  for (const h of holdings) {
    const set = history.isStablecoin(h.symbol) ? DEFAULTS.stable : DEFAULTS.risky;
    for (const d of set) want.push({ ...d, symbol: h.symbol, kind: h.kind, exchange: h.exchange });
  }
  for (const d of DEFAULTS.portfolio) want.push({ ...d, symbol: null, kind: null, exchange: null });

  let created = 0;
  for (const d of want) {
    const r = await query(`
      INSERT INTO portfolio_alert_rules
        (rule_id, user_id, symbol, kind, exchange, rule_type, threshold, window_days, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'default')
      ON CONFLICT (user_id, (COALESCE(symbol, '*')), rule_type) WHERE created_by = 'default'
      DO NOTHING
    `, [`rule_${uuidv4()}`, userId, d.symbol, d.kind, d.exchange, d.rule_type, d.threshold, d.window_days || null]);
    created += r.rowCount;
  }
  return created;
}

// ── Market data, fetched once per asset per run ──────────────────

function neededDays(ruleList) {
  let days = 0;
  for (const r of ruleList) {
    const spec = rules.TYPES[r.rule_type];
    if (spec && spec.needs.includes('closes')) {
      days = Math.max(days, (r.window_days || spec.defaultWindow || 30) + 10);
    }
  }
  return days;
}

async function gatherMarket(userId, ruleList) {
  const bySymbol = new Map();
  for (const r of ruleList) {
    if (!r.symbol) continue;
    const key = `${r.symbol}|${r.kind || 'crypto'}|${r.exchange || ''}`;
    if (!bySymbol.has(key)) bySymbol.set(key, { symbol: r.symbol, kind: r.kind || 'crypto', exchange: r.exchange, rules: [] });
    bySymbol.get(key).rules.push(r);
  }

  const market = new Map();
  for (const [key, a] of bySymbol) {
    const entry = {};
    const needsLive = a.rules.some((r) => rules.TYPES[r.rule_type]?.needs.includes('live'));
    const days = neededDays(a.rules);
    if (needsLive) {
      try { entry.live = await history.live(a); } catch (err) { entry.liveError = err.message; }
    }
    if (days > 0) {
      try { entry.closes = (await history.closes({ ...a, days })).prices; } catch (err) { entry.historyError = err.message; }
    }
    market.set(key, entry);
  }

  let portfolio = null;
  if (ruleList.some((r) => r.rule_type === 'portfolio_drawdown')) {
    const win = Math.max(...ruleList.filter((r) => r.rule_type === 'portfolio_drawdown').map((r) => r.window_days || 30));
    const s = await query(`
      SELECT captured_on, total_value_inr FROM portfolio_snapshots
       WHERE user_id = $1 AND total_value_inr IS NOT NULL
         AND captured_on >= (now() AT TIME ZONE 'utc')::date - $2::integer
       ORDER BY captured_on ASC`, [userId, win]);
    // Two points minimum: one snapshot is a value, not a drawdown.
    if (s.rows.length >= 2) {
      let peak = s.rows[0];
      for (const row of s.rows) if (Number(row.total_value_inr) > Number(peak.total_value_inr)) peak = row;
      portfolio = {
        latest: Number(s.rows[s.rows.length - 1].total_value_inr),
        peak: Number(peak.total_value_inr),
        peakDate: String(peak.captured_on instanceof Date ? peak.captured_on.toISOString() : peak.captured_on).slice(0, 10)
      };
    }
  }

  return { market, portfolio };
}

// ── Acting on a decision ─────────────────────────────────────────

async function act(rule, evaluation, decision, { dryRun, currency }) {
  if (decision === 'fire' || decision === 'escalate') {
    const escalation = decision === 'escalate';
    const { title, body } = rules.describe(rule, evaluation, { escalation, currency });
    const severity = rules.severityOf(rule, evaluation, escalation);
    if (dryRun) return { ruleId: rule.rule_id, decision, severity, title };

    await query(`
      INSERT INTO portfolio_alert_events
        (event_id, rule_id, user_id, symbol, rule_type, severity, observed_value, threshold, title, message, escalation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [`alert_${uuidv4()}`, rule.rule_id, rule.user_id, rule.symbol, rule.rule_type, severity,
      evaluation.value, rule.threshold, title, body, escalation]);

    await query(`
      UPDATE portfolio_alert_rules
         SET state = 'triggered', last_value = $2, last_fired_at = now(), last_error = NULL, updated_at = now()
       WHERE rule_id = $1`, [rule.rule_id, evaluation.value]);

    // createNotification fans out to every channel the user enabled — Telegram
    // included — which is the difference between an alert and a log line.
    await require('../notifications').createNotification({
      userId: rule.user_id,
      type: 'portfolio_alert',
      title: `${severity === 'critical' ? '🔴' : '🟠'} ${title}`,
      content: body,
      link: 'finchat_chat.html'
    });
    return { ruleId: rule.rule_id, decision, severity, title };
  }

  if (decision === 'rearm') {
    if (!dryRun) {
      await query(`
        UPDATE portfolio_alert_rules SET state = 'armed', last_value = $2, last_error = NULL, updated_at = now()
         WHERE rule_id = $1`, [rule.rule_id, evaluation.value]);
    }
    return { ruleId: rule.rule_id, decision };
  }

  return null;
}

// ── One user ─────────────────────────────────────────────────────

async function monitorUser(userId, { dryRun = false } = {}) {
  const summary = { userId, defaultsCreated: 0, evaluated: 0, fired: [], rearmed: 0, errors: [] };

  const holdings = await materialHoldings(userId, { refresh: !dryRun });
  if (!dryRun) summary.defaultsCreated = await ensureDefaults(userId, holdings);

  // A dry run reads rules without claiming them, so asking "would anything fire
  // right now?" can never swallow a real alert due on the next tick.
  const claimed = dryRun
    ? await query('SELECT * FROM portfolio_alert_rules WHERE user_id = $1 AND enabled = true', [userId])
    : await query(`
        UPDATE portfolio_alert_rules
           SET last_evaluated_at = now()
         WHERE rule_id IN (
           SELECT rule_id FROM portfolio_alert_rules
            WHERE user_id = $1 AND enabled = true
              AND (last_evaluated_at IS NULL OR last_evaluated_at < now() - ($2 || ' minutes')::interval)
            FOR UPDATE SKIP LOCKED)
        RETURNING *`, [userId, String(MIN_EVAL_INTERVAL_MIN)]);

  const ruleList = claimed.rows;
  if (!ruleList.length) return summary;

  const { market, portfolio } = await gatherMarket(userId, ruleList);

  for (const rule of ruleList) {
    const key = rule.symbol ? `${rule.symbol}|${rule.kind || 'crypto'}|${rule.exchange || ''}` : null;
    const data = key ? market.get(key) || {} : {};
    const evaluation = rules.evaluate(rule, { live: data.live, closes: data.closes, portfolio });
    summary.evaluated++;

    if (!evaluation.ok) {
      const why = evaluation.error || data.liveError || data.historyError;
      summary.errors.push({ ruleId: rule.rule_id, symbol: rule.symbol, error: why });
      if (!dryRun) {
        await query('UPDATE portfolio_alert_rules SET last_error = $2 WHERE rule_id = $1', [rule.rule_id, why]);
      }
      continue;
    }

    const decision = rules.decide(rule, evaluation);
    const currency = (data.live && data.live.currency) || (rule.kind === 'stock' ? 'INR' : 'USD');
    const outcome = await act(rule, evaluation, decision, { dryRun, currency });
    if (outcome && (outcome.decision === 'fire' || outcome.decision === 'escalate')) summary.fired.push(outcome);
    if (outcome && outcome.decision === 'rearm') summary.rearmed++;
  }

  return summary;
}

// ── Everyone ─────────────────────────────────────────────────────

async function runMonitor({ userId = null, dryRun = false } = {}) {
  const users = userId
    ? [userId]
    : (await query(`
        SELECT DISTINCT user_id FROM portfolio_holdings
        LIMIT $1`, [MAX_USERS_PER_RUN])).rows.map((r) => r.user_id);

  const results = [];
  for (const u of users) {
    try {
      results.push(await monitorUser(u, { dryRun }));
    } catch (err) {
      // One user's broken data must never cost everyone else their alerts.
      console.error(`[alerts] monitor failed for ${u}: ${err.message}`);
      results.push({ userId: u, error: err.message });
    }
  }

  const fired = results.reduce((a, r) => a + ((r.fired && r.fired.length) || 0), 0);
  if (fired) console.log(`🚨 [alerts] ${fired} alert(s) fired across ${results.length} user(s)`);
  return { users: results.length, fired, results };
}

module.exports = { runMonitor, monitorUser, ensureDefaults, materialHoldings, DEFAULTS, DEFAULT_MIN_WEIGHT_PCT };
