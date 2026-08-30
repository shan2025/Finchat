// QueryCache — a small in-process TTL cache for read-only endpoints that get polled.
//
// The Supabase quota being defended is egress: bytes from Postgres to this
// process. That rules out the obvious fix. HTTP caching — ETags, 304s,
// Cache-Control — saves bytes on the browser-to-Render hop, which is not
// metered and was never the problem; the backend still runs the query and still
// pays for the rows either way. The only thing that reduces egress is a request
// that never reaches Postgres at all.
//
// So the cache sits in front of the query, not behind the response.
//
// It is deliberately in-memory rather than Redis: this project deleted its
// queue infrastructure in 2026-08 precisely to stop paying for a second
// datastore, and a cache that costs an extra network hop to consult would
// reintroduce the latency it exists to remove. On Render's single free instance
// there is exactly one process, so a process-local map is also a global one.
//
// Consequences worth stating plainly:
//   • A restart empties it. Fine — it refills within one poll interval.
//   • Reads can be up to `ttlMs` stale. Every caller below is a dashboard
//     widget or a graph view already on a 30–300s poll, so the data was that
//     stale in the reader's eyes regardless.
//   • It must never wrap a write, or anything a write must be immediately
//     visible in. Chat messages, mission approvals and notification
//     acknowledgements are all excluded for this reason.

const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

const cache = new Map(); // key -> { value, expiresAt }
const inflight = new Map(); // key -> Promise

let hits = 0;
let misses = 0;
let coalesced = 0;

function evictIfFull() {
  if (cache.size < MAX_ENTRIES) return;
  // Cheapest useful policy: drop everything already expired; if that frees
  // nothing, drop the oldest insertion. Map preserves insertion order.
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Run `producer` at most once per `ttlMs` per `key`.
 *
 * Concurrent callers that miss together share one execution rather than each
 * firing their own query — without that, N browser tabs opening at once still
 * cost N round trips, which is the exact shape of the bill being reduced.
 *
 * @param {string} key      Must include the user id. A cache key that omits it
 *                          is a cross-account data leak, not a performance bug.
 * @param {number} ttlMs
 * @param {() => Promise<any>} producer
 */
async function through(key, ttlMs, producer) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    hits += 1;
    return entry.value;
  }

  const pending = inflight.get(key);
  if (pending) {
    coalesced += 1;
    return pending;
  }

  misses += 1;
  const promise = (async () => {
    const value = await producer();
    evictIfFull();
    cache.set(key, { value, expiresAt: Date.now() + (ttlMs || DEFAULT_TTL_MS) });
    return value;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    // A failed producer must not be cached, and must not leave the key wedged
    // so that every later caller inherits the same rejection.
    inflight.delete(key);
  }
}

/**
 * Drop cached entries whose key starts with `prefix`. Call this from the write
 * path that invalidates them, so a user action shows its own effect at once
 * instead of after the TTL.
 */
function invalidate(prefix) {
  let n = 0;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) { cache.delete(k); n += 1; }
  }
  return n;
}

function stats() {
  const total = hits + misses + coalesced;
  return {
    entries: cache.size,
    hits,
    misses,
    coalesced,
    // The headline: the share of reads that cost Supabase nothing.
    hitRate: total ? +(((hits + coalesced) / total) * 100).toFixed(1) : 0
  };
}

module.exports = { through, invalidate, stats, DEFAULT_TTL_MS };
