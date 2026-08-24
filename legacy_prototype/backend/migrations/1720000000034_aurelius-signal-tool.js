/* eslint-disable camelcase */

// Give Aurelius the SignalTool (Phase 2 of the investment-intelligence build):
// a deterministic BULLISH/BEARISH/NEUTRAL read fusing price momentum, trend,
// cross-venue agreement, and news-catalyst sentiment. Idempotent — appends
// "signal" only if it isn't already in the manifest.

exports.up = async (pgm) => {
  pgm.sql(`
    UPDATE agent_configs
       SET tools = tools || '["signal"]'::jsonb
     WHERE agent_id = 'aurelius'
       AND NOT (tools @> '["signal"]'::jsonb);
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    UPDATE agent_configs
       SET tools = (SELECT jsonb_agg(t) FROM jsonb_array_elements(tools) t WHERE t <> '"signal"'::jsonb)
     WHERE agent_id = 'aurelius';
  `);
};
