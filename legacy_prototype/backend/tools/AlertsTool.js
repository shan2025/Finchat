// tools/AlertsTool.js — Atlas's control over what is being watched.
//
// The monitor (services/alerts/monitor.js) runs every 15 minutes whether or not
// anyone is chatting. This tool is how the user shapes it through Atlas:
// "warn me if ETH drops below $2,000", "tell me if my portfolio falls 10%",
// "what are you watching?", "is anything wrong right now?".
//
// Every rule belongs to the signed-in user and is read and written with
// user_id in the WHERE clause — an id from someone else's rule matches nothing.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const rules = require('../services/alerts/rules');
const history = require('../services/quant/history');

const MAX_RULES_PER_USER = 40;

function parseInput(input) {
  if (input && typeof input === 'object') return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) { try { return JSON.parse(s); } catch (e) { /* fall through */ } }
  return { action: s || 'list' };
}

const view = (r) => {
  const out = {
    ruleId: r.rule_id,
    watching: r.symbol || 'whole portfolio',
    type: r.rule_type,
    threshold: Number(r.threshold),
    unit: rules.TYPES[r.rule_type]?.unit,
    enabled: r.enabled,
    state: r.state,
    createdBy: r.created_by
  };
  if (r.window_days) out.windowDays = r.window_days;
  if (r.last_fired_at) out.lastFiredAt = r.last_fired_at;
  if (r.last_error) out.lastError = r.last_error;
  if (r.note) out.note = r.note;
  return out;
};

/** What a held symbol is, so a rule on it prices the same instrument the portfolio holds. */
async function resolveHolding(userId, symbol) {
  const r = await query(
    'SELECT symbol, kind, exchange FROM portfolio_holdings WHERE user_id = $1 AND upper(symbol) = upper($2) LIMIT 1',
    [userId, symbol]);
  return r.rows[0] || null;
}

