/* eslint-disable camelcase */

// Split the execution token counter into prompt vs completion.
//
// `tokens_used` charges total_tokens — prompt included — and the prompt is
// re-sent in full on every iteration of the reasoning loop. So a run's cost is
// dominated by re-reading its own context, and the single counter cannot tell
// the two apart. Measured on the Rasha verification run (2026-08-18):
//
//   turn 1   prompt 3,873   completion 878
//   turn 2   prompt 2,987   completion  55
//   ------------------------------------------
//   total    prompt 6,860   completion 933   = 7,793 charged
//
// 88% of that run's budget was context re-read, not work produced. That is the
// number that justifies capping context growth, and until now nothing recorded
// it: `tokens_used` alone reads as "this run was expensive" with no way to see
// whether the expense bought anything.
//
// `tokens_used` keeps its exact current meaning — total, which is what the
// providers actually meter and therefore what the budget must enforce against.
// These two are additional detail, not a replacement.

exports.up = async (pgm) => {
  pgm.addColumn('executions', {
    prompt_tokens_used: { type: 'integer', notNull: true, default: 0 },
    completion_tokens_used: { type: 'integer', notNull: true, default: 0 }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumn('executions', ['prompt_tokens_used', 'completion_tokens_used']);
};
