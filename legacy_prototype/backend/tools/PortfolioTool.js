// tools/PortfolioTool.js — the user's actual positions, priced live.
//
// The watchlist answers "what am I following"; this answers "what do I own,
// what is it worth now, and how is it distributed". Aurelius needs the second
// question to say anything useful about a real portfolio — allocation and
// concentration are the only things a review can honestly be about without
// knowing size and cost basis.
//
// Hard boundary, same as the persona's: this tool records and prices holdings.
// It never places, routes, or simulates a trade. Since the broker connections
// were added it does reach credentials — but only ever to READ positions, and
// only credentials the user connected themselves on the Settings page. Binance
// keys are refused at connect time unless they are read-only; the Zerodha path
// can fetch holdings and nothing else. Adding a holding is bookkeeping, not
// buying, and syncing is reading, not trading.
//
// Positions carry a `source`: 'manual' for what the user told us, 'binance' or
// 'zerodha' for what their accounts report. A sync only ever replaces its own
// source's rows, so the two kinds of truth never overwrite each other.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

const KINDS = new Set(['crypto', 'stock', 'commodity', 'cash']);
const CRYPTO_TICKERS = new Set(['btc', 'eth', 'sol', 'doge', 'xrp', 'ada', 'dot', 'link', 'avax', 'matic', 'bnb', 'ltc', 'trx', 'shib', 'usdt', 'usdc']);
const COMMODITIES = new Set(['gold', 'silver', 'oil', 'copper', 'platinum', 'natural gas', 'gas', 'wheat', 'coffee']);

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
  }
  const m = s.match(/^(list|add|remove|value|update|history|sync)\b\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase(), symbol: m[2].trim() || undefined };
  return { action: 'value' };
}

// ── Reporting currency ───────────────────────────────────────────
// Totals are reported in INR: this user's equity book is a Zerodha book, and a
// net worth quoted in dollars is a number they would have to convert in their
// head before it meant anything. Positions keep their own currency — an NSE
// holding is INR, a Binance coin is USD — and the conversion is stated with the
// rate it used, never applied silently.
const BASE_CURRENCY = 'INR';

/** USD→INR, once per valuation. Null when FX is unavailable — never guessed. */
async function usdInrRate() {
  try {
    const fx = await require('./ForexTool').execute({ from: 'USD', to: 'INR' });
    const rate = Number(fx && fx.rate);
    return isFinite(rate) && rate > 0 ? rate : null;
  } catch (err) {
    return null;
  }
}

function guessKind(symbol) {
  const s = String(symbol || '').toLowerCase().trim();
  if (COMMODITIES.has(s)) return 'commodity';
  if (CRYPTO_TICKERS.has(s)) return 'crypto';
  if (s === 'cash' || s === 'usd' || s === 'inr') return 'cash';
  return 'stock';
}

const num = (v) => (v == null ? null : Number(v));
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +Number(v).toFixed(d));

// Yahoo quotes Indian equities with a market suffix — RELIANCE is a different
// instrument from RELIANCE.NS, and asking for the bare symbol either fails or
// returns some unrelated listing. The exchange comes from the broker that
// reported the holding, so this is a lookup, not a guess.
const EXCHANGE_SUFFIX = { NSE: '.NS', BSE: '.BO' };

function priceTicker(h) {
  const suffix = EXCHANGE_SUFFIX[String(h.exchange || '').toUpperCase()];
  if (!suffix) return h.symbol;
  return h.symbol.endsWith(suffix) ? h.symbol : `${h.symbol}${suffix}`;
}

