const { getDB } = require('../database');
const db = getDB();

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
    console.log(`
📱 FinChat SQLite Viewer
=======================
Usage: node scripts/db_viewer.js [command]

Commands:
  tables      - List all tables in the database
  users       - Show all registered users
  channels    - Show all channels
  messages    - Show last 10 messages
  proofs      - Show last 10 proof chain entries
  help        - Show this help message
`);
}

if (!command || command === 'help') {
    printHelp();
    process.exit(0);
}

try {
    if (command === 'tables') {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.table(tables);
    }
    else if (command === 'users') {
        const users = db.prepare('SELECT id, name, email, role, token_balance, is_frozen FROM users').all();
        console.table(users);
    }
    else if (command === 'channels') {
        const channels = db.prepare('SELECT * FROM channels').all();
        console.table(channels);
    }
    else if (command === 'messages') {
        const msgs = db.prepare(`
      SELECT m.id, u.name as sender, c.name as channel, m.content, m.created_at 
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      JOIN channels c ON m.channel_id = c.id
      ORDER BY m.created_at DESC LIMIT 10
    `).all();
        console.table(msgs);
    }
    else if (command === 'proofs') {
        const proofs = db.prepare('SELECT chain_height, hash, prev_hash, content_hash, timestamp FROM proof_chain ORDER BY chain_height DESC LIMIT 10').all();
        console.table(proofs);
    }
    else {
        console.log(`Unknown command: ${command}`);
        printHelp();
    }
} catch (err) {
    console.error('Database Error:', err.message);
}
