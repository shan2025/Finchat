/* eslint-disable camelcase */

exports.up = (pgm) => {
  // Create pgvector extension if not exists
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector;');

  // users table
  pgm.createTable('users', {
    user_id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    email: { type: 'text', unique: true },
    password_hash: { type: 'text' },
    role: { type: 'text', notNull: true, default: 'staff' },
    wallet_address: { type: 'text', unique: true },
    auth_method: { type: 'text', notNull: true, default: 'password' },
    token_balance: { type: 'integer', notNull: true, default: 1000 },
    is_frozen: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_login: { type: 'timestamptz' }
  });

  // sessions table
  pgm.createTable('sessions', {
    session_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    jwt_token: { type: 'text', notNull: true },
    ip_address: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true }
  });

  // agents table
  pgm.createTable('agents', {
    agent_id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // agent_configs table (Decision #7: includes capabilities JSONB)
  pgm.createTable('agent_configs', {
    agent_id: { type: 'text', primaryKey: true, references: '"agents"', onDelete: 'CASCADE' },
    system_prompt: { type: 'text', notNull: true },
    color: { type: 'text' },
    capabilities: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // channels table
  pgm.createTable('channels', {
    channel_id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    type: { type: 'text', notNull: true, default: 'public' },
    created_by: { type: 'text', references: '"users"' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // messages table
  pgm.createTable('messages', {
    message_id: { type: 'text', primaryKey: true },
    channel_id: { type: 'text', notNull: true, references: '"channels"' },
    sender_id: { type: 'text', notNull: true, references: '"users"' },
    content: { type: 'text' },
    message_type: { type: 'text', notNull: true, default: 'text' },
    token_cost: { type: 'integer', notNull: true, default: 5 },
    is_quarantined: { type: 'integer', notNull: true, default: 0 },
    is_deleted: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // proof_chain table
  pgm.createTable('proof_chain', {
    proof_id: { type: 'text', primaryKey: true },
    message_id: { type: 'text', notNull: true, references: '"messages"' },
    chain_height: { type: 'integer', notNull: true },
    hash: { type: 'text', notNull: true, unique: true },
    prev_hash: { type: 'text', notNull: true },
    sender_id: { type: 'text', notNull: true, references: '"users"' },
    content_hash: { type: 'text', notNull: true },
    timestamp: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ipfs_cid: { type: 'text' },
    ipfs_url: { type: 'text' },
    ipfs_pinned: { type: 'integer', notNull: true, default: 0 },
    solana_tx: { type: 'text' },
    solana_slot: { type: 'integer' },
    solana_confirmed: { type: 'integer', notNull: true, default: 0 }
  });

  // fraud_logs table
  pgm.createTable('fraud_logs', {
    fraud_log_id: { type: 'text', primaryKey: true },
    message_id: { type: 'text', notNull: true, references: '"messages"' },
    sender_id: { type: 'text', notNull: true, references: '"users"' },
    risk_level: { type: 'text', notNull: true },
    reason: { type: 'text', notNull: true },
    indicators: { type: 'text', notNull: true },
    model_used: { type: 'text', notNull: true, default: 'simulation' },
    token_penalty: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // token_ledger table
  pgm.createTable('token_ledger', {
    ledger_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"' },
    amount: { type: 'integer', notNull: true },
    balance: { type: 'integer', notNull: true },
    type: { type: 'text', notNull: true },
    reason: { type: 'text', notNull: true },
    message_id: { type: 'text', references: '"messages"' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // files table
  pgm.createTable('files', {
    file_id: { type: 'text', primaryKey: true },
    message_id: { type: 'text', references: '"messages"' },
    uploader_id: { type: 'text', notNull: true, references: '"users"' },
    filename: { type: 'text', notNull: true },
    mimetype: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    local_path: { type: 'text' },
    ipfs_cid: { type: 'text' },
    ipfs_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // ai_conversations table
  pgm.createTable('ai_conversations', {
    conversation_id: { type: 'text', primaryKey: true },
    session_id: { type: 'text', notNull: true },
    user_id: { type: 'text', notNull: true, references: '"users"' },
    persona: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    message_id: { type: 'text', references: '"messages"' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // zkp_proofs table
  pgm.createTable('zkp_proofs', {
    proof_id: { type: 'text', primaryKey: true },
    proof_type: { type: 'text', notNull: true, default: 'unblock' },
    admin_id: { type: 'text', notNull: true, references: '"users"' },
    target_user_id: { type: 'text', notNull: true, references: '"users"' },
    commitment_hash: { type: 'text', notNull: true },
    nonce_hash: { type: 'text', notNull: true },
    public_inputs: { type: 'text', notNull: true },
    zkp_proof: { type: 'text' },
    public_signals: { type: 'text' },
    zkp_verified: { type: 'integer', notNull: true, default: 0 },
    reason: { type: 'text' },
    verified: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('zkp_proofs');
  pgm.dropTable('ai_conversations');
  pgm.dropTable('files');
  pgm.dropTable('token_ledger');
  pgm.dropTable('fraud_logs');
  pgm.dropTable('proof_chain');
  pgm.dropTable('messages');
  pgm.dropTable('channels');
  pgm.dropTable('agent_configs');
  pgm.dropTable('agents');
  pgm.dropTable('sessions');
  pgm.dropTable('users');
};
