/* eslint-disable camelcase */

// Record how much of each prompt the provider served from its own prefix cache.
//
// DeepSeek caches an identical prompt prefix automatically and bills the hit at
// a fraction of the miss price. Measured 2026-08-18: resending the same
// 1,933-token prefix returned prompt_cache_hit_tokens 1920 — 99% of it.
//
// This matters more than a cost line, because it is the only way to SEE the
// invariant that makes it work. ContextBuilder must emit a byte-identical first
// system message on every turn of a run; anything that perturbs it — a
// per-turn catalogue rendering, a timestamp, a reordered directive — silently
// drops the hit rate to zero while every other metric looks fine. A run whose
// cached_tokens is 0 after the first turn has a prefix bug.
//
// Providers without prefix caching simply report nothing, which stores as 0, so
// this is also a rough measure of how much traffic the caching provider is
// actually serving.

exports.up = async (pgm) => {
  pgm.addColumn('inference_metrics', {
    cached_tokens: { type: 'integer', notNull: true, default: 0 }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumn('inference_metrics', 'cached_tokens');
};
