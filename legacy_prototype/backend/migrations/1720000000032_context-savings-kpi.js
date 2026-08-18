/* eslint-disable camelcase */

// Make context efficiency measurable.
//
// Migration 031 revealed the problem: a verified 2-turn run charged 6,860
// prompt tokens to produce 1,133 of output — 86% of its budget spent re-reading
// its own instructions. Measured per block, the cause was the tool catalogue:
// 18 tools rendered with full parameter schemas, 6,977 chars ≈ 1,744 tokens,
// rebuilt and re-sent on EVERY iteration. On a first turn it was 99.7% of the
// entire request against a 10-token question.
//
// ContextBuilder now compacts that catalogue once tool results are in hand, and
// caps conversation history at a fixed character budget. This column records
// what each run did NOT send as a result, accumulated per turn alongside the
// token counters, so the next context change can be judged against a number
// instead of "the prompt feels smaller".
//
// Characters rather than tokens on purpose: the saving is computed exactly by
// diffing two renderings of the same block, where a token count of text that
// was never sent to a provider could only ever be an estimate. Divide by ~4 for
// a token figure.

exports.up = async (pgm) => {
  pgm.addColumn('executions', {
    context_chars_saved: { type: 'integer', notNull: true, default: 0 }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumn('executions', 'context_chars_saved');
};
