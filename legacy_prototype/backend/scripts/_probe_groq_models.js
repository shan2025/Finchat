// Temp (safe to delete): fire one real mission run end-to-end and report how it
// actually terminated, so the budget fix + model swap are verified against the
// live provider rather than against fakes.
require('dotenv').config();
const { runMission } = require('../services/agents/MissionScheduler');
const { query } = require('../database');

const MISSION_ID = process.argv[2] || 'mission_seed_nova_researchdigest';

(async () => {
  const t0 = Date.now();
  let out, err;
  try {
    out = await runMission(MISSION_ID, { manual: true });
  } catch (e) {
    err = e;
  }
  console.log(`\n=== finished in ${Math.round((Date.now() - t0) / 1000)}s ===`);
  if (err) console.log(`THREW: ${err.message}`);
  if (out) console.log(`RESULT: success=${out.success} exec=${out.executionId}`);

  const r = await query(`
    SELECT execution_id, current_state, completion_reason, iterations_used,
           tool_calls_used, max_tool_calls, tokens_used, max_tokens,
           round(extract(epoch from (updated_at - created_at))) AS elapsed_s
    FROM executions ORDER BY created_at DESC LIMIT 1`);
  console.table(r.rows);

  const m = await query(
    'SELECT title, enabled, consecutive_failures, left(last_result_preview, 300) AS preview FROM agent_missions WHERE mission_id = $1',
    [MISSION_ID]);
  console.log('\n--- mission row ---');
  console.log(m.rows[0]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
