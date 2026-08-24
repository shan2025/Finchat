// tools/PortfolioTool.js — the user's actual positions, priced live.
//
// The watchlist answers "what am I following"; this answers "what do I own,
// what is it worth now, and how is it distributed". Aurelius needs the second
// question to say anything useful about a real portfolio — allocation and
// concentration are the only things a review can honestly be about without
// knowing size and cost basis.
//
// Hard boundary, same as the persona's: this tool records and prices holdings.
// It never places, routes, or simulates a trade, and it holds no broker
// credentials. Adding a holding is bookkeeping, not buying.
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
  const m = s.match(/^(list|add|remove|value|update)\b\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase(), symbol: m[2].trim() || undefined };
  return { action: 'value' };
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
    const out = await require('./StockTool').execute({ ticker: symbol });
    if (out && out.price) return { price: out.price, changePercent: out.changePercent ?? null, source: 'yahoo', currency: out.currency || 'USD' };
    return { error: (out && out.error) || `no price for ${symbol}` };
  } catch (err) {
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
    avgCost: num(r.avg_cost), currency: r.currency, note: r.note
  };
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
      const res = await query(`
        INSERT INTO portfolio_holdings (holding_id, user_id, symbol, kind, quantity, avg_cost, currency, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (user_id, symbol, kind) DO UPDATE SET
          quantity = EXCLUDED.quantity,
          avg_cost = COALESCE(EXCLUDED.avg_cost, portfolio_holdings.avg_cost),
          note     = COALESCE(EXCLUDED.note, portfolio_holdings.note),
          updated_at = now()
        RETURNING *
      `, [uuidv4(), userId, symbol.toUpperCase(), kind, quantity,
        e.avgCost != null ? Number(e.avgCost) : null, (e.currency || 'USD').toUpperCase(), e.note || null]);
      saved.push(view(res.rows[0]));
    }
    if (!saved.length) throw new Error('Nothing to add — pass {"action":"add","symbol":"BTC","quantity":0.5,"avgCost":42000}.');
    return { action, saved, holdings: (await rows(userId)).map(view), disclaimer: 'Bookkeeping only — no trade was placed.' };
  }

  if (action === 'remove') {
    const symbol = String(opts.symbol || '').trim();
    if (!symbol) throw new Error('Portfolio "remove" needs a symbol.');
    const res = await query(
      'DELETE FROM portfolio_holdings WHERE user_id = $1 AND upper(symbol) = upper($2) RETURNING symbol', [userId, symbol]);
    return {
      action, removed: res.rows.length,
      holdings: (await rows(userId)).map(view),
      note: res.rows.length ? undefined : `"${symbol}" was not in the portfolio.`,
      disclaimer: 'Removed from the record only — nothing was sold.'
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
    const all = await rows(userId);
    if (!all.length) {
      return {
        action, count: 0, holdings: [],
        note: 'The portfolio is empty, so there is nothing to value. Ask the user for their holdings (symbol, quantity, avg cost) — do not review a hypothetical portfolio as though it were theirs.'
      };
    }

    const priced = await Promise.all(all.map(async (h) => {
      const p = await priceHolding(h);
      const qty = num(h.quantity) || 0;
      const value = p.price != null ? qty * p.price : null;
      const cost = h.avg_cost != null ? qty * num(h.avg_cost) : null;
      return {
        symbol: h.symbol, kind: h.kind, quantity: qty,
        price: round(p.price, p.price != null && p.price < 10 ? 4 : 2),
        change24hPct: p.changePercent != null ? round(p.changePercent) : null,
        marketValue: round(value),
        costBasis: round(cost),
        unrealizedPnl: value != null && cost != null ? round(value - cost) : null,
        unrealizedPnlPct: value != null && cost ? round(((value - cost) / cost) * 100) : null,
        source: p.source,
        priceError: p.error
      };
    }));

    const valued = priced.filter(p => p.marketValue != null);
    const total = valued.reduce((s, p) => s + p.marketValue, 0);
    const totalCost = priced.reduce((s, p) => s + (p.costBasis || 0), 0);
    const costCovered = priced.filter(p => p.costBasis != null).length;

    for (const p of priced) {
      p.weightPct = total > 0 && p.marketValue != null ? round((p.marketValue / total) * 100) : null;
    }
    priced.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));

    const byKind = {};
    for (const p of valued) byKind[p.kind] = round((byKind[p.kind] || 0) + p.marketValue);
    const allocation = Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, { valueUsd: v, weightPct: round((v / total) * 100) }]));

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
      flags.push(`${priced.length - costCovered} holding(s) have no cost basis recorded, so their P/L is unknown.`);
    }

    return {
      action: 'value',
      currency: 'USD',
      totalValueUsd: round(total),
      totalCostBasisUsd: costCovered ? round(totalCost) : null,
      totalUnrealizedPnlUsd: costCovered === priced.length ? round(total - totalCost) : null,
      totalUnrealizedPnlPct: costCovered === priced.length && totalCost ? round(((total - totalCost) / totalCost) * 100) : null,
      holdingsCount: priced.length,
      allocation,
      holdings: priced,
      flags,
      guidance: 'Analyse allocation, concentration and the catalysts behind each position. Educational analysis only — not financial advice, and never instruct the user to buy or sell a specific amount of their own money.'
    };
  }

  throw new Error(`Unknown portfolio action "${action}". Use list, add, update, remove or value.`);
}

module.exports = { execute, guessKind };
