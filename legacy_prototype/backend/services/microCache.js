// services/microCache.js — process-memory TTL cache for hot, rarely-changing reads.
//
// The app server runs in Oregon and the database is in Tokyo, so every query
// costs ~108ms of transpacific round trip regardless of how trivial it is.
// A few reads are issued on nearly every request but change almost never —
// the channel list is looked up on every single chat message, for instance.
// Serving those from process memory removes the round trip entirely.
//
// Why not Redis: Upstash is also a network hop, and the free tier's request
// budget is already strained (BullMQ's blocking poll burns it). Process memory
// costs nothing and is strictly faster. The trade is that each instance keeps
// its own copy — fine for values that are effectively static, wrong for
// anything a user expects to see change immediately. Keep TTLs short and call
// invalidate() on write.
//
// Mirrors the cache already in middleware/auth.js; that one stays where it is
// because it is keyed per user and cleared from several call sites.

const _entries = new Map();
const MAX_ENTRIES = 500;

/**
 * Read through the cache. `loader` is only called on a miss, and concurrent
 * misses for the same key share one in-flight promise so a cold cache under
 * load does not stampede the database.
 *
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<any>} loader
 */
async function cached(key, ttlMs, loader) {
  const hit = _entries.get(key);
  if (hit) {
    if (hit.pending) return hit.pending;
    if (Date.now() - hit.timestamp < ttlMs) return hit.value;
    _entries.delete(key);
  }

  const pending = (async () => {
    const value = await loader();
    // Only publish a real value once it resolves; a rejection must not be
    // cached as if it were data.
    _entries.set(key, { value, timestamp: Date.now() });
    return value;
  })();

  _entries.set(key, { pending });

  try {
    return await pending;
  } catch (err) {
    _entries.delete(key);
    throw err;
  }
}

function invalidate(key = null) {
  if (key === null) _entries.clear();
  else _entries.delete(key);
}

function stats() {
  return { size: _entries.size };
}

// Bound growth. These keys are a small fixed set today, but an accidental
// per-user key would otherwise leak memory for the process lifetime.
function _evictIfLarge() {
  if (_entries.size > MAX_ENTRIES) {
    const oldest = _entries.keys().next().value;
    _entries.delete(oldest);
  }
}

module.exports = {
  cached: async (key, ttlMs, loader) => {
    const v = await cached(key, ttlMs, loader);
    _evictIfLarge();
    return v;
  },
  invalidate,
  stats
};