async function execute(input, context = {}) {
  const o = parseInput(input);
  const action = String(o.action || 'list').toLowerCase();
  const userId = context.userId;
  if (!userId || userId === 'system') throw new Error('Alerts need a signed-in user.');

  if (action === 'list') {
    const [r, ev] = await Promise.all([
      query(`SELECT * FROM portfolio_alert_rules WHERE user_id = $1
             ORDER BY enabled DESC, symbol NULLS FIRST, rule_type`, [userId]),
      query(`SELECT symbol, rule_type, severity, title, fired_at FROM portfolio_alert_events
             WHERE user_id = $1 ORDER BY fired_at DESC LIMIT 5`, [userId])
    ]);
    return {
      action,
      rules: r.rows.map(view),
      recentAlerts: ev.rows,
      howItWorks: 'Checked every 15 minutes. A rule fires once when its line is crossed, escalates only if the move deepens further after a 6-hour cooldown, and re-arms silently once it recovers. Alerts go to every notification channel the user enabled (Telegram included).',
      note: r.rows.length ? undefined : 'Nothing is being watched yet. Default protection is added automatically for any holding worth at least 5% of the portfolio on the next monitor pass.'
    };
  }

  if (action === 'create') {
    const type = String(o.type || o.ruleType || '').toLowerCase();
    const spec = rules.TYPES[type];
    if (!spec) {
      throw new Error(`Unknown alert type "${type}". Use one of: ${Object.keys(rules.TYPES).join(', ')}.`);
    }
    const portfolioLevel = type === 'portfolio_drawdown';
    const symbol = portfolioLevel ? null : String(o.symbol || '').trim().toUpperCase();
    if (!portfolioLevel && !symbol) throw new Error(`A "${type}" alert needs a symbol.`);

    const threshold = o.threshold != null ? Number(o.threshold) : spec.defaultThreshold;
    if (!Number.isFinite(threshold) || (spec.unit !== 'price' && threshold < 0)) {
      throw new Error(`"${type}" needs a threshold${spec.unit === 'price' ? ' price' : ` in ${spec.unit}`}.`);
    }
    if ((type === 'price_below' || type === 'price_above') && !(threshold > 0)) {
      throw new Error('A price alert needs the price level to watch, in the asset\'s own quote currency (USD for crypto, INR for NSE/BSE stocks).');
    }
    if (type === 'depeg' && symbol && !history.isStablecoin(symbol)) {
      throw new Error(`${symbol} is not a stablecoin — a depeg alert only makes sense for USDT, USDC and similar.`);
    }

    const count = await query('SELECT COUNT(*)::int AS n FROM portfolio_alert_rules WHERE user_id = $1', [userId]);
    if (count.rows[0].n >= MAX_RULES_PER_USER) {
      throw new Error(`There are already ${MAX_RULES_PER_USER} alert rules. Remove some before adding more.`);
    }

    // Use the instrument the portfolio actually holds (NSE vs BSE, crypto vs
    // stock); fall back to what the caller said for an asset not held.
    const held = symbol ? await resolveHolding(userId, symbol) : null;
    const kind = held ? held.kind : (o.kind || 'crypto');
    const exchange = held ? held.exchange : (o.exchange || null);

    const res = await query(`
      INSERT INTO portfolio_alert_rules
        (rule_id, user_id, symbol, kind, exchange, rule_type, threshold, window_days, created_by, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'atlas',$9)
      RETURNING *`, [`rule_${uuidv4()}`, userId, symbol, portfolioLevel ? null : kind, exchange, type, threshold,
      o.windowDays ? Math.round(Number(o.windowDays)) : (spec.defaultWindow || null), o.note || null]);

    return {
      action,
      created: view(res.rows[0]),
      heldInPortfolio: symbol ? Boolean(held) : undefined,
      note: 'Active from the next 15-minute check. Tell the user what will trigger it in plain words, and that it is a notice, not a sell signal.'
    };
  }

  if (action === 'update') {
    if (!o.ruleId) throw new Error('Give the ruleId to update (from "list").');
    const sets = [];
    const vals = [o.ruleId, userId];
    if (o.threshold != null) { vals.push(Number(o.threshold)); sets.push(`threshold = $${vals.length}`); }
    if (o.windowDays != null) { vals.push(Math.round(Number(o.windowDays))); sets.push(`window_days = $${vals.length}`); }
    if (o.enabled != null) { vals.push(o.enabled === true || o.enabled === 'true'); sets.push(`enabled = $${vals.length}`); }
    if (!sets.length) throw new Error('Nothing to change — pass threshold, windowDays or enabled.');
    // A changed threshold means the old trigger state no longer describes this
    // rule; re-arm it so the new line is judged from scratch.
    if (o.threshold != null) sets.push("state = 'armed'", 'last_value = NULL');
    const res = await query(`
      UPDATE portfolio_alert_rules SET ${sets.join(', ')}, updated_at = now()
       WHERE rule_id = $1 AND user_id = $2 RETURNING *`, vals);
    if (!res.rows.length) throw new Error('No alert rule with that id belongs to this user.');
    return { action, updated: view(res.rows[0]) };
  }

  if (action === 'remove' || action === 'delete') {
    if (!o.ruleId) throw new Error('Give the ruleId to remove (from "list").');
    const r = await query('SELECT created_by FROM portfolio_alert_rules WHERE rule_id = $1 AND user_id = $2', [o.ruleId, userId]);
    if (!r.rows.length) throw new Error('No alert rule with that id belongs to this user.');
    // A default is DISABLED, never deleted: deleting it would let the monitor
    // quietly recreate it on the next pass, which is the opposite of what the
    // user asked for.
    if (r.rows[0].created_by === 'default') {
      await query("UPDATE portfolio_alert_rules SET enabled = false, updated_at = now() WHERE rule_id = $1 AND user_id = $2", [o.ruleId, userId]);
      return { action, disabled: o.ruleId, note: 'This was default protection, so it is switched off rather than deleted — it will not come back on its own.' };
    }
    await query('DELETE FROM portfolio_alert_rules WHERE rule_id = $1 AND user_id = $2', [o.ruleId, userId]);
    return { action, removed: o.ruleId };
  }

  if (action === 'check') {
    // Evaluate everything now WITHOUT notifying or changing any rule's state.
    const { monitorUser } = require('../services/alerts/monitor');
    const s = await monitorUser(userId, { dryRun: true });
    return {
      action,
      rulesEvaluated: s.evaluated,
      wouldFireNow: s.fired,
      couldNotEvaluate: s.errors.length ? s.errors : undefined,
      note: s.fired.length
        ? 'These lines are crossed right now. A rule that has ALREADY fired will not message the user again until the move deepens or it recovers and re-crosses.'
        : 'No monitored line is crossed right now.'
    };
  }

  if (action === 'history') {
    const days = Math.max(1, Math.min(Number(o.days) || 30, 365));
    const ev = await query(`
      SELECT symbol, rule_type, severity, observed_value, threshold, title, escalation, fired_at
        FROM portfolio_alert_events
       WHERE user_id = $1 AND fired_at >= now() - ($2 || ' days')::interval
       ORDER BY fired_at DESC LIMIT 50`, [userId, String(days)]);
    return { action, days, alerts: ev.rows, count: ev.rows.length };
  }

  throw new Error(`Unknown alerts action "${action}". Use list, create, update, remove, check or history.`);
}

module.exports = { execute };
