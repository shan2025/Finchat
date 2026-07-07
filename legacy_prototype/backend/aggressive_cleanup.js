const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'finchat.db');
const db = new Database(dbPath);

console.log('Aggressively cleaning up Vishnu sessions...');

// Find sessions for vishnu that contain the boilerplate
const sessionsToClean = db.prepare("SELECT DISTINCT session_id FROM ai_conversations WHERE persona = 'vishnu' AND content LIKE '%BANKING HELP%'").all();

console.log(`Found ${sessionsToClean.length} sessions to purge.`);

sessionsToClean.forEach(s => {
    const session_id = s.session_id;
    console.log(`Purging session: ${session_id}`);

    // Delete from ai_conversations to clear LLM context
    const delAi = db.prepare("DELETE FROM ai_conversations WHERE session_id = ?");
    const infoAi = delAi.run(session_id);
    console.log(`- Deleted ${infoAi.changes} entries from ai_conversations.`);

    // We don't necessarily need to delete from 'messages' (the UI logs),
    // but we SHOULD remove the boilerplate from them so the user doesn't see it anymore.
    const updateMsg = db.prepare("UPDATE messages SET content = REPLACE(content, '[IF YOU NEED ANY BANKING HELP OR HAVE ANY QUESTIONS, FEEL FREE TO ASK!]', '') WHERE content LIKE '%BANKING HELP%'");
    const infoMsg = updateMsg.run();

    // Some might have different casing or extra spacing, let's be more general
    const updateMsgGeneral = db.prepare("UPDATE messages SET content = '[Character Updated]' WHERE content LIKE '%BANKING HELP%' AND content LIKE '%[Vishnu]%'");
    // Wait, let's just replace the whole message content for those system messages if we can't get the exact substring.
});

console.log('Cleanup complete.');
