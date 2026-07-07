const sqlite3 = require('better-sqlite3');
const db = new sqlite3('finchat.db');
const users = db.prepare('SELECT email, role, created_at FROM users').all();
users.forEach(u => console.log(`- ${u.email} (${u.role})`));
console.log('Total users:', users.length);
