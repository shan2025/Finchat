// tools/WatchlistTool.js — CRUD the user's crypto/stock/commodity watchlist.
// Missions read it to know what to track ("check my watchlist" → aurelius brief).
// Receives the executing user's id via the tool context (second execute arg).
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  // Plain-string convenience: "list" | "add BTC" | "remove BTC"
  const m = s.match(/^(list|add|remove)\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase(), symbol: m[2].trim() };
  return { action: 'list' };
}

function guessKind(symbol) {
  const s = symbol.toLowerCase();
  if (['gold', 'silver', 'oil', 'copper', 'coffee', 'natural gas', 'gas'].includes(s)) return 'commodity';
  if (/^[a-z]{1,5}$/i.test(symbol) && ['btc', 'eth', 'sol', 'doge', 'xrp', 'ada', 'dot', 'link', 'avax'].includes(s)) return 'crypto';
  if (/^[A-Z]{1,5}$/.test(symbol)) return 'stock';
  return 'crypto';
}

async function execute(input, context = {}) {
  const { action = 'list', symbol = '', kind, note } = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('Watchlist requires a signed-in user context');
  }

  if (action === 'add') {
    if (!symbol) throw new Error('Watchlist "add" needs a symbol, e.g. {"action":"add","symbol":"BTC"}');
    const k = kind || guessKind(symbol);
    await query(`
      INSERT INTO watchlists (watch_id, user_id, symbol, kind, note)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, symbol, kind) DO UPDATE SET note = COALESCE(EXCLUDED.note, watchlists.note)
    `, [uuidv4(), userId, symbol.toUpperCase(), k, note || null]);
  } else if (action === 'remove') {
    if (!symbol) throw new Error('Watchlist "remove" needs a symbol');
    await query('DELETE FROM watchlists WHERE user_id = $1 AND symbol = $2', [userId, symbol.toUpperCase()]);
  } else if (action !== 'list') {
    throw new Error(`Unknown watchlist action "${action}". Use "list", "add" or "remove".`);
  }

  const res = await query(
    'SELECT symbol, kind, note, created_at FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC',
    [userId]
  );
  return {
    action,
    count: res.rows.length,
    watchlist: res.rows,
    note: res.rows.length === 0 ? 'Watchlist is empty — default to BTC, ETH and SOL if the user asked for a market brief.' : undefined
  };
}

module.exports = { execute };
