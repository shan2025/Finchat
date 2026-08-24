// tools/ApplicationsTool.js — the job-application ledger.
//
// A daily job hunt is only useful if it remembers. Without a ledger every run
// re-surfaces the same three postings, and "how many have I applied to?" has no
// answer anywhere in the system. This is that memory: one row per opportunity,
// with the status the user (not the agent) moves through.
//
// The agent may write 'drafted' and 'shortlisted' on its own — those describe
// work IT did. 'applied', 'interviewing', 'rejected' and 'offer' describe what
// happened to the human, so they are only ever set from something the user
// said. Nothing here submits an application anywhere.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

const AGENT_WRITABLE = new Set(['drafted', 'shortlisted', 'skipped']);
const USER_STATES = new Set(['applied', 'interviewing', 'rejected', 'offer', 'withdrawn']);
const ALL_STATES = new Set([...AGENT_WRITABLE, ...USER_STATES]);

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
  }
  const m = s.match(/^(log|list|stats|update|delete)\b\s*(.*)$/i);
  if (m) return { action: m[1].toLowerCase(), application: m[2].trim() || undefined };
  return { action: 'stats' };
}

function view(r) {
  return {
    applicationId: r.application_id,
    role: r.role,
    company: r.company,
    location: r.location,
    url: r.url,
    source: r.source,
    status: r.status,
    matchScore: r.match_score,
    notes: r.notes,
    appliedAt: r.applied_at,
    loggedAt: r.created_at
  };
}

// Resolve "the Stripe PM one" to a row: id, exact URL, or a role/company match.
async function resolve(userId, ref) {
  const needle = String(ref || '').trim();
  if (!needle) return { error: 'Which application? Pass {"application":"<id, url, or \'role at company\'>"}.' };
  const res = await query(
    `SELECT * FROM job_applications
      WHERE user_id = $1
        AND (application_id = $2 OR url = $2
             OR lower(role || ' at ' || COALESCE(company, '')) LIKE '%' || lower($2) || '%'
             OR lower(COALESCE(company, '')) = lower($2))
      ORDER BY created_at DESC LIMIT 5`, [userId, needle]);
  if (res.rows.length === 1) return { row: res.rows[0] };
  if (res.rows.length > 1) {
    return {
      error: `"${needle}" matches ${res.rows.length} applications: ` +
        res.rows.map(r => `${r.role} at ${r.company || '?'} (${r.application_id})`).join('; ') +
        '. Use the applicationId or the posting URL.'
    };
  }
  return { error: `No logged application matching "${needle}".` };
}

