const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'finchat.db');
const db = new Database(dbPath);

console.log('Cleaning up boilerplate from DB...');

// 1. Remove specific sessions for vishnu to force a fresh history
// Or more surgically, remove the boilerplate from the ends of the content
const vishnuSessions = db.prepare("SELECT DISTINCT session_id FROM ai_conversations WHERE persona = 'vishnu'").all();

console.log(`Found ${vishnuSessions.length} sessions for Vishnu.`);

const boilerplate = "[IF YOU NEED ANY BANKING HELP OR HAVE ANY QUESTIONS, FREE TO ASK!]";

// Update ai_conversations
const updateAi = db.prepare("UPDATE ai_conversations SET content = REPLACE(content, ?, '') WHERE content LIKE ?");
const infoAi = updateAi.run(boilerplate, '%' + boilerplate + '%');
console.log(`Updated ${infoAi.changes} entries in ai_conversations.`);

// Update messages
const updateMsg = db.prepare("UPDATE messages SET content = REPLACE(content, ?, '') WHERE content LIKE ?");
const infoMsg = updateMsg.run(boilerplate, '%' + boilerplate + '%');
console.log(`Updated ${infoMsg.changes} entries in messages.`);

console.log('Cleanup complete.');
