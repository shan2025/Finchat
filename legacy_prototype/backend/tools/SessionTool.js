// tools/SessionTool.js — "Market Intelligence Session" (Phase 3).
//
// One command that turns the user's whole watchlist into a ranked, sourced
// market read: for every crypto symbol it runs the signal engine (trend +
// momentum + news-catalyst sentiment + venue agreement), ranks assets from most
// bullish to most bearish, rolls up the catalysts driving the tape, and renders
// a finished markdown report.
//
// Deliberately DETERMINISTIC — it does not call an LLM. That means it produces
// the same auditable report every time and, crucially, cannot "ship a failure
// as a report" the way LLM-synthesised missions once did. Aurelius can call it
// in chat and add colour; a mission can call it and deliver its markdown
// verbatim with almost no failure surface.
//
// Educational only — signals summarise public data, never advise a trade.
const signal = require('./SignalTool');
const news = require('./NewsTool');
const { query } = require('../database');

const DEFAULT_CRYPTO = ['BTC', 'ETH', 'SOL'];
const MAX_ASSETS = 8; // bound runtime / rate-limit pressure

const EMOJI = { BULLISH: '🟢', BEARISH: '🔴', NEUTRAL: '⚪' };

function parseInput(input) {
  const out = { symbols: null };
  const o = (input && typeof input === 'object') ? input
    : (String(input || '').trim().startsWith('{') ? safeJson(input) : null);
  if (o && Array.isArray(o.symbols)) out.symbols = o.symbols.map((s) => String(s).trim()).filter(Boolean);
  else if (typeof input === 'string' && input.trim() && !input.trim().startsWith('{')) {
    out.symbols = input.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  return out;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

const defaultSignalable = () => DEFAULT_CRYPTO.map((s) => ({ symbol: s, kind: 'crypto' }));

async function loadWatchlist(userId) {
  if (!userId || userId === 'system') return { signalable: defaultSignalable(), commodities: [], defaulted: true };
  try {
    const res = await query(
      'SELECT symbol, kind FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    if (!res.rows.length) return { signalable: defaultSignalable(), commodities: [], defaulted: true };
    // Crypto and stocks can both be scored; commodities/forex can't yet.
    const signalable = res.rows.filter((r) => r.kind === 'crypto' || r.kind === 'stock')
      .map((r) => ({ symbol: r.symbol, kind: r.kind }));
    const commodities = res.rows.filter((r) => r.kind !== 'crypto' && r.kind !== 'stock')
      .map((r) => ({ symbol: r.symbol, kind: r.kind }));
    return {
      signalable: signalable.length ? signalable : defaultSignalable(),
      commodities,
      defaulted: signalable.length === 0 && commodities.length === 0
    };
  } catch {
    return { signalable: defaultSignalable(), commodities: [], defaulted: true };
  }
}

function fmtUsd(n) {
  if (n == null) return 'n/a';
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '$' + n.toPrecision(4);
}

function overallRead(assets) {
  const scored = assets.filter((a) => typeof a.score === 'number');
  if (!scored.length) return { label: 'NEUTRAL', avg: 0, note: 'no scorable assets' };
  const avg = Math.round(scored.reduce((s, a) => s + a.score, 0) / scored.length);
  const label = avg >= 20 ? 'BULLISH' : avg <= -20 ? 'BEARISH' : 'MIXED / NEUTRAL';
  return { label, avg };
}

async function execute(input, context = {}) {
  const { symbols } = parseInput(input);
  const wl = symbols && symbols.length
    ? { signalable: symbols.slice(0, MAX_ASSETS).map((s) => ({ symbol: s, kind: undefined })), commodities: [], defaulted: false }
    : await loadWatchlist(context.userId);

  const toScore = wl.signalable.slice(0, MAX_ASSETS);

  // Score every crypto/stock symbol in parallel (kind lets the signal engine
  // route to the right data sources), plus one broad catalyst scan.
  const [signals, macro] = await Promise.all([
    Promise.all(toScore.map(({ symbol: sym, kind }) =>
      signal.execute({ symbol: sym, kind }).then((r) => ({ sym, r })).catch((e) => ({ sym, r: { error: e.message } }))
    )),
    news.execute({ query: 'crypto', category: 'crypto' }).catch(() => ({ catalystBreakdown: {}, results: [] }))
  ]);

  const assets = signals.map(({ sym, r }) => r?.error
    ? { symbol: sym, error: r.error }
    : {
        symbol: r.symbol, name: r.name, kind: r.kind, currency: r.currency, signal: r.signal, confidence: r.confidence,
        score: r.score, priceUsd: r.priceUsd, change24h: r.change24h,
        changeWindowPct: r.changeWindowPct, windowDays: r.windowDays,
        factors: r.factors, catalystBreakdown: r.catalystBreakdown, topHeadlines: r.topHeadlines
      }
  );

  // Rank bullish → bearish; errored assets sink to the bottom.
  assets.sort((a, b) => (b.score ?? -999) - (a.score ?? -999));

  const overall = overallRead(assets);

  // Merge catalyst counts across all assets + the macro scan.
  const catalysts = { ...(macro.catalystBreakdown || {}) };
  for (const a of assets) for (const [k, v] of Object.entries(a.catalystBreakdown || {})) catalysts[k] = (catalysts[k] || 0) + v;
  const topCatalysts = Object.entries(catalysts).sort((a, b) => b[1] - a[1]);

  // ---- Render markdown --------------------------------------------------------
  const now = new Date();
  const L = [];
  L.push(`# 📊 Market Intelligence Session`);
  L.push(`*${now.toUTCString()}*`);
  L.push('');
  L.push(`**Overall read: ${overall.label}** (avg signal score ${overall.avg >= 0 ? '+' : ''}${overall.avg} across ${assets.filter((a) => a.score != null).length} assets)`);
  if (topCatalysts.length) {
    L.push('');
    L.push(`**Catalysts driving the tape:** ${topCatalysts.map(([k, v]) => `${k} (${v})`).join(' · ')}`);
  }
  if (wl.defaulted) L.push(`\n> Your watchlist is empty — showing BTC, ETH, SOL. Add symbols with the watchlist tool to tailor this.`);
  L.push('');
  L.push('---');

  let rank = 1;
  for (const a of assets) {
    if (a.error) { L.push(`\n### ${rank++}. ${a.symbol} — ⚠️ no data\n${a.error}`); continue; }
    const em = EMOJI[a.signal] || '⚪';
    const tag = a.kind === 'stock' ? ' 📈' : a.kind === 'crypto' ? ' ₿' : '';
    L.push(`\n### ${rank++}. ${em} ${a.name || a.symbol} (${a.symbol})${tag} — **${a.signal}** · ${a.confidence} confidence · score ${a.score >= 0 ? '+' : ''}${a.score}`);
    const win = a.changeWindowPct != null ? `, ${a.changeWindowPct >= 0 ? '+' : ''}${a.changeWindowPct}% over ${a.windowDays}d` : '';
    const cur = a.currency && a.currency !== 'USD' ? ` ${a.currency}` : '';
    L.push(`- **Price:** ${fmtUsd(a.priceUsd)}${cur} (${a.change24h >= 0 ? '+' : ''}${a.change24h}% ${a.kind === 'stock' ? 'today' : '24h'}${win})`);
    const drivers = (a.factors || []).filter((f) => f.contribution !== 0)
      .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution)).slice(0, 3);
    if (drivers.length) L.push(`- **Why:** ${drivers.map((f) => `${f.detail} (${f.contribution >= 0 ? '+' : ''}${f.contribution})`).join('; ')}`);
    const heads = (a.topHeadlines || []).slice(0, 2);
    if (heads.length) {
      L.push(`- **Headlines:**`);
      for (const h of heads) L.push(`  - [${h.title}](${h.url})${h.catalysts?.length ? ` — _${h.catalysts.join(', ')}_` : ''}`);
    }
  }

  if (wl.commodities.length) {
    L.push(`\n---\n**Also on your watchlist (no signal yet — commodities/FX scoring is coming):** ${wl.commodities.map((o) => `${o.symbol} (${o.kind})`).join(', ')}`);
  }

  L.push(`\n---`);
  L.push(`_Educational, rules-based analysis from current public data — **not financial advice**. No position sizing, no trade instructions. Signals summarise momentum, trend, catalysts and cross-venue pricing; always do your own research._`);

  const markdown = L.join('\n');

  return {
    generatedAt: now.toISOString(),
    overall,
    assetCount: assets.length,
    topCatalysts: Object.fromEntries(topCatalysts),
    assets,      // structured data for any downstream use
    markdown     // finished report — deliver this to the user / notification
  };
}

module.exports = { execute };
