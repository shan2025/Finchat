const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'finchat.db');
console.log('Connecting to DB at:', dbPath);

const db = new Database(dbPath);

const messages = db.prepare("SELECT role, content FROM ai_conversations WHERE content LIKE '%BANKING HELP%' LIMIT 5").all();
console.log('Found instances in ai_conversations:', messages.length);
messages.forEach(m => console.log(`- [${m.role}]: ${m.content.substring(0, 100)}...`));

const msgs = db.prepare("SELECT content FROM messages WHERE content LIKE '%BANKING HELP%' LIMIT 5").all();
console.log('Found instances in messages:', msgs.length);
msgs.forEach(m => console.log(`- ${m.content.substring(0, 100)}...`));
