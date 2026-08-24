/* eslint-disable camelcase */

// "Create tasks from chat" — the standing-work sprint.
//
// The mission engine (agent_missions + /api/cron/tick) already knew how to run a
// standing goal on a schedule; the only way to CREATE one was the Agents page.
// This migration hands that power to the agents themselves via the `mission`
// tool, and adds the three state tables the recurring work actually needs:
//
//   user_resumes       — Rasha's stored resume, so a 4am run has something to
//                        tailor without the user pasting it into the mission goal
//   job_applications   — the application ledger, so "how many did I apply to?"
//                        has an answer and a daily hunt can skip duplicates
//   portfolio_holdings — Aurelius's positions, so a portfolio review is about
//                        the user's actual money rather than a generic watchlist
//
// Nothing here executes anything on the user's behalf: applications stay drafts
// the user submits, and no trade is ever placed.

exports.up = async (pgm) => {
  // ── Rasha: stored resumes ──────────────────────────────────────
  pgm.createTable('user_resumes', {
    resume_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    label: { type: 'text', notNull: true, default: 'default' },
    content: { type: 'text', notNull: true },
    target_role: { type: 'text' },
    // Exactly one primary per user is the contract every tool reads against;
    // enforced by the partial unique index below rather than by convention.
    is_primary: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('user_resumes', 'user_resumes_user_label_unique', { unique: ['user_id', 'label'] });
  pgm.sql(`CREATE UNIQUE INDEX user_resumes_one_primary ON user_resumes (user_id) WHERE is_primary;`);

  // ── Rasha: the application ledger ──────────────────────────────
  pgm.createTable('job_applications', {
    application_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    company: { type: 'text' },
    location: { type: 'text' },
    url: { type: 'text' },
    source: { type: 'text' },              // linkedin | naukri | indeed | remotive | …
    // drafted → the agent prepared a package; applied → the human submitted it.
    // The agent may only ever write 'drafted' or 'shortlisted' on its own; the
    // later states are the user telling us what happened.
    status: { type: 'text', notNull: true, default: 'drafted' },
    match_score: { type: 'integer' },
    notes: { type: 'text' },
    draft: { type: 'text' },               // the cover-letter package, if one was written
    mission_id: { type: 'text' },          // which standing task surfaced it (null = ad hoc)
    applied_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('job_applications', ['user_id', 'created_at']);
  pgm.createIndex('job_applications', ['user_id', 'status']);
  // De-duplication key for a daily hunt: the same posting URL must not be
  // logged twice, but plenty of rows legitimately have no URL at all — hence a
  // partial unique index rather than a table constraint.
  pgm.sql(`CREATE UNIQUE INDEX job_applications_user_url_unique
             ON job_applications (user_id, url) WHERE url IS NOT NULL;`);

  // ── Aurelius: portfolio holdings ───────────────────────────────
  pgm.createTable('portfolio_holdings', {
    holding_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    symbol: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true, default: 'crypto' }, // crypto | stock | commodity | cash
    quantity: { type: 'numeric', notNull: true, default: 0 },
    avg_cost: { type: 'numeric' },          // per-unit cost basis in `currency`, optional
    currency: { type: 'text', notNull: true, default: 'USD' },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('portfolio_holdings', 'portfolio_holdings_user_symbol_kind_unique',
    { unique: ['user_id', 'symbol', 'kind'] });

  // ── Tool manifests ─────────────────────────────────────────────
  // Idempotent appends (see migration 035): the manifests have been rewritten
  // wholesale by six earlier migrations and re-stating a full list here would
  // silently revoke whatever a later one granted.
  const grant = (agentId, tools) => {
    for (const t of tools) {
      pgm.sql(`
        UPDATE agent_configs
           SET tools = tools || '["${t}"]'::jsonb
         WHERE agent_id = '${agentId}'
           AND NOT (tools @> '["${t}"]'::jsonb);
      `);
    }
  };
  // Every specialist can now create its own standing work from a chat turn.
  grant('aurelius', ['mission', 'portfolio']);
  grant('rasha', ['mission', 'applications']);
  grant('nova', ['mission']);

  // ── Plato's manifest is deliberately untouched ─────────────────
  // The orchestrator is exempt from tool scoping in listTools(), so it already
  // sees `mission`. Appending to its ["search"] row would turn that row into a
  // real restriction for the first time and cut it off from everything else.
};

exports.down = async (pgm) => {
  const revoke = (agentId, tools) => {
    for (const t of tools) {
      pgm.sql(`
        UPDATE agent_configs
           SET tools = COALESCE(
                 (SELECT jsonb_agg(x) FROM jsonb_array_elements(tools) x WHERE x <> '"${t}"'::jsonb),
                 '[]'::jsonb)
         WHERE agent_id = '${agentId}';
      `);
    }
  };
  revoke('aurelius', ['mission', 'portfolio']);
  revoke('rasha', ['mission', 'applications']);
  revoke('nova', ['mission']);

  pgm.dropTable('portfolio_holdings');
  pgm.dropTable('job_applications');
  pgm.dropTable('user_resumes');
};
