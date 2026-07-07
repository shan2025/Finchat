const { getDB } = require('../database');
const { sha256 } = require('../services/proof');

console.log('🔧 Fixing Proof Chain...');
const db = getDB();

console.log('🔧 Fixing Proof Chain (Per Channel)...');

// 1. Get all unique channels that have proofs
const channelIds = db.prepare(`
  SELECT DISTINCT m.channel_id 
  FROM proof_chain p
  JOIN messages m ON p.message_id = m.id
`).all().map(r => r.channel_id);

console.log(`Found ${channelIds.length} channels with proofs.`);

let totalFixed = 0;

db.transaction(() => {
    for (const channelId of channelIds) {
        console.log(`Processing channel: ${channelId}`);

        const chain = db.prepare(`
      SELECT p.*, m.content 
      FROM proof_chain p 
      JOIN messages m ON p.message_id = m.id 
      WHERE m.channel_id = ?
      ORDER BY p.chain_height ASC
    `).all(channelId);

        let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
        let channelFixed = 0;

        for (const block of chain) {
            let needsUpdate = false;

            // 1. Recalculate content hash
            const contentHash = sha256((block.content || '').trim());
            if (contentHash !== block.content_hash) {
                // console.log(`  [#${block.chain_height}] Content mismatch.`);
                needsUpdate = true;
            }

            // 2. Check prev_hash
            if (block.prev_hash !== prevHash) {
                // console.log(`  [#${block.chain_height}] PrevHash mismatch.`);
                needsUpdate = true;
            }

            // 3. Recalculate block hash
            const rawData = `${prevHash}|${block.chain_height}|${block.sender_id}|${contentHash}|${block.timestamp}`;
            const newHash = sha256(rawData);

            if (newHash !== block.hash) {
                // console.log(`  [#${block.chain_height}] Block hash invalid.`);
                needsUpdate = true;
            }

            if (needsUpdate) {
                db.prepare(`
          UPDATE proof_chain 
          SET content_hash = ?, prev_hash = ?, hash = ?
          WHERE id = ?
        `).run(contentHash, prevHash, newHash, block.id);
                channelFixed++;
                prevHash = newHash;
            } else {
                prevHash = block.hash;
            }
        }
        console.log(`  Fixed ${channelFixed} blocks in channel ${channelId}`);
        totalFixed += channelFixed;
    }
})();

console.log(`✅ Chain repair complete. Fixed ${totalFixed} blocks total.`);
