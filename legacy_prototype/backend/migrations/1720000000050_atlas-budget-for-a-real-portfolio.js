/* eslint-disable camelcase */

// Atlas's token ceiling, raised for a portfolio that actually exists.
//
// The 45k in migration 044 was sized against a portfolio nobody had yet: a few
// hand-entered rows, priced, discussed. Now that real accounts feed him, a
// single valuation carries eleven live positions, a per-account freshness list
// and a page of honesty flags — and the conversation around it carries tables
// the user pastes back in.
//
// The first heavy question hit the ceiling mid-sentence:
//
//   exec_1789025065777_5ekqz2 — atlas — budget_exceeded
//   tokens_used 51,720 / max_tokens 45,000 — 5 iterations, 4 tool calls
//
// The user got "I hit my per-answer limit before I could finish writing it"
// instead of an answer. That message is honest, which is why it exists, but it
// is not what someone asking about their savings should routinely receive.
//
// The payload was cut first, because a bigger allowance for a wasteful prompt is
// the wrong trade: the per-holding record dropped from 348 to 184 characters
// (always-null P/L fields, a syncedAt repeated on every row while `sources`
// already carries it, an exchange name that only restated the account), the
// tool's catalogue entry from 2,722 to 2,196, and his prompt from 6,010 to
// 5,487. That returned roughly 3,200 tokens per run — which still leaves that
// query over the line at ~48.5k.
//
// So the ceiling moves to 60,000, matching the top rung of the "think hard"
// ladder. It is a CEILING, NOT A SPEND, and the ordinary runs that surround the
// failure make that plain: 6,359 / 8,348 / 11,049 tokens, all completing
// naturally. Nothing costs more because this number is larger; one heavy
// question a week stops being truncated.
//
// The iteration and tool-call limits are deliberately untouched — that run used
// 5 of 8 and 4 of 12, so neither was binding.

const ATLAS_BUDGET = {
  maxTokens: 60000, maxToolCalls: 12, maxIterations: 8, maxRuntimeSeconds: 240
};

exports.up = async (pgm) => {
  // jsonb_set rather than a whole-object write: runtime_settings also carries
  // tone and model preferences that are set from the Agents page, and replacing
  // the object here would silently discard whatever the user has chosen there.
  pgm.sql(`
    UPDATE agent_configs
       SET runtime_settings = jsonb_set(
             COALESCE(runtime_settings, '{}'::jsonb),
             '{budget}',
             '${JSON.stringify(ATLAS_BUDGET)}'::jsonb,
             true)
     WHERE agent_id = 'atlas';
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    UPDATE agent_configs
       SET runtime_settings = jsonb_set(
             COALESCE(runtime_settings, '{}'::jsonb),
             '{budget}',
             '${JSON.stringify({ ...ATLAS_BUDGET, maxTokens: 45000 })}'::jsonb,
             true)
     WHERE agent_id = 'atlas';
  `);
};
