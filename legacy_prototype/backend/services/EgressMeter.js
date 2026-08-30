// EgressMeter — measures how many bytes each SQL statement pulls out of Supabase.
//
// Why this exists: the quota that nearly took the system down on 01 Sep 2026 is
// Supabase EGRESS, and egress is bytes travelling from Postgres to this Node
// process. That is a number nobody could see. The dashboard reports one monthly
// total (12.892 GB against a 5 GB cap), pg_stat_user_tables reports rows read
// rather than bytes shipped, and pg_stat_statements is not available on this
// project. So the top offenders were being inferred from row counts, which is a
// guess: a 40-byte row and a 40KB TOASTed `content` row count the same there.
//
// Every query in the app already funnels through database.js `query()`, so one
// hook at that chokepoint turns the guess into a measurement.
//
// The size is estimated, not exact. It is the JSON byte length of the returned
// rows, which ignores the binary wire protocol's framing and any compression on
// the connection. It is consistently wrong in the same direction, which is all
// that is needed: the job is ranking callers against each other, not
// reconciling to Supabase's invoice to the byte.
//
// Accounting is in-process and resets on restart. That is deliberate — writing
// the meter to Postgres would make the instrument a source of the thing it
// measures.

const MAX_FINGERPRINTS = 400;

const stats = new Map(); // fingerprint -> { calls, bytes, rows, maxBytes, sample }
let totalBytes = 0;
let totalCalls = 0;
let startedAt = Date.now();

/**
 * Collapse a statement into a stable key: whitespace flattened, parameter
 * placeholders and literals normalised, so the same query with different
 * arguments accumulates into one row instead of a thousand.
 */
function fingerprint(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\$\d+/g, '$?')
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+\b/g, 'N')
    .trim()
    .slice(0, 180);
}

/**
 * Byte size of a result set, estimated via its JSON encoding.
 * Returns 0 rather than throwing on anything non-serialisable (a circular
 * value, a bigint) — a metering failure must never fail the query it measures.
 */
function estimateBytes(rows) {
  if (!rows || rows.length === 0) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(rows), 'utf8');
  } catch {
    return 0;
  }
}

function record(text, rows) {
  const bytes = estimateBytes(rows);
  totalBytes += bytes;
  totalCalls += 1;

  const key = fingerprint(text);
  let entry = stats.get(key);
  if (!entry) {
    // Bounded so a pathological query builder that never repeats a statement
    // cannot grow this map without limit. Once full, we keep counting the
    // totals and stop tracking new shapes — the heavy hitters are already in.
    if (stats.size >= MAX_FINGERPRINTS) return bytes;
    entry = { calls: 0, bytes: 0, rows: 0, maxBytes: 0, sample: key };
    stats.set(key, entry);
  }
  entry.calls += 1;
  entry.bytes += bytes;
  entry.rows += rows.length;
  if (bytes > entry.maxBytes) entry.maxBytes = bytes;
  return bytes;
}

/** Top statements by total bytes pulled, heaviest first. */
function report(limit = 25) {
  const elapsedHours = (Date.now() - startedAt) / 3_600_000;
  const top = [...stats.entries()]
    .map(([key, e]) => ({
      query: key,
      calls: e.calls,
      rows: e.rows,
      totalBytes: e.bytes,
      avgBytes: Math.round(e.bytes / e.calls),
      maxBytes: e.maxBytes,
      shareOfTotal: totalBytes ? +(e.bytes / totalBytes * 100).toFixed(1) : 0
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, limit);

  return {
    since: new Date(startedAt).toISOString(),
    elapsedHours: +elapsedHours.toFixed(2),
    totalCalls,
    totalBytes,
    totalMB: +(totalBytes / 1_048_576).toFixed(2),
    // The number that matters against a 5GB/month cap: at this rate, what does
    // a 30-day month cost? Meaningless in the first minutes after a restart,
    // so it is null until there is an hour of evidence behind it.
    projectedMonthlyGB: elapsedHours >= 1
      ? +((totalBytes / elapsedHours) * 24 * 30 / 1_073_741_824).toFixed(2)
      : null,
    top
  };
}

function reset() {
  stats.clear();
  totalBytes = 0;
  totalCalls = 0;
  startedAt = Date.now();
}

module.exports = { record, report, reset, fingerprint };
