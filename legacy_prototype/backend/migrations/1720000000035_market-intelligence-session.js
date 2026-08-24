/* eslint-disable camelcase */

// Phase 3 of the investment-intelligence build: the Market Intelligence Session.
// Grant Aurelius the `session` tool and seed a daily session mission (DISABLED
// by default, like the other flagship seeds — the user enables it in the UI).
// The mission goal is a single-tool wrap so there is almost no LLM failure
// surface: the report itself is produced deterministically by the session tool.

exports.up = async (pgm) => {
  // Idempotent append of the session tool to Aurelius's manifest.
  pgm.sql(`
    UPDATE agent_configs
       SET tools = tools || '["session"]'::jsonb
     WHERE agent_id = 'aurelius'
       AND NOT (tools @> '["session"]'::jsonb);
  `);

  pgm.sql(`
    INSERT INTO agent_missions (mission_id, user_id, agent_id, title, goal, cadence, enabled, max_tokens_per_run)
    SELECT 'mission_seed_aurelius_session', u.user_id, 'aurelius',
           'Market Intelligence Session (daily)',
           'Call the "session" tool with an empty input {} to generate my Market Intelligence Session over my watchlist. Deliver the markdown it returns verbatim as the report — do not rewrite the numbers, and add at most a one-line intro. This is educational analysis, not financial advice, and no trades are ever executed.',
           'daily', false, 6000
    FROM users u
    WHERE u.role NOT IN ('system') AND u.email NOT LIKE '%@system.finchat.local'
    ORDER BY u.created_at ASC LIMIT 1
    ON CONFLICT (mission_id) DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`DELETE FROM agent_missions WHERE mission_id = 'mission_seed_aurelius_session';`);
  pgm.sql(`
    UPDATE agent_configs
       SET tools = (SELECT jsonb_agg(t) FROM jsonb_array_elements(tools) t WHERE t <> '"session"'::jsonb)
     WHERE agent_id = 'aurelius';
  `);
};
