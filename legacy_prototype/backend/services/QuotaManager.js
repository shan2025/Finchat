// services/QuotaManager.js — which credential serves a call, and what is left in each pool.
//
// This sits between the execution policy and the provider router:
//
//   Agent → Workload → Execution Policy → QuotaManager → Provider Router → Model
//
// It exists to own two things inference.js was doing badly or not at all.
//
// 1. CREDENTIALS AS POOLS, not one env var per provider.
//    inference.js had a single `apiKey` per provider plus a hard-coded special
//    case — `(cfg.name === 'groq' && byokKey)` — which is the entire BYOK
//    implementation and works for exactly one provider. Making a provider's
//    credentials a resolved, ordered POOL means per-agent keys and user-supplied
//    keys are the same mechanism rather than three special cases, and it is what
//    lets BYOK arrive later without unpicking the router.
//
//    Deliberately NOT built as "one free API key per agent multiplies our free
//    quota". That bakes a provider-terms question into the architecture. Agent
//    keys are one way to fill a pool, not what the pool is made of.
//
// 2. A STICKY MEMORY OF EXHAUSTED ALLOWANCES.
//    inference.js already distinguishes ordinary per-minute throttling (429 with
//    a short retry-after, worth waiting out) from a spent daily allowance (429
//    with retry-after measured in hours, where waiting is useless). It computed
//    that verdict, used it in a log line, and then threw it away — so the NEXT
//    call that day re-tried the same exhausted model and paid another doomed
//    round-trip, and so did the one after that. Groq's allowance is per model
//    per day, so on a spent day that is every request until UTC midnight.
//
// Markers live in process memory, like the _deadModels blacklist in
// inference.js and for the same reason: a restart re-probes, so an allowance
// that resets early is picked up without a deploy. The honest caveat is that
// the free Render instance spins down on inactivity, so markers are lost often
// — the cost of that is one wasted round-trip after a cold start, against a
// database read on every inference call. If that trade ever stops being right,
// `_spent` is the only thing that needs a store behind it.

// NOTE: `database` is required lazily inside usageToday(), never at module
// load. inference.js does the same and says why: requiring it here opens a
// Postgres pool as a side effect of importing this file, which gives every
// consumer — including tests that make no database call at all — a live
// connection they never asked for and an open handle that keeps the process
// alive. Credential resolution and the spent markers touch no database, so
// nothing on the inference path should pay for one.

/** A key that is absent, blank, or still the placeholder is not a key. */
function _usableKey(key) {
  return !!key && !key.startsWith('YOUR_') && key !== 'changeme';
}

/**
 * Identify a credential without ever putting the secret in a map key, a log
 * line or an error message. Source plus last four is enough to tell two
 * credentials apart and useless to anyone who reads it.
 */
function _credentialId(source, key) {
  return `${source}:${String(key).slice(-4)}`;
}

// ── Credential pools ─────────────────────────────────────────────
//
// Env naming, in resolution order:
//   <PROVIDER>_API_KEY_<AGENT>   e.g. GROQ_API_KEY_AURELIUS  (agent pool)
//   <PROVIDER>_API_KEY           e.g. GROQ_API_KEY           (system pool)
//
// A user's own key is passed in rather than read from env — it comes from
// storage per request, and the QuotaManager should not know how it was fetched.

/**
 * The credentials that may serve this call, best first.
 *
 * Order is user → agent → system, so a user who brought their own key never
 * touches the shared pool, and an agent with a dedicated key never spends the
 * allowance interactive chat depends on. Falling through to `system` is what
 * keeps a user with no key of their own working.
 *
 * Returns [] when nothing usable is configured, which the router reads as
 * "skip this provider" — the same meaning the old `_usableKey` guard had.
 *
 * `allowSystem` is the BYOK gate. It defaults to true so every existing caller
 * (and every background/system call) is unchanged, but a user who has spent
 * their shared-pool allowance is resolved with `allowSystem: false`, which drops
 * the shared `system` credential from the pool. Their own `user` key still
 * serves them; with no key of their own the pool goes empty and the provider is
 * skipped — which is how "connect your own key to continue" is enforced without
 * the router needing to know what a tier is.
 *
 * @returns {Array<{id: string, key: string, source: 'user'|'agent'|'system'}>}
 */
