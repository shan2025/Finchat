// services/cognitive/StallClock.js — time an execution spent waiting, not working.
//
// The runtime ceiling is wall-clock: evaluateBudget compares now() against the
// row's created_at. That is the right measure for "this run is hanging", and the
// wrong one when the process is asleep in a provider backoff. A mission that hit
// Groq's daily allowance spent ~120s of a 180s budget inside 429 retry sleeps and
// was cut off at 203s having done well under 60s of actual work — the run failed
// for being rate-limited, but recorded as if it had run long.
//
// So: stall time is measured where it is incurred (inference.js) and subtracted
// where the budget is read (CognitiveCore). AsyncLocalStorage rather than a
// module-level counter because executions overlap — one cron tick runs a batch
// of missions while interactive chats are being served — and a shared total
// would let one mission's backoff pay for another's overrun.
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/** Run `fn` with its own stall ledger. Nested calls reuse the outer ledger. */
function runWithStallClock(fn) {
  if (storage.getStore()) return fn(); // already inside one — don't reset the count
  return storage.run({ stalledMs: 0 }, fn);
}

/** Record time spent asleep waiting on a provider. No-op outside a ledger. */
function recordStall(ms) {
  const store = storage.getStore();
  if (store && Number.isFinite(ms) && ms > 0) store.stalledMs += ms;
}

/** Total stall time for the current execution, 0 outside a ledger. */
function stalledMs() {
  const store = storage.getStore();
  return store ? store.stalledMs : 0;
}

module.exports = { runWithStallClock, recordStall, stalledMs };
