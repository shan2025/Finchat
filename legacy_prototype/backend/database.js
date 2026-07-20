// database.js — FinChat Supabase PostgreSQL Connection Pool
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

let pool = null;

function getPool() {
  if (!pool) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured in .env');
    }
    pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    pool.on('error', (err) => {
      console.error('⚠️ Supabase PG Pool Error:', err.message);
    });

    console.log('✅ Connected to Supabase PostgreSQL pool');
  }
  return pool;
}

/**
 * Execute a query against Supabase PostgreSQL
 */
async function query(text, params = []) {
  const p = getPool();
  const start = Date.now();
  try {
    const res = await p.query(text, params);
    const duration = Date.now() - start;
    const slowMs = Number(process.env.SLOW_QUERY_MS) || 500;
    if (duration >= slowMs) {
      console.warn(`🐢 Slow query (${duration}ms):`, text.replace(/\s+/g, ' ').trim().slice(0, 120));
    }
    return res;
  } catch (err) {
    console.error('❌ Database query error:', { text, error: err.message });
    throw err;
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
