// database.js — FinChat SQLite Database
const Database = require('better-sqlite3');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './finchat.db';
let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE,
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff','auditor','user')),
      wallet_address TEXT UNIQUE,
      auth_method   TEXT NOT NULL DEFAULT 'password',
      token_balance INTEGER NOT NULL DEFAULT 1000,
      is_frozen     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login    TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      jwt_token  TEXT NOT NULL,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS channels (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      type       TEXT NOT NULL DEFAULT 'public' CHECK(type IN ('public','private','dm')),
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      channel_id     TEXT NOT NULL REFERENCES channels(id),
      sender_id      TEXT NOT NULL REFERENCES users(id),
      content        TEXT,
      message_type   TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','file','system')),
      token_cost     INTEGER NOT NULL DEFAULT 5,
      is_quarantined INTEGER NOT NULL DEFAULT 0,
      is_deleted     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proof_chain (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL REFERENCES messages(id),
      chain_height INTEGER NOT NULL,
      hash         TEXT NOT NULL UNIQUE,
      prev_hash    TEXT NOT NULL,
      sender_id    TEXT NOT NULL REFERENCES users(id),
      content_hash TEXT NOT NULL,
      timestamp    TEXT NOT NULL DEFAULT (datetime('now')),
      ipfs_cid     TEXT,
      ipfs_url     TEXT,
      ipfs_pinned  INTEGER NOT NULL DEFAULT 0,
      solana_tx    TEXT,
      solana_slot  INTEGER,
      solana_confirmed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS fraud_logs (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL REFERENCES messages(id),
      sender_id    TEXT NOT NULL REFERENCES users(id),
      risk_level   TEXT NOT NULL CHECK(risk_level IN ('LOW','MEDIUM','HIGH')),
      reason       TEXT NOT NULL,
      indicators   TEXT NOT NULL,
      model_used   TEXT NOT NULL DEFAULT 'simulation',
      token_penalty INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS token_ledger (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      amount     INTEGER NOT NULL,
      balance    INTEGER NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('grant','spend','penalty','reward')),
      reason     TEXT NOT NULL,
      message_id TEXT REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      message_id  TEXT REFERENCES messages(id),
      uploader_id TEXT NOT NULL REFERENCES users(id),
      filename    TEXT NOT NULL,
      mimetype    TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      local_path  TEXT,
      ipfs_cid    TEXT,
      ipfs_url    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_conversations (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id),
      persona    TEXT NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content    TEXT NOT NULL,
      message_id TEXT REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel  ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_proof_height      ON proof_chain(chain_height);
    CREATE INDEX IF NOT EXISTS idx_fraud_risk        ON fraud_logs(risk_level);
    CREATE INDEX IF NOT EXISTS idx_ledger_user       ON token_ledger(user_id, created_at);
    CREATE TABLE IF NOT EXISTS zkp_proofs (
      id              TEXT PRIMARY KEY,
      proof_type      TEXT NOT NULL DEFAULT 'unblock',
      admin_id        TEXT NOT NULL REFERENCES users(id),
      target_user_id  TEXT NOT NULL REFERENCES users(id),
      commitment_hash TEXT NOT NULL,
      nonce_hash      TEXT NOT NULL,
      public_inputs   TEXT NOT NULL,
      zkp_proof       TEXT,            -- Groth16 proof JSON (filled async)
      public_signals  TEXT,            -- Public signals array (filled async)
      zkp_verified    INTEGER NOT NULL DEFAULT 0, -- 1 = ZKP generated & verified
      reason          TEXT,
      verified        INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ai_conv_session   ON ai_conversations(session_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_conv_user      ON ai_conversations(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_zkp_admin         ON zkp_proofs(admin_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_zkp_target        ON zkp_proofs(target_user_id);
  `);

  // Seed default channels
  const { v4: uuidv4 } = require('uuid');
  const count = db.prepare('SELECT COUNT(*) as c FROM channels').get();
  if (count.c === 0) {
    const ins = db.prepare('INSERT INTO channels (id, name, type) VALUES (?, ?, ?)');
    ins.run(uuidv4(), 'general', 'public');
    ins.run(uuidv4(), 'compliance', 'private');
    ins.run(uuidv4(), 'audit-log', 'private');
    console.log('  Seeded default channels');
  }
  console.log('✅ DB ready:', DB_PATH);
}

module.exports = { getDB };
