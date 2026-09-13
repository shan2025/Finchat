/* eslint-disable camelcase */

// Portfolio alerts — the "tell me before it gets bad" half of Atlas.
//
// The user asked for Atlas to watch their assets and warn them in time to act.
// Two parts of that request are answered honestly here, and one is not built:
//
//   BUILT   — continuous monitoring of what they hold, against risk lines that
//             mean something: a trailing drawdown from the recent peak, a sharp
//             24-hour fall, a stablecoin losing its peg, a break below a long-
//             term trend, a volatility regime change, a price level they set.
//             Checked every 15 minutes by the existing cron tick, and delivered
//             through createNotification — so it reaches Telegram, not just the
//             in-app bell.
//   HONEST  — no system can warn "before" a fall starts; nobody can see one
//             coming. What this does is catch a move within minutes of it
//             crossing a line, instead of whenever the user next opens the app.
//             The messages say that, and never tell anyone to sell.
//   NOT BUILT — telling the user what to buy and for how long. That is
//             personalised investment advice, which FinChat does not give and
//             which, offered to users in India, is regulated activity (SEBI).
//
// Two tables:
//
//   portfolio_alert_rules  — what to watch. `state` is the anti-spam mechanism:
//                            a rule fires on the transition armed -> triggered,
//                            and only fires again if the condition clears and
//                            re-crosses, or WORSENS by a further step after a
//                            cooldown. Without it, a 20% drawdown would send the
//                            same message to someone's phone every 15 minutes
//                            for as long as the drawdown lasted.
//   portfolio_alert_events — what was sent. The audit trail, and what Atlas
//                            reads when asked "what have you warned me about?"
//
// Default protection is materialised as real rows (created_by = 'default'), not
// computed on the fly, so the user can SEE what is being watched and switch any
// of it off. Switching a default off disables the row rather than deleting it —
// deleting would let the monitor quietly recreate it on the next pass.

exports.up = async (pgm) => {
  pgm.createTable('portfolio_alert_rules', {
    rule_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    // NULL symbol = a portfolio-level rule (portfolio_drawdown).
    symbol: { type: 'text' },
    kind: { type: 'text' },          // crypto | stock
    exchange: { type: 'text' },      // NSE | BSE | BINANCE | null
    // drawdown_from_peak | sharp_drop | price_below | price_above |
    // trend_break | volatility_spike | depeg | portfolio_drawdown
    rule_type: { type: 'text', notNull: true },
    // Percent for relative rules (15 = 15%), an absolute price for price_*,
    // a multiple for volatility_spike (2 = twice the long-run level).
    threshold: { type: 'numeric', notNull: true },
    window_days: { type: 'integer' },
    enabled: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'text', notNull: true, default: 'user' }, // user | atlas | default
    note: { type: 'text' },
    state: { type: 'text', notNull: true, default: 'armed' },     // armed | triggered
    last_value: { type: 'numeric' },
    last_fired_at: { type: 'timestamptz' },
    last_evaluated_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('portfolio_alert_rules', ['user_id', 'enabled']);
  // One default of each type per asset per user — the monitor ensures defaults
  // idempotently, so this is what stops two overlapping ticks creating twins.
  pgm.sql(`
    CREATE UNIQUE INDEX portfolio_alert_rules_one_default
      ON portfolio_alert_rules (user_id, COALESCE(symbol, '*'), rule_type)
      WHERE created_by = 'default'
  `);

  pgm.createTable('portfolio_alert_events', {
    event_id: { type: 'text', primaryKey: true },
    rule_id: { type: 'text', references: '"portfolio_alert_rules"', onDelete: 'SET NULL' },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    symbol: { type: 'text' },
    rule_type: { type: 'text', notNull: true },
    severity: { type: 'text', notNull: true, default: 'warning' }, // warning | critical
    observed_value: { type: 'numeric' },
    threshold: { type: 'numeric' },
    title: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    escalation: { type: 'boolean', notNull: true, default: false },
    fired_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('portfolio_alert_events', ['user_id', 'fired_at']);

  // Same posture as every user-data table since 023: RLS on, no policies, so
  // Supabase's anon/authenticated roles are denied and the backend (connecting
  // as owner) enforces ownership in the tool layer.
  pgm.sql('ALTER TABLE "portfolio_alert_rules" ENABLE ROW LEVEL SECURITY');
  pgm.sql('ALTER TABLE "portfolio_alert_events" ENABLE ROW LEVEL SECURITY');

  // Give the tools to the agents that should hold them. Appended only if absent,
  // so re-running is harmless and nothing an operator added is disturbed.
  //   atlas    — analytics AND alerts: he is the one watching the portfolio.
  //   aurelius — analytics only: the market analyst compares assets, but the
  //              monitoring of what the user owns stays with the steward.
  for (const [agent, tools] of [['atlas', ['analytics', 'alerts']], ['aurelius', ['analytics']]]) {
    for (const tool of tools) {
      pgm.sql(`
        UPDATE agent_configs
           SET tools = tools || '["${tool}"]'::jsonb
         WHERE agent_id = '${agent}'
           AND NOT (tools @> '["${tool}"]'::jsonb)
      `);
    }
  }
};

exports.down = async (pgm) => {
  for (const [agent, tools] of [['atlas', ['analytics', 'alerts']], ['aurelius', ['analytics']]]) {
    for (const tool of tools) {
      pgm.sql(`UPDATE agent_configs SET tools = tools - '${tool}' WHERE agent_id = '${agent}'`);
    }
  }
  pgm.dropTable('portfolio_alert_events');
  pgm.dropTable('portfolio_alert_rules');
};
