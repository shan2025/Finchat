// scripts/unblock_all.js — One-time script to unfreeze all frozen accounts
// Run: node scripts/unblock_all.js

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || './finchat.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const RECOVERY_TOKENS = 50;

console.log('╔══════════════════════════════════════════╗');
console.log('║   FinChat — Unblock All Frozen Accounts  ║');
console.log('╚══════════════════════════════════════════╝');
console.log('');

// Find all frozen users
const frozenUsers = db.prepare('SELECT id, name, email, token_balance, is_frozen FROM users WHERE is_frozen = 1').all();

if (frozenUsers.length === 0) {
    console.log('✅ No frozen accounts found. All users are active.');
    process.exit(0);
}

console.log(`Found ${frozenUsers.length} frozen account(s):\n`);

const unblock = db.transaction(() => {
    for (const user of frozenUsers) {
        const newBalance = user.token_balance + RECOVERY_TOKENS;

        db.prepare('UPDATE users SET token_balance = ?, is_frozen = 0 WHERE id = ?')
            .run(newBalance, user.id);

        db.prepare(`
      INSERT INTO token_ledger (id, user_id, amount, balance, type, reason)
      VALUES (?, ?, ?, ?, 'grant', 'Account recovery — bulk unfreeze script')
    `).run(uuidv4(), user.id, RECOVERY_TOKENS, newBalance);

        console.log(`  🔓 ${user.name} (${user.email || 'no email'}) — was ${user.token_balance} tokens, now ${newBalance}`);
    }
});

unblock();

console.log('');
console.log(`✅ Successfully unblocked ${frozenUsers.length} account(s) with +${RECOVERY_TOKENS} recovery tokens each.`);

// Verify
const stillFrozen = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_frozen = 1').get();
console.log(`   Remaining frozen accounts: ${stillFrozen.c}`);

db.close();