async function execute(input, context = {}) {
  const opts = parseInput(input);
  const action = String(opts.action || 'stats').toLowerCase();
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('The application ledger requires a signed-in user.');
  }

  if (action === 'log') {
    const jobs = Array.isArray(opts.jobs) ? opts.jobs : [opts];
    const logged = [];
    const duplicates = [];
    for (const j of jobs.slice(0, 20)) {
      const role = String(j.role || j.title || '').trim();
      if (!role) continue;
      const status = ALL_STATES.has(String(j.status || '').toLowerCase())
        ? String(j.status).toLowerCase() : 'drafted';
      if (USER_STATES.has(status) && !opts.userConfirmed) {
        // The agent cannot decide that the human applied. Log the opportunity,
        // and let the user's own words move it forward later.
        return {
          action: 'log',
          error: `Status "${status}" records something the user did, not something you did. Log it as "drafted" or "shortlisted", and only move it to "${status}" with {"action":"update","status":"${status}","userConfirmed":true} after the user says they did it.`
        };
      }
      const url = j.url ? String(j.url).trim() : null;
      // Dedupe on the posting URL so a daily hunt re-surfacing yesterday's
      // listing updates that row instead of inflating the count.
      const res = await query(`
        INSERT INTO job_applications
          (application_id, user_id, role, company, location, url, source, status, match_score, notes, draft, mission_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (user_id, url) WHERE url IS NOT NULL
        DO UPDATE SET
          match_score = COALESCE(EXCLUDED.match_score, job_applications.match_score),
          notes       = COALESCE(EXCLUDED.notes, job_applications.notes),
          draft       = COALESCE(EXCLUDED.draft, job_applications.draft),
          updated_at  = now()
        RETURNING *, (xmax <> 0) AS was_existing
      `, [
        `app_${uuidv4()}`, userId, role, j.company || null, j.location || null, url,
        j.source || null, status, j.matchScore != null ? Math.round(Number(j.matchScore)) : null,
        j.notes || null, j.draft || null, j.missionId || context.missionId || null
      ]);
      const row = res.rows[0];
      (row.was_existing ? duplicates : logged).push(view(row));
    }
    if (!logged.length && !duplicates.length) {
      throw new Error('Nothing to log — each entry needs at least a "role". Example: {"action":"log","jobs":[{"role":"Product Manager","company":"Stripe","url":"https://…","source":"linkedin"}]}');
    }
    return {
      action: 'log',
      loggedCount: logged.length,
      duplicateCount: duplicates.length,
      logged,
      duplicates,
      note: duplicates.length
        ? `${duplicates.length} posting(s) were already in the ledger — refreshed rather than counted twice. Do not present those as new finds.`
        : undefined
    };
  }

  if (action === 'list') {
    const status = opts.status ? String(opts.status).toLowerCase() : null;
    const days = Math.min(Number(opts.days) || 90, 365);
    const limit = Math.min(Number(opts.limit) || 25, 100);
    const res = await query(`
      SELECT * FROM job_applications
       WHERE user_id = $1
         AND created_at > now() - ($2 || ' days')::interval
         AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC LIMIT $4
    `, [userId, String(days), status, limit]);
    return { action: 'list', count: res.rows.length, windowDays: days, applications: res.rows.map(view) };
  }

  if (action === 'stats') {
    const [byStatus, windows, companies] = await Promise.all([
      query('SELECT status, COUNT(*)::int AS n FROM job_applications WHERE user_id = $1 GROUP BY status', [userId]),
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS last7,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS last30,
          COUNT(*) FILTER (WHERE status = 'applied' OR applied_at IS NOT NULL)::int AS applied,
          COUNT(*) FILTER (WHERE status = 'drafted')::int AS awaiting_submission
        FROM job_applications WHERE user_id = $1`, [userId]),
      query(`SELECT company, COUNT(*)::int AS n FROM job_applications
              WHERE user_id = $1 AND company IS NOT NULL
              GROUP BY company ORDER BY n DESC LIMIT 5`, [userId])
    ]);
    const w = windows.rows[0] || {};
    return {
      action: 'stats',
      total: w.total || 0,
      applied: w.applied || 0,
      awaitingSubmission: w.awaiting_submission || 0,
      loggedLast7Days: w.last7 || 0,
      loggedLast30Days: w.last30 || 0,
      byStatus: Object.fromEntries(byStatus.rows.map(r => [r.status, r.n])),
      topCompanies: companies.rows,
      note: (w.total || 0) === 0
        ? 'The ledger is empty — nothing has been logged yet.'
        : 'Counts are of opportunities LOGGED by the agent. "applied" only counts the ones the user confirmed they submitted themselves.'
    };
  }

  if (action === 'update') {
    const { row, error } = await resolve(userId, opts.application || opts.url || opts.applicationId);
    if (error) return { action, error };
    const status = opts.status ? String(opts.status).toLowerCase() : null;
    if (status && !ALL_STATES.has(status)) {
      return { action, error: `Unknown status "${status}". Use: ${[...ALL_STATES].join(', ')}.` };
    }
    if (status && USER_STATES.has(status) && !opts.userConfirmed) {
      return {
        action,
        error: `"${status}" records a human action. Set it only when the user has told you it happened, and pass "userConfirmed": true to confirm they did.`
      };
    }
    const res = await query(`
      UPDATE job_applications
         SET status = COALESCE($1, status),
             notes  = COALESCE($2, notes),
             applied_at = CASE WHEN $1 = 'applied' AND applied_at IS NULL THEN now() ELSE applied_at END,
             updated_at = now()
       WHERE application_id = $3 AND user_id = $4
       RETURNING *`, [status, opts.notes || null, row.application_id, userId]);
    return { action, application: view(res.rows[0]), message: `Updated ${res.rows[0].role} at ${res.rows[0].company || '—'}.` };
  }

  if (action === 'delete') {
    const { row, error } = await resolve(userId, opts.application || opts.url || opts.applicationId);
    if (error) return { action, error };
    await query('DELETE FROM job_applications WHERE application_id = $1 AND user_id = $2', [row.application_id, userId]);
    return { action, deleted: true, role: row.role, company: row.company };
  }

  throw new Error(`Unknown applications action "${action}". Use log, list, stats, update or delete.`);
}

module.exports = { execute };
