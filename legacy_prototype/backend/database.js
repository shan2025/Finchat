// database.js — FinChat Supabase PostgreSQL Connection Pool
// Fix 2: Auto-recreate pool on fatal errors, keepalive ping, query retry.
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

let pool = null;
let _keepaliveTimer = null;

// Errors that indicate the connection is dead and the pool should be recreated.
const FATAL_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
  'CONNECTION_LOST', 'PROTOCOL_CONNECTION_LOST'
]);

function isFatalError(err) {
  if (!err) return false;
  if (FATAL_ERROR_CODES.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('connection terminated') ||
    msg.includes('client has encountered a connection error') ||
    msg.includes('getaddrinfo enotfound') ||
    msg.includes('read econnreset');
}

function destroyPool() {
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
  if (pool) {
    const old = pool;
    pool = null;
    old.end().catch(() => {}); // best-effort cleanup
    console.warn('🔄 PG pool destroyed — will recreate on next query');
  }
}

function getPool() {
  if (!pool) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured in .env');
    }
    const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: isLocalDb ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000 // bumped from 10s — Supabase can be slow
    });

    pool.on('error', (err) => {
      console.error('⚠️ Supabase PG Pool Error:', err.message);
      if (isFatalError(err)) {
        destroyPool(); // force recreation on next getPool() call
      }
    });

    // Keepalive: ping every 60s to prevent Supabase from closing idle connections
    _keepaliveTimer = setInterval(() => {
      if (!pool) return;
      pool.query('SELECT 1').catch((err) => {
        console.warn('⚠️ PG keepalive ping failed:', err.message);
        if (isFatalError(err)) destroyPool();
      });
    }, 60_000);

    console.log('✅ Connected to Supabase PostgreSQL pool');
  }
  return pool;
}

/**
 * Execute a query against Supabase PostgreSQL.
 * On transient connection errors, recreates the pool and retries once.
 */
async function query(text, params = []) {
  const start = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    const p = getPool();
    try {
      const res = await p.query(text, params);
      const duration = Date.now() - start;
      const slowMs = Number(process.env.SLOW_QUERY_MS) || 500;
      if (duration >= slowMs) {
        console.warn(`🐢 Slow query (${duration}ms):`, text.replace(/\s+/g, ' ').trim().slice(0, 120));
      }
      // Egress accounting. Supabase bills the bytes that leave Postgres for this
      // process, and this is the only place they all pass through. Wrapped
      // because instrumentation must never be able to fail a real query.
      try { require('./services/EgressMeter').record(text, res.rows); } catch { /* metering is best-effort */ }
      return res;
    } catch (err) {
      if (attempt === 0 && isFatalError(err)) {
        console.warn(`🔄 Retrying query after connection error: ${err.message}`);
        destroyPool(); // force fresh pool
        continue;      // retry once
      }
      console.error('❌ Database query error:', { text: text.replace(/\s+/g, ' ').trim().slice(0, 200), error: err.message });
      throw err;
    }
  }
}

/**
 * Backward compatibility wrapper for code transitioning from SQLite
 */
function getDB() {
  return getPool();
}

module.exports = {
  getPool,
  query,
  getDB
};

