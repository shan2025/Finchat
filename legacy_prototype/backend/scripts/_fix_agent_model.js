// Temp (safe to delete): clear per-agent model overrides pointing at models the
// Groq key no longer serves, so those agents use GROQ_PRIMARY_MODEL.
require('dotenv').config();
const { query } = require('../database');

const DEAD = ['deepseek-r1-distill-llama-70b', 'llama-3.3-70b-versatile'];

(async () => {
  const r = await query(`
    UPDATE agent_configs
    SET runtime_settings = jsonb_set(runtime_settings::jsonb, '{model}', '""'::jsonb)
    WHERE runtime_settings::jsonb ->> 'model' = ANY($1)
    RETURNING agent_id, runtime_settings`, [DEAD]);
  console.table(r.rows.map(x => ({ agent_id: x.agent_id, model: JSON.stringify(x.runtime_settings.model) })));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
