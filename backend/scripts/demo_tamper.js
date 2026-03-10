// scripts/demo_tamper.js — Proof of Concept: Breaking the Chain
const { getDB } = require('../database');
const { createProof, verifyChain, sha256 } = require('../services/proof');
const { v4: uuidv4 } = require('uuid');

const db = getDB();

const runId = uuidv4().substring(0, 8);
// Ensure we have a clean test channel
const TEST_CHANNEL = 'demo-channel-' + runId;
const USER_ID = 'demo-hacker-' + runId;
const USER_EMAIL = 'hacker-' + runId + '@example.com';

console.log(`\n🔗 FinChat Proof Chain Demo`);
console.log(`==================================================`);
console.log(`Creating test channel: ${TEST_CHANNEL}`);

// Seed DB if needed
try {
    db.prepare("INSERT OR IGNORE INTO channels (id, name, type) VALUES (?, ?, 'private')")
        .run(TEST_CHANNEL, TEST_CHANNEL);

    // Use random email to avoid UNIQUE constraint on email
    db.prepare("INSERT OR IGNORE INTO users (id, name, email) VALUES (?, 'Mr Hacker', ?)")
        .run(USER_ID, USER_EMAIL);
} catch (e) { console.warn("Setup warning:", e.message); }

console.log(`\n📝 Generating 5 linked messages...`);

// 1. Generate 5 valid messages
const msgIds = [];
for (let i = 1; i <= 5; i++) {
    const msgId = uuidv4();
    const content = `Message #${i}: Secure data`;

    // Insert message
    db.prepare("INSERT INTO messages (id, channel_id, sender_id, content) VALUES (?, ?, ?, ?)")
        .run(msgId, TEST_CHANNEL, USER_ID, content);

    // Create proof (links to previous)
    const proof = createProof(msgId, USER_ID, content, TEST_CHANNEL);
    msgIds.push(msgId);

    console.log(`   [Block #${proof.chain_height}] Hash: ${proof.hash.substring(0, 16)}... | Prev: ${proof.prev_hash.substring(0, 16)}...`);
}

// 2. Verify chain is valid
console.log(`\n🔍 Verifying Chain (Expect PASS)...`);
let result = verifyChain(TEST_CHANNEL);
if (result.valid) {
    console.log(`   ✅ Chain is VALID. All ${result.totalBlocks} blocks linked correctly.`);
} else {
    console.error(`   ❌ Chain INVALID!`, result.issues);
    process.exit(1);
}

// 3. Tamper with Message #3
console.log(`\n😈 TAMPERING ATTACK: Modifying Message #3 in SQLite...`);
const targetMsgId = msgIds[2]; // Index 2 is Message #3
db.prepare("UPDATE messages SET content = 'Message #3: HACKED CONTENT' WHERE id = ?")
    .run(targetMsgId);
console.log(`   Changed content of Block #3 to "Message #3: HACKED CONTENT"`);

// 4. Verify chain again
console.log(`\n🔍 Verifying Chain (Expect FAIL)...`);
result = verifyChain(TEST_CHANNEL);

if (!result.valid) {
    console.log(`   ✅ SUCCESS! Tampering detected.`);
    console.log(`   Issues found:`);
    result.issues.forEach(issue => console.log(`   👉 ${issue}`));
} else {
    console.error(`   ❌ FAILED! Tampering was NOT detected.`);
}

console.log(`\n--------------------------------------------------`);
console.log(`😈 SOPHISTICATED ATTACK: Try to hide tampering by recalculating hash...`);

// Recalculate hash for block 3 to match new content
const row = db.prepare("SELECT * FROM proof_chain WHERE message_id = ?").get(targetMsgId);
const newContentHash = sha256('Message #3: HACKED CONTENT');
const newData = `${row.prev_hash}|${row.chain_height}|${row.sender_id}|${newContentHash}|${row.timestamp}`;
const newHash = sha256(newData);

db.prepare("UPDATE proof_chain SET content_hash = ?, hash = ? WHERE message_id = ?")
    .run(newContentHash, newHash, targetMsgId);

console.log(`   Updated Block #3 proof to match hacked content.`);
console.log(`   Now Block #4's prev_hash should mismatch!`);

console.log(`\n🔍 Verifying Chain again (Expect FAIL at Block #4)...`);
const result2 = verifyChain(TEST_CHANNEL);

if (!result2.valid) {
    if (result2.issues.some(i => i.includes('Block #4') || i.includes('prev_hash mismatch'))) {
        console.log(`   ✅ SUCCESS! Chain broke at Block #4 as expected.`);
        result2.issues.forEach(issue => console.log(`   👉 ${issue}`));
    } else {
        console.log(`   ✅ Tampering detected, but different issue:`, result2.issues);
        result2.issues.forEach(issue => console.log(`   👉 ${issue}`));
    }
} else {
    console.error(`   ❌ FALIED! Chain passed verification after sophisticated tampering.`);
}

console.log(`\n==================================================`);
console.log(`demo_tamper.js complete.`);