function resolveCredentials(provider, { agentId = null, userKey = null, allowSystem = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = (source, key) => {
    if (!_usableKey(key)) return;
    const id = _credentialId(source, key);
    // The same key configured in two slots is one credential, not two chances.
    // Without this, an agent slot holding a copy of the system key would make a
    // spent allowance look like it had a spare.
    const dedupe = String(key);
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ id, key, source });
  };

  const ENV = provider.toUpperCase();
  add('user', userKey);
  if (agentId) add('agent', process.env[`${ENV}_API_KEY_${agentId.toUpperCase()}`]);
  if (allowSystem) add('system', process.env[`${ENV}_API_KEY`]);
  return out;
}

// ── Exhausted-allowance markers ──────────────────────────────────

/** key → epoch ms at which the marker lifts. */
const _spent = new Map();

const _key = (provider, model, credentialId) => `${provider}:${model}:${credentialId}`;

/**
 * When a spent DAILY allowance frees up.
 *
 * Groq's free tier resets at UTC midnight, which is the case this is for, so a
 * retry-after in hours is capped at "the start of the next UTC day" rather than
 * trusted literally — a provider reporting 86,400s at 23:50 would otherwise
 * park a working model for a whole extra day.
 */
function _expiryFor(retryAfterSec, now) {
  const utcMidnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1
  );
  const fromHeader = now + (Number(retryAfterSec) || 0) * 1000;
  return Math.min(fromHeader || utcMidnight, utcMidnight);
}

/**
 * Remember that this credential's allowance for this model is gone until the
 * provider says it is back. Called on a 429 whose retry-after is measured in
 * hours rather than seconds — see inference.js for that distinction.
 */
function markSpent(provider, model, credentialId, { retryAfterSec = 0, now = Date.now() } = {}) {
  const until = _expiryFor(retryAfterSec, now);
  _spent.set(_key(provider, model, credentialId), until);
  console.warn(`🚫 ${provider} "${model}" [${credentialId}] daily allowance spent — ` +
    `not retrying until ${new Date(until).toISOString()}`);
  return until;
}

/**
 * Is this credential's allowance for this model still spent?
 *
 * Self-cleaning: an expired marker is deleted on read rather than swept, which
 * keeps the map the size of what is actually exhausted right now.
 */
function isSpent(provider, model, credentialId, now = Date.now()) {
  const k = _key(provider, model, credentialId);
  const until = _spent.get(k);
  if (until == null) return false;
  if (now >= until) { _spent.delete(k); return false; }
  return true;
}

/** Currently-exhausted (provider, model, credential) triples, for diagnostics. */
function listSpent(now = Date.now()) {
  const out = [];
  for (const [k, until] of _spent) {
    if (now >= until) { _spent.delete(k); continue; }
    const [provider, model, ...rest] = k.split(':');
    out.push({ provider, model, credentialId: rest.join(':'), until: new Date(until).toISOString() });
  }
  return out;
}

/** Test seam — markers are process state, and a test must be able to start clean. */
function _reset() { _spent.clear(); }

// ── Accounting ───────────────────────────────────────────────────

/**
 * What each provider has spent today, from the metrics already being recorded.
 *
 * Reporting only — deliberately NOT on the inference path. Knowing a pool's
 * remaining allowance would need a database read before every call, which is
 * the kind of cost that gets added to fix a problem and then never removed.
 * The router learns a pool is exhausted the way it always has: the provider
 * tells it, and markSpent above makes sure it only has to be told once.
 *
 * `cached` matters here because cached prompt tokens bill at a fraction, so a
 * raw token total overstates what a pool has actually consumed.
 */
async function usageToday({ since = null } = {}) {
  const { query } = require('../database');
  const res = await query(`
    SELECT provider,
           count(*)                       AS calls,
           sum(prompt_tokens)             AS prompt_tokens,
           sum(cached_tokens)             AS cached_tokens,
           sum(completion_tokens)         AS completion_tokens
      FROM inference_metrics
     WHERE created_at >= COALESCE($1, date_trunc('day', now() AT TIME ZONE 'UTC'))
     GROUP BY provider
     ORDER BY 2 DESC
  `, [since]);
  return res.rows;
}

module.exports = {
  resolveCredentials,
  markSpent,
  isSpent,
  listSpent,
  usageToday,
  _reset,
  _credentialId
};