// Price one holding through the same tools the agent would call by hand, so a
// portfolio valuation and a spot price question can never disagree.
async function priceHolding(h) {
  const symbol = h.symbol;
  try {
    if (h.kind === 'cash') return { price: 1, source: 'cash', changePercent: 0 };
    if (h.kind === 'crypto') {
      const out = await require('./CryptoTool').execute({ symbol });
      if (out && out.priceUsd) return { price: out.priceUsd, changePercent: out.change24h ?? null, source: out.source || 'coingecko', currency: 'USD' };
      return { error: (out && out.error) || `no price for ${symbol}` };
    }
    if (h.kind === 'commodity') {
      const out = await require('./CommoditiesTool').execute({ commodity: symbol });
      const r = out && out.results && out.results[0];
      if (r && r.price) return { price: r.price, changePercent: r.changePercent ?? null, source: r.source, currency: r.currency || 'USD' };
      return { error: (r && r.error) || `no price for ${symbol}` };
    }
    const ticker = priceTicker(h);
    const out = await require('./StockTool').execute({ ticker });
    if (out && out.price) {
      return {
        price: out.price, changePercent: out.changePercent ?? null, source: 'yahoo',
        currency: out.currency || (h.currency || 'USD')
      };
    }
    // The broker already told us the price at sync time. Yahoo has no quote for
    // plenty of Indian small-caps, and "could not be priced" is a bad answer
    // when the number is sitting in the row — as long as we say where it came
    // from and how old it is.
    if (h.broker_price != null) {
      return {
        price: num(h.broker_price),
        changePercent: null,
        currency: h.currency || 'INR',
        source: `${h.source} (at last sync)`,
        stale: true,
        asOf: h.broker_price_at
      };
    }
    return { error: (out && out.error) || `no price for ${ticker}` };
  } catch (err) {
    // Same fallback on a thrown lookup, for the same reason.
    if (h.broker_price != null) {
      return {
        price: num(h.broker_price), changePercent: null, currency: h.currency || 'INR',
        source: `${h.source} (at last sync)`, stale: true, asOf: h.broker_price_at
      };
    }
    return { error: err.message };
  }
}

