// scripts/pg_cron/apply.js — run one of the pg_cron SQL files against DATABASE_URL.
//
// pg_cron jobs live in the database, not in node-pg-migrate's history: they
// schedule calls to the deployed service and are not schema. Keeping the SQL in
// the repo is what makes them reviewable and re-appliable.
//   node scripts/pg_cron/apply.js scripts/pg_cron/dream_jobs.sql
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/pg_cron/apply.js <file.sql>'); process.exit(2); }
  const sql = fs.readFileSync(file, 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    await pool.query(sql);
    const jobs = await pool.query(`SELECT jobname, schedule, active FROM cron.job ORDER BY jobid`);
    console.table(jobs.rows);
  } finally {
    await pool.end();
  }
})().catch(err => { console.error(err.message); process.exit(1); });
