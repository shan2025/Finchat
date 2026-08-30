// One-shot backfill for migration 045: copy any mind-map original still sitting
// on this machine's disk into its row, so it survives the next deploy.
//
// Safe to run repeatedly and safe to run where the files are already gone — a
// row whose bytes have been wiped is simply skipped and reported, since there
// is nothing to recover. Run it on a host whose uploads/ still has the files:
//   node scripts/backfill-mind-map-doc-bytes.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const { UPLOAD_DIR } = require('../services/attachments');

(async () => {
  const r = await query(`
    SELECT doc_id, filename, stored_name, size_bytes FROM mind_map_docs
    WHERE data IS NULL AND stored_name IS NOT NULL
    ORDER BY created_at ASC
  `);
  console.log(`${r.rows.length} document(s) with no stored bytes.`);

  let filled = 0, missing = 0;
  for (const d of r.rows) {
    const full = path.join(UPLOAD_DIR, path.basename(String(d.stored_name)));
    if (!fs.existsSync(full)) {
      console.log(`  – ${d.filename}: not on this disk (${d.stored_name})`);
      missing++;
      continue;
    }
    const buf = fs.readFileSync(full);
    await query('UPDATE mind_map_docs SET data = $1 WHERE doc_id = $2', [buf, d.doc_id]);
    console.log(`  ✓ ${d.filename}: ${buf.length} bytes stored`);
    filled++;
  }
  console.log(`Done. ${filled} recovered, ${missing} gone for good (re-upload to restore).`);
  process.exit(0);
})();
