const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'finchat.db');
const db = new Database(dbPath);

const messages = db.prepare("SELECT content FROM ai_conversations WHERE content LIKE '%BANKING HELP%' LIMIT 2").all();
console.log('SURVEY RESULTS:');
messages.forEach((m, i) => {
    console.log(`[${i}] RAW CONTENT:`);
    console.log('---START---');
    console.log(m.content);
    console.log('---END---');
});
