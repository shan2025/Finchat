const { getDB } = require('../database');
const { verifyChain } = require('../services/proof');

console.log('🔍 Verifying All Channels...');
const db = getDB();

const channels = db.prepare('SELECT id, name FROM channels').all();

channels.forEach(c => {
    console.log(`\nChecking channel: ${c.name} (${c.id})`);
    const res = verifyChain(c.id);
    if (res.valid) {
        console.log(`✅ VALID. ${res.totalBlocks} blocks.`);
    } else {
        console.log(`❌ INVALID. ${res.issues.length} issues found.`);
        res.issues.forEach(i => console.log(`   👉 ${i}`));
    }
});