async function rows(userId) {
  const res = await query(
    'SELECT * FROM portfolio_holdings WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
  return res.rows;
}

function view(r) {
  return {
    symbol: r.symbol, kind: r.kind, quantity: num(r.quantity),
    avgCost: num(r.avg_cost), currency: r.currency, note: r.note,
    // Where this position came from. A review that cannot tell a synced holding
    // from one the user typed in six months ago cannot tell them which numbers
    // are still true.
    source: r.source || 'manual',
    exchange: r.exchange || null,
    syncedAt: r.synced_at || null
  };
}

// ── The daily series ─────────────────────────────────────────────
// A valuation is only meaningful against a baseline, so pricing the portfolio
// also RECORDS it: one row per UTC day, rewritten in place. That keeps the
// series one-point-per-day however often the portfolio is priced, and means a
// user who never asks for history still accumulates one by using the tool.
//
// A snapshot must never be able to break a valuation — if the write fails the
// user still gets their numbers, they just lose one day of history.
async function writeSnapshot(userId, valuation) {
  try {
    // Both currencies AND the rate that linked them on the day. Storing only one
    // would force a later conversion at today's rate, which turns a rupee move
    // into portfolio growth that never happened.
    await query(`
      INSERT INTO portfolio_snapshots (
        snapshot_id, user_id, captured_on, captured_at,
        total_value_usd, total_cost_basis_usd, holdings_count, holdings, allocation,
        total_value_inr, total_cost_basis_inr, fx_usd_inr)
      VALUES ($1,$2,(now() AT TIME ZONE 'utc')::date,now(),$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id, captured_on) DO UPDATE SET
        captured_at          = now(),
        total_value_usd      = EXCLUDED.total_value_usd,
        total_cost_basis_usd = EXCLUDED.total_cost_basis_usd,
        holdings_count       = EXCLUDED.holdings_count,
        holdings             = EXCLUDED.holdings,
        allocation           = EXCLUDED.allocation,
        total_value_inr      = EXCLUDED.total_value_inr,
        total_cost_basis_inr = EXCLUDED.total_cost_basis_inr,
        fx_usd_inr           = EXCLUDED.fx_usd_inr
    `, [
      uuidv4(), userId,
      valuation.totalValueUsd,
      valuation.fxUsdInr && valuation.totalCostBasisInr != null
        ? round(valuation.totalCostBasisInr / valuation.fxUsdInr) : null,
      valuation.holdingsCount,
      JSON.stringify(valuation.holdings.map(h => ({
        symbol: h.symbol, kind: h.kind, quantity: h.quantity,
        price: h.price, currency: h.currency,
        marketValue: h.marketValueInr, weightPct: h.weightPct
      }))),
      JSON.stringify(valuation.allocation),
      valuation.totalValueInr, valuation.totalCostBasisInr, valuation.fxUsdInr
    ]);
  } catch (err) {
    // Most likely cause is the migration not having run yet on this database.
    console.warn('[portfolio] snapshot not recorded:', err.message);
  }
}

// Change between two snapshots, as a signed absolute and a percent. Returns
// null rather than 0 when there is nothing to compare against, so a report can
// say "no baseline yet" instead of claiming a flat day.
function delta(current, past) {
  if (current == null || past == null || !isFinite(past) || past === 0) return null;
  return { changeUsd: round(current - past), changePct: round(((current - past) / past) * 100) };
}

function pickOnOrBefore(series, daysAgo) {
  const cutoff = new Date(Date.now() - daysAgo * 86400000);
  // series is oldest-first; the last row at or before the cutoff is the
  // fairest baseline when a day is missing (a weekend, or an unused day).
  let best = null;
  for (const s of series) {
    if (new Date(s.capturedOn) <= cutoff) best = s; else break;
  }
  return best;
}

async function execute(input, context = {}) {
  const opts = parseInput(input);
  const action = String(opts.action || 'value').toLowerCase();
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Portfolio access requires a signed-in user.');
  }

  if (action === 'add' || action === 'update') {
    const entries = Array.isArray(opts.holdings) ? opts.holdings : [opts];
    const saved = [];
    for (const e of entries.slice(0, 30)) {
      const symbol = String(e.symbol || e.ticker || e.asset || '').trim();
      if (!symbol) continue;
      const kind = KINDS.has(String(e.kind || '').toLowerCase())
        ? String(e.kind).toLowerCase() : guessKind(symbol);
      const quantity = Number(e.quantity ?? e.qty ?? e.units);
      if (!isFinite(quantity)) {
        throw new Error(`Holding "${symbol}" needs a numeric "quantity" (how many units/shares/coins are held). Ask the user rather than assuming a size.`);
      }
      // Always 'manual': this path is the user telling us what they hold. A
      // broker sync writes its own source and the two never collide, so
      // recording a coin by hand cannot corrupt what Binance reports.
      const res = await query(`
        INSERT INTO portfolio_holdings
          (holding_id, user_id, symbol, kind, quantity, avg_cost, currency, note, source, exchange)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9)
        ON CONFLICT (user_id, symbol, kind, source) DO UPDATE SET
          quantity = EXCLUDED.quantity,
          avg_cost = COALESCE(EXCLUDED.avg_cost, portfolio_holdings.avg_cost),
          note     = COALESCE(EXCLUDED.note, portfolio_holdings.note),
          exchange = COALESCE(EXCLUDED.exchange, portfolio_holdings.exchange),
          updated_at = now()
        RETURNING *
      `, [uuidv4(), userId, symbol.toUpperCase(), kind, quantity,
        e.avgCost != null ? Number(e.avgCost) : null, (e.currency || 'USD').toUpperCase(),
        e.note || null, e.exchange ? String(e.exchange).toUpperCase() : null]);
      saved.push(view(res.rows[0]));
    }
    if (!saved.length) throw new Error('Nothing to add — pass {"action":"add","symbol":"BTC","quantity":0.5,"avgCost":42000}.');
    return { action, saved, holdings: (await rows(userId)).map(view), disclaimer: 'Bookkeeping only — no trade was placed.' };
  }

  if (action === 'remove') {
    const symbol = String(opts.symbol || '').trim();
    if (!symbol) throw new Error('Portfolio "remove" needs a symbol.');

    // Only manual rows can be removed. A broker-sourced position is a fact about
    // an account we can read: deleting it would make the portfolio disagree with
    // the exchange until the next sync silently put it back. Say so instead.
    const res = await query(`
      DELETE FROM portfolio_holdings
       WHERE user_id = $1 AND upper(symbol) = upper($2) AND source = 'manual'
       RETURNING symbol`, [userId, symbol]);

    if (!res.rows.length) {
      const synced = await query(`
        SELECT symbol, source FROM portfolio_holdings
         WHERE user_id = $1 AND upper(symbol) = upper($2) AND source <> 'manual'`, [userId, symbol]);
      if (synced.rows.length) {
        const from = [...new Set(synced.rows.map(r => r.source))].join(' and ');
        return {
          action, removed: 0,
          holdings: (await rows(userId)).map(view),
          note: `${symbol.toUpperCase()} is reported by ${from}, not entered by hand, so it cannot be removed here — it would reappear on the next sync. Tell the user it will disappear on its own once the position is closed at the broker, or that they can disconnect ${from} in Settings.`
        };
      }
    }

    return {
      action, removed: res.rows.length,
      holdings: (await rows(userId)).map(view),
      note: res.rows.length ? undefined : `"${symbol}" was not in the portfolio.`,
      disclaimer: 'Removed from the record only — nothing was sold.'
    };
  }

  // ── sync ───────────────────────────────────────────────────────
  // Pull fresh positions from the connected brokers. Reading only; there is no
  // path from here to an order. Reports per-broker outcomes rather than throwing,
  // because "Zerodha needs a login" is information the user needs, not a failure.
  if (action === 'sync') {
    const brokers = require('../services/brokers');
    const results = await brokers.syncAll(userId, { includeManualOnes: true });
    if (!results.length) {
      return {
        action, results: [],
        note: 'No brokerage accounts are connected. The user can connect Binance (read-only key) or Zerodha in Settings → Connected accounts. Until then, the portfolio only contains what they have entered by hand.'
      };
    }
    const needsLogin = results.filter(r => r.reason === 'needs_login').map(r => r.broker);
    return {
      action, results,
      holdings: (await rows(userId)).map(view),
      note: needsLogin.length
        ? `${needsLogin.join(', ')} could not be refreshed because the daily broker login has expired. Say plainly that those holdings are as of the last sync, and that only the user can renew it from Settings.`
        : undefined,
      disclaimer: 'Positions were read from the connected accounts. Nothing was traded.'
    };
  }

  if (action === 'list') {
    const all = await rows(userId);
    return {
      action, count: all.length, holdings: all.map(view),
      note: all.length ? undefined : 'The portfolio is empty. Ask the user what they hold (symbol, quantity, and average cost if they know it) before offering a review.'
    };
  }

  if (action === 'value') {
    const brokers = require('../services/brokers');

    // Refresh what can be refreshed without a human first, so a valuation is of
    // the portfolio as it is rather than as it was last time someone looked.
    // Only the unattended-capable brokers: retrying Zerodha's expired token on
    // every valuation would just rewrite the same error.
    const syncs = await brokers.syncAll(userId).catch(() => []);
    const sources = await brokers.freshness(userId).catch(() => []);

    const all = await rows(userId);
    if (!all.length) {
      return {
        action, count: 0, holdings: [], sources,
        note: sources.length
          ? 'The connected accounts reported no positions. Say that plainly — do not treat it as an error, and do not invent holdings.'
          : 'The portfolio is empty and no brokerage account is connected, so there is nothing to value. Tell the user they can connect Binance or Zerodha in Settings → Connected accounts, or give you their holdings (symbol, quantity, avg cost) to record by hand. Do NOT review a hypothetical portfolio as though it were theirs.'
      };
    }

    // A Zerodha holding is priced in rupees and a Binance coin in dollars. Once
    // both are in the same portfolio, adding marketValue across them without
    // converting produces a number that is not any currency at all — and it
    // would look perfectly plausible. Everything below is normalised to INR
    // first, and a missing FX rate is reported rather than assumed.
    const fxUsdInr = await usdInrRate();
    const currencies = new Set(all.map(h => (h.currency || 'USD').toUpperCase()));
    const needsFx = currencies.has('USD') && currencies.size > 1;

    const toInr = (value, currency) => {
      if (value == null) return null;
      const cur = (currency || 'USD').toUpperCase();
      if (cur === 'INR') return value;
      if (cur === 'USD') return fxUsdInr ? value * fxUsdInr : null;
      return null; // an unexpected currency is not silently treated as dollars
    };

    // Every field here is re-sent to the model on each reasoning iteration, so
    // the ones that are always null, always identical, or trivially derivable
    // are pure cost. An 11-coin portfolio was spending ~1,000 tokens per turn on
    // this array, which is what tipped a run over its budget mid-answer.
    // Anything omitted is either stated once elsewhere (syncedAt lives on
    // `sources`) or absent because it genuinely is not known.
    const drop = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
      return out;
    };

    const priced = await Promise.all(all.map(async (h) => {
      const p = await priceHolding(h);
      const qty = num(h.quantity) || 0;
      // The currency of the PRICE, which is what the value is denominated in —
      // not the currency recorded on the row, which can lag a re-listing.
      const currency = (p.currency || h.currency || 'USD').toUpperCase();
      const value = p.price != null ? qty * p.price : null;
      const cost = h.avg_cost != null ? qty * num(h.avg_cost) : null;
      const source = h.source || 'manual';
      return drop({
        symbol: h.symbol, kind: h.kind, quantity: qty,
        currency,
        price: round(p.price, p.price != null && p.price < 10 ? 4 : 2),
        change24hPct: p.changePercent != null ? round(p.changePercent) : null,
        // The rupee value is the one every total is built from. The native
        // figure is only worth spelling out when it is a different number.
        marketValue: currency === BASE_CURRENCY ? null : round(value),
        marketValueInr: round(toInr(value, currency)),
        costBasisInr: round(toInr(cost, currency)),
        unrealizedPnlInr: value != null && cost != null ? round(toInr(value - cost, currency)) : null,
        unrealizedPnlPct: value != null && cost ? round(((value - cost) / cost) * 100) : null,
        // Which account holds it. `exchange` is only informative when it says
        // something the source does not — NSE vs BSE matters, "BINANCE" under
        // heldAt: binance does not.
        heldAt: source,
        exchange: h.exchange && h.exchange.toLowerCase() !== source.toLowerCase() ? h.exchange : null,
        // Named only when it is NOT an ordinary live quote: a broker's
        // last-sync price is a weaker claim and the agent must be able to see
        // the difference.
        priceStale: p.stale === true ? { source: p.source, asOf: p.asOf } : null,
        priceError: p.error
      });
    }));

    const valued = priced.filter(p => p.marketValueInr != null);
    const total = valued.reduce((s, p) => s + p.marketValueInr, 0);
    const totalCost = priced.reduce((s, p) => s + (p.costBasisInr || 0), 0);
    const costCovered = priced.filter(p => p.costBasisInr != null).length;

    for (const p of priced) {
      p.weightPct = total > 0 && p.marketValueInr != null ? round((p.marketValueInr / total) * 100) : null;
    }
    priced.sort((a, b) => (b.marketValueInr || 0) - (a.marketValueInr || 0));

    const byKind = {};
    for (const p of valued) byKind[p.kind] = round((byKind[p.kind] || 0) + p.marketValueInr);
    const allocation = Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, { valueInr: v, weightPct: round((v / total) * 100) }]));

    const top = priced[0];
    const flags = [];
    if (top && top.weightPct != null && top.weightPct > 40) {
      flags.push(`Concentration: ${top.symbol} is ${top.weightPct}% of the portfolio.`);
    }
    const cryptoWeight = allocation.crypto ? allocation.crypto.weightPct : 0;
    if (cryptoWeight > 60) flags.push(`Single-asset-class exposure: ${cryptoWeight}% sits in crypto.`);
    if (valued.length < priced.length) {
      flags.push(`${priced.length - valued.length} holding(s) could not be priced — say so rather than omitting them.`);
    }
    if (costCovered < priced.length) {
      flags.push(`${priced.length - costCovered} holding(s) have no cost basis recorded, so their P/L is unknown. Binance does not report what was paid for a coin, so crypto P/L stays unknown until the user says what they paid.`);
    }
    if (needsFx && !fxUsdInr) {
      flags.push('The USD→INR rate could not be fetched, so dollar-denominated holdings are NOT included in the total. Report the rupee holdings only and say the crypto side is missing — do not guess a rate.');
    }
    const stalePrices = priced.filter(p => p.priceStale);
    if (stalePrices.length) {
      flags.push(`${stalePrices.length} holding(s) are valued at the price the broker reported at the last sync, not a live quote: ${stalePrices.map(p => p.symbol).join(', ')}.`);
    }
    for (const s of sources) {
      if (s.needsUserAction) flags.push(s.needsUserAction);
      else if (s.temporaryOutage) flags.push(s.temporaryOutage);
      else if (s.stale && s.lastSyncedAt) {
        flags.push(`${s.label} positions were last refreshed ${s.ageHours}h ago — say so before treating them as current.`);
      }
    }

    const valuation = {
      action: 'value',
      // INR is the reporting currency; USD is kept alongside because the
      // snapshot series started in dollars and switching it silently would put
      // a step change in the growth line that never happened.
      currency: BASE_CURRENCY,
      fxUsdInr: fxUsdInr ? round(fxUsdInr, 4) : null,
      totalValueInr: round(total),
      totalValueUsd: fxUsdInr ? round(total / fxUsdInr) : null,
      totalCostBasisInr: costCovered ? round(totalCost) : null,
      totalUnrealizedPnlInr: costCovered === priced.length ? round(total - totalCost) : null,
      totalUnrealizedPnlPct: costCovered === priced.length && totalCost ? round(((total - totalCost) / totalCost) * 100) : null,
      holdingsCount: priced.length,
      allocation,
      holdings: priced,
      // Which accounts these positions came from and how current each one is.
      sources,
      syncedNow: syncs.filter(s => s.ok).map(s => s.broker),
      flags,
      guidance: 'Report totals in INR (₹). Analyse allocation, concentration and the catalysts behind each position, and state how fresh each account\'s data is when it is not current. Educational analysis only — not financial advice, and never instruct the user to buy or sell a specific amount of their own money.'
    };

    await writeSnapshot(userId, valuation);
    return valuation;
  }

  if (action === 'history') {
    const days = Math.max(2, Math.min(365, Number(opts.days) || 90));
    const res = await query(`
      SELECT captured_on, captured_at, total_value_usd, total_cost_basis_usd,
             holdings_count, holdings, total_value_inr, total_cost_basis_inr, fx_usd_inr
        FROM portfolio_snapshots
       WHERE user_id = $1
         AND captured_on >= (now() AT TIME ZONE 'utc')::date - $2::integer
       ORDER BY captured_on ASC
    `, [userId, days]);

    const series = res.rows.map(r => ({
      capturedOn: r.captured_on instanceof Date
        ? r.captured_on.toISOString().slice(0, 10) : String(r.captured_on).slice(0, 10),
      totalValueUsd: round(num(r.total_value_usd)),
      // Each day's own rate, recorded on the day. Never today's rate applied
      // backwards — that manufactures growth out of currency moves.
      totalValueInr: round(num(r.total_value_inr)),
      fxUsdInr: round(num(r.fx_usd_inr), 4),
      totalCostBasisUsd: round(num(r.total_cost_basis_usd)),
      holdingsCount: r.holdings_count
    }));

    // Compare like with like. Snapshots taken before the portfolio learned about
    // rupees carry dollars only, so a window that includes one is measured in
    // dollars and SAYS so, rather than comparing a rupee total against a dollar
    // one and reporting the exchange rate as a 90% gain.
    const basis = series.every(s => s.totalValueInr != null) ? 'INR' : 'USD';
    const val = (s) => (basis === 'INR' ? s.totalValueInr : s.totalValueUsd);
    const money = basis === 'INR' ? 'changeInr' : 'changeUsd';
    // delta() names its absolute field changeUsd; rename it to match the basis
    // so a rupee figure is never handed over labelled as dollars.
    const change = (a, b) => {
      const d = delta(a, b);
      if (!d) return {};
      return { [money]: d.changeUsd, changePct: d.changePct };
    };

    if (series.length < 2) {
      return {
        action: 'history', points: series.length, series,
        note: series.length === 0
          ? 'No snapshots recorded yet. A snapshot is written every time the portfolio is priced, so run {"action":"value"} — then this becomes answerable from tomorrow onward. Do NOT invent a past performance figure.'
          : 'Only one snapshot exists, so there is no baseline to measure growth against yet. Report today\'s value and say plainly that the trend starts building from now — do not estimate a past return.'
      };
    }

    const latest = series[series.length - 1];
    const prev = series[series.length - 2];
    const first = series[0];

    // Peak-to-date and the drawdown from it: the one risk number a daily watch
    // owes the user that a single valuation can never show.
    let peak = series[0];
    for (const s of series) if ((val(s) || 0) > (val(peak) || 0)) peak = s;
    const drawdownPct = val(peak)
      ? round(((val(latest) - val(peak)) / val(peak)) * 100) : null;

    // Which positions actually moved the total since the previous snapshot.
    const prevRow = res.rows[res.rows.length - 2];
    const latestRow = res.rows[res.rows.length - 1];
    const parseHoldings = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || []));
    const prevBySymbol = {};
    for (const h of parseHoldings(prevRow.holdings)) prevBySymbol[h.symbol] = h;
    const movers = parseHoldings(latestRow.holdings).map(h => {
      const p = prevBySymbol[h.symbol];
      const d = p ? delta(h.marketValue, p.marketValue) : null;
      return {
        symbol: h.symbol, kind: h.kind,
        marketValue: h.marketValue, weightPct: h.weightPct,
        [money]: d ? d.changeUsd : null,
        changePct: d ? d.changePct : null,
        isNew: !p
      };
    }).sort((a, b) => Math.abs(b[money] || 0) - Math.abs(a[money] || 0));

    return {
      action: 'history',
      points: series.length,
      windowDays: days,
      // Stated explicitly: every figure below is in this currency.
      currency: basis,
      latest: { date: latest.capturedOn, totalValue: val(latest), currency: basis },
      sinceLast: { from: prev.capturedOn, ...change(val(latest), val(prev)) },
      since7d: (() => { const b = pickOnOrBefore(series, 7); return b ? { from: b.capturedOn, ...change(val(latest), val(b)) } : null; })(),
      since30d: (() => { const b = pickOnOrBefore(series, 30); return b ? { from: b.capturedOn, ...change(val(latest), val(b)) } : null; })(),
      sinceFirstSnapshot: { from: first.capturedOn, ...change(val(latest), val(first)) },
      peak: { date: peak.capturedOn, totalValue: val(peak), currency: basis },
      drawdownFromPeakPct: drawdownPct,
      movers,
      series,
      currencyNote: basis === 'USD' && series.some(s => s.totalValueInr != null)
        ? 'Part of this window predates rupee reporting, so the comparison is made in USD to keep it like-for-like. Quote it as dollars, and do not convert these figures to rupees at today\'s rate — that would report a currency move as portfolio growth.'
        : undefined,
      guidance: 'This is the growth question answered from recorded history, not from memory. Lead with the change since the last snapshot and what drove it, then place it against the 7/30-day trend and the drawdown from peak. The series only covers days on which the portfolio was actually priced — say so if it is sparse, and never extrapolate a return beyond it.'
    };
  }

  throw new Error(`Unknown portfolio action "${action}". Use list, add, update, remove, value, history or sync.`);
}

module.exports = { execute, guessKind, priceTicker, BASE_CURRENCY };
