const sqlite3 = require('better-sqlite3');
const db = new sqlite3('finchat.db');
const schema = db.prepare("PRAGMA table_info(users)").all();
console.table(schema);
