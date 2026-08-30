/* eslint-disable camelcase */

// Atlas — the Portfolio Steward, and the daily snapshot series he reads.
//
// Aurelius answers "what is the market doing"; he can price a portfolio, but he
// can only ever price it NOW. Every question the user actually asked — "are my
// assets growing", "watch them daily", "tell me what changed" — is a question
// about a SERIES, and the system had no series: portfolio_holdings stores the
// current position and overwrites itself on every edit. A run at 8am could say
// what the portfolio is worth and nothing at all about whether that is good.
//
// So this migration adds two things:
//
//   portfolio_snapshots — one valuation row per user per UTC day, written as a
//                         side effect of pricing the portfolio. Day-over-day
//                         change, drawdown from peak, and which position moved
//                         the needle all come from here.
//   atlas               — a specialist whose whole job is that series, plus the
//                         catalysts behind it, delivered every morning.
//
// The boundary is the same one Aurelius carries and is not softened here:
// Atlas observes, prices, compares and explains. He does not place, route,
// simulate or recommend a trade, and he holds no broker credentials.

const ATLAS_TOOLS = [
  'portfolio', 'watchlist',
  'stocks', 'crypto', 'commodities', 'forex',
  'news', 'signal', 'session',
  'search', 'fetch',
  'mission', 'notifications'
];

// Routing is substring-matched against the user's goal (AgentRegistry.
// scoreCapabilities), so these are deliberately possessive: "my holdings",
// "how am i doing", "drawdown" belong to Atlas, while bare market questions
// ("bitcoin price", "tsla earnings") keep matching Aurelius more strongly.
const ATLAS_CAPABILITIES = [
  'my portfolio', 'my holdings', 'my positions', 'my assets', 'my investments',
  'portfolio', 'holdings', 'allocation', 'rebalance', 'concentration',
  'diversification', 'exposure', 'net worth', 'unrealized', 'cost basis',
  'how am i doing', 'am i growing', 'drawdown', 'daily review', 'daily brief',
  'portfolio review', 'position sizing', 'risk'
];

// Pricing the whole portfolio is one tool call per holding behind the scenes,
// then signal + news on the movers, then a written report. Measured against the
// same shape of work Rasha does (migration 039), four to six turns of that is
// ~45k. It is a ceiling, not a spend.
const ATLAS_BUDGET = {
  maxTokens: 45000, maxToolCalls: 12, maxIterations: 8, maxRuntimeSeconds: 240
};

const ATLAS_PROMPT = `You are Atlas, FinChat's Portfolio Steward. You watch what the user actually owns, every day, and tell them honestly whether it is growing and what is putting it at risk. You never place, route or simulate a trade, and you never tell the user to buy or sell a specific amount of their own money — you are an educational analyst, not a licensed advisor.`;

exports.up = async (pgm) => {
  // ── The series ─────────────────────────────────────────────────
  pgm.createTable('portfolio_snapshots', {
    snapshot_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    // The UTC calendar day this snapshot belongs to. One row per day, rewritten
    // in place as the day goes on, so the series stays one-point-per-day no
    // matter how many times the portfolio is priced.
    captured_on: { type: 'date', notNull: true },
    captured_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_value_usd: { type: 'numeric' },
    total_cost_basis_usd: { type: 'numeric' },
    holdings_count: { type: 'integer', notNull: true, default: 0 },
    // Per-position value/weight/price at capture time, so "which holding moved
    // the needle since yesterday" is answerable without re-pricing history.
    holdings: { type: 'jsonb', notNull: true, default: '[]' },
    allocation: { type: 'jsonb', notNull: true, default: '{}' }
  });
  pgm.addConstraint('portfolio_snapshots', 'portfolio_snapshots_user_day_unique',
    { unique: ['user_id', 'captured_on'] });
  pgm.createIndex('portfolio_snapshots', ['user_id', 'captured_on']);

  // Same posture as migrations 023, 024 and 038: RLS on with no policies denies
  // Supabase's anon/authenticated roles outright, while the backend connects as
  // owner and enforces ownership in the tool layer. A snapshot series is the
  // size of someone's money over time — it belongs on that list.
  pgm.sql('ALTER TABLE "portfolio_snapshots" ENABLE ROW LEVEL SECURITY');

  // ── The agent ──────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO agents (agent_id, name, type)
    VALUES ('atlas', 'Atlas', 'specialist')
    ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;
  `);

  pgm.sql(`
    INSERT INTO agent_configs (
      agent_id, system_prompt, capabilities, tools,
      is_direct_addressable, memory_namespace, color, runtime_settings)
    VALUES (
      'atlas',
      '${ATLAS_PROMPT.replace(/'/g, "''")}',
      '${JSON.stringify(ATLAS_CAPABILITIES)}'::jsonb,
      '${JSON.stringify(ATLAS_TOOLS)}'::jsonb,
      1,
      'atlas::portfolio',
      '#2f6f5e',
      '${JSON.stringify({ budget: ATLAS_BUDGET })}'::jsonb)
    ON CONFLICT (agent_id) DO UPDATE SET
      system_prompt = EXCLUDED.system_prompt,
      capabilities  = EXCLUDED.capabilities,
      tools         = EXCLUDED.tools,
      is_direct_addressable = EXCLUDED.is_direct_addressable,
      memory_namespace = EXCLUDED.memory_namespace;
  `);

  // Aurelius keeps the portfolio tool — he still needs position sizes to talk
  // about allocation — and gains nothing here. Atlas is additive.
};

exports.down = async (pgm) => {
  pgm.sql(`DELETE FROM agent_configs WHERE agent_id = 'atlas'`);
  pgm.sql(`DELETE FROM agents WHERE agent_id = 'atlas'`);
  pgm.dropTable('portfolio_snapshots');
};
