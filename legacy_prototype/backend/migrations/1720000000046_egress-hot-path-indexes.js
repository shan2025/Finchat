/* eslint-disable camelcase */

// Indexes for the tables that were being read by full table scan on every hit.
//
// From pg_stat_user_tables on 2026-08-30, `execution_logs` had idx_scan = 0
// against 5,693 sequential scans: every `WHERE execution_id = $1` was reading
// all 3,816 rows of a 5.7MB table to return a handful. The same shape held for
// memories, audit_logs, token_ledger, proof_chain, tool_results and
// notifications — each carried a primary-key index and nothing else, while the
// code never looks a row up by its primary key.
//
// This is a LATENCY fix, and it is deliberately filed alongside the egress work
// rather than as part of it. An index changes how many rows Postgres has to
// touch to answer, not how many bytes it hands back, so it does not by itself
// move the Supabase egress number — the row set returned is identical. It earns
// its place because DB round-trip time already dominates this app's response
// times (a bare `SELECT 1` to Tokyo costs ~126ms) and these scans sit on the
// polled endpoints, where they are paid over and over.
//
// Every index is created CONCURRENTLY-less on purpose: node-pg-migrate wraps a
// migration in a transaction, these tables are small, and the lock is measured
// in milliseconds at this row count.

exports.up = async (pgm) => {
  // The whole point of execution_logs: replay one execution in step order.
  // ExecutionTrace and routes/executions.js both order by step_number.
  pgm.createIndex('execution_logs', ['execution_id', 'step_number'], {
    name: 'idx_execution_logs_execution_step',
    ifNotExists: true
  });

  // MemoryService recalls a user's episodes newest-first.
  pgm.createIndex('memories', ['user_id', 'created_at'], {
    name: 'idx_memories_user_created',
    ifNotExists: true
  });

  // The audit trail is only ever read as "this user's recent activity".
  pgm.createIndex('audit_logs', ['user_id', 'created_at'], {
    name: 'idx_audit_logs_user_created',
    ifNotExists: true
  });

  pgm.createIndex('token_ledger', ['user_id', 'created_at'], {
    name: 'idx_token_ledger_user_created',
    ifNotExists: true
  });

  // blockchain.js joins proof_chain to ai_conversations on message_id to prove
  // ownership; without this the ownership check itself scanned the chain.
  pgm.createIndex('proof_chain', ['message_id'], {
    name: 'idx_proof_chain_message',
    ifNotExists: true
  });

  // tool_results is 4.2MB of wide payloads fetched one call at a time.
  pgm.createIndex('tool_results', ['call_id'], {
    name: 'idx_tool_results_call',
    ifNotExists: true
  });

  // The notifications badge polls this every 30s per open tab.
  pgm.createIndex('notifications', ['user_id', 'created_at'], {
    name: 'idx_notifications_user_created',
    ifNotExists: true
  });

  // Unread-count is the single hottest read on that table, and it is a tiny
  // partial index because read notifications are never counted.
  pgm.createIndex('notifications', ['user_id'], {
    name: 'idx_notifications_unread',
    // is_read is an INTEGER in this schema, not a boolean — see migration 044's
    // is_direct_addressable for the same convention.
    where: 'is_read = 0',
    ifNotExists: true
  });
};

exports.down = async (pgm) => {
  pgm.dropIndex('notifications', ['user_id'], { name: 'idx_notifications_unread', ifExists: true });
  pgm.dropIndex('notifications', ['user_id', 'created_at'], { name: 'idx_notifications_user_created', ifExists: true });
  pgm.dropIndex('tool_results', ['call_id'], { name: 'idx_tool_results_call', ifExists: true });
  pgm.dropIndex('proof_chain', ['message_id'], { name: 'idx_proof_chain_message', ifExists: true });
  pgm.dropIndex('token_ledger', ['user_id', 'created_at'], { name: 'idx_token_ledger_user_created', ifExists: true });
  pgm.dropIndex('audit_logs', ['user_id', 'created_at'], { name: 'idx_audit_logs_user_created', ifExists: true });
  pgm.dropIndex('memories', ['user_id', 'created_at'], { name: 'idx_memories_user_created', ifExists: true });
  pgm.dropIndex('execution_logs', ['execution_id', 'step_number'], { name: 'idx_execution_logs_execution_step', ifExists: true });
};
