/* eslint-disable camelcase */

// Sprint 7 — Autonomous agent missions + tool expansion.
// - agent_missions: standing goals an agent re-runs on a schedule
// - watchlists: per-user crypto/stock symbols missions read to know what to track
// - agent_configs.tools: wire the new FetchTool/CrawlTool/NewsTool/ApplyDraftTool/WatchlistTool
// - Seed the three flagship missions DISABLED (they spend Groq tokens unattended;
//   the user flips them on from the Agents page when ready).

exports.up = async (pgm) => {
  pgm.createTable('agent_missions', {
    mission_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    agent_id: { type: 'text', notNull: true }, // aurelius | rasha | nova | plato
    title: { type: 'text', notNull: true },
    goal: { type: 'text', notNull: true },
    cadence: { type: 'text', notNull: true, default: 'daily' }, // '15m'|'1h'|'6h'|'daily'|raw cron
    enabled: { type: 'boolean', notNull: true, default: false },
    max_tokens_per_run: { type: 'integer', notNull: true, default: 4000 },
    last_run_at: { type: 'timestamptz' },
    last_execution_id: { type: 'text' },
    last_result_preview: { type: 'text' },
    next_run_at: { type: 'timestamptz' },
    consecutive_failures: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('agent_missions', ['user_id']);
  pgm.createIndex('agent_missions', ['agent_id', 'enabled']);

  pgm.createTable('watchlists', {
    watch_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    symbol: { type: 'text', notNull: true },   // BTC, SOL, TSLA, gold, …
    kind: { type: 'text', notNull: true, default: 'crypto' }, // crypto | stock | commodity
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('watchlists', 'watchlists_user_symbol_kind_unique',
    { unique: ['user_id', 'symbol', 'kind'] });

  // Tool manifests: keep every agent's existing tools and add the new ones.
  pgm.sql(`UPDATE agent_configs SET tools = '["stocks","search","crypto","commodities","news","watchlist","fetch"]'::jsonb WHERE agent_id = 'aurelius';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","resume","jobs","fetch","apply_draft"]'::jsonb WHERE agent_id = 'rasha';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","paper","fetch","crawl","news"]'::jsonb WHERE agent_id = 'nova';`);

  // Flagship mission seeds — DISABLED by default, owned by the earliest human user.
  pgm.sql(`
    INSERT INTO agent_missions (mission_id, user_id, agent_id, title, goal, cadence, enabled, max_tokens_per_run)
    SELECT 'mission_seed_rasha_jobhunt', u.user_id, 'rasha',
           'Daily job hunt',
           'Search current openings for entry-level product analyst, data analyst and AI engineer roles (use jobs, search and fetch). Shortlist the 3 best matches with direct application URLs, then draft a tailored cover letter for the top match with apply_draft. Do NOT submit anything anywhere — drafts only, awaiting my approval.',
           'daily', false, 4000
    FROM users u
    WHERE u.role NOT IN ('system') AND u.email NOT LIKE '%@system.finchat.local'
    ORDER BY u.created_at ASC LIMIT 1
    ON CONFLICT (mission_id) DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO agent_missions (mission_id, user_id, agent_id, title, goal, cadence, enabled, max_tokens_per_run)
    SELECT 'mission_seed_aurelius_cryptobrief', u.user_id, 'aurelius',
           'Crypto brief (6h)',
           'Check my watchlist (watchlist tool, action "list"; if it is empty use BTC, ETH and SOL). For each symbol get the current price and 24h change with the crypto tool, and pull one or two relevant recent headlines with the news tool. Produce a short brief per symbol: price move, the news driving it, and an EDUCATIONAL buy/sell/hold rationale with sources cited. This is not financial advice and no trades are ever executed.',
           '6h', false, 4000
    FROM users u
    WHERE u.role NOT IN ('system') AND u.email NOT LIKE '%@system.finchat.local'
    ORDER BY u.created_at ASC LIMIT 1
    ON CONFLICT (mission_id) DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO agent_missions (mission_id, user_id, agent_id, title, goal, cadence, enabled, max_tokens_per_run)
    SELECT 'mission_seed_nova_researchdigest', u.user_id, 'nova',
           'Daily research digest',
           'Compile today''s frontier AI research digest: use the paper tool for new arXiv work on large language models and agents, the news tool for AI industry headlines, and fetch to pull details from the most interesting link. Synthesize into a 5-bullet digest with source URLs on every bullet.',
           'daily', false, 4000
    FROM users u
    WHERE u.role NOT IN ('system') AND u.email NOT LIKE '%@system.finchat.local'
    ORDER BY u.created_at ASC LIMIT 1
    ON CONFLICT (mission_id) DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  pgm.dropTable('watchlists');
  pgm.dropTable('agent_missions');
  pgm.sql(`UPDATE agent_configs SET tools = '["stocks","search","crypto","commodities"]'::jsonb WHERE agent_id = 'aurelius';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","resume","jobs"]'::jsonb WHERE agent_id = 'rasha';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","paper"]'::jsonb WHERE agent_id = 'nova';`);
};
