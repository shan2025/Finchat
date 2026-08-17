// routes/cron.js — trigger endpoints for an EXTERNAL scheduler.
//
// Why this exists: an in-process scheduler only fires while the process is
// alive. On a host that sleeps when idle (Render's free tier spins down after
// ~15 minutes of no requests) that means scheduled work silently stops, so
// missions and briefings only ran while somebody happened to be using the app.
//
// Moving the *schedule* outside the app fixes that: an external cron service
// calls these endpoints, and the request itself wakes the container. A cold
// start costs ~50s, which is irrelevant for background work.
//
// These endpoints are now the ONLY thing that starts scheduled work. The app
// once mirrored the same schedules into BullMQ repeatable jobs; that was pure
// duplication of what is already in agent_missions.next_run_at, and it made a
// Redis outage fatal to the whole server. Both are gone.
//
// Auth is a shared secret in CRON_SECRET, sent either as
//   Authorization: Bearer <secret>        (preferred)
//   X-Cron-Secret: <secret>
//   ?key=<secret>                         (only if the caller cannot set headers)
// The query form puts the secret in URLs and server logs — prefer a header.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../database');

const router = express.Router();

// A claimed mission is pushed this far into the future before it runs. If the
// process dies mid-run the claim simply expires and the next tick retries it.
const LEASE_MINUTES = 15;
// Cap per tick so one call cannot fan out into unbounded concurrent LLM work.
const MAX_PER_TICK = 5;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Gate every route below on the shared secret.
router.use((req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: an unset secret must not mean "open to everyone".
    return res.status(503).json({
      error: 'CRON_SECRET is not configured on this server; cron endpoints are disabled.'
    });
  }

  const auth = req.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  const supplied = bearer || req.get('x-cron-secret') || req.query.key;

  if (!supplied || !timingSafeEqual(supplied, secret)) {
    console.warn(`🔒 [Cron] Rejected ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid or missing cron secret.' });
  }
  next();
});

/**
 * Run every mission whose next_run_at has passed.
 *
 * Claiming and running are deliberately separate. The UPDATE ... RETURNING below
 * is atomic, so two overlapping ticks cannot pick up the same mission: whichever
 * commits first moves next_run_at out of range for the other.
 *
 * Responds as soon as the claim is made rather than waiting for the runs. A
 * mission may take minutes (it is a full agent execution with a 180s budget),
 * which is far longer than a cron caller should hold a connection open. The
 * container stays up for ~15 minutes after a request, so the work still lands.
 * Pass ?wait=1 to await results instead — useful for testing by hand.
 */
router.all('/tick', async (req, res) => {
  const wait = req.query.wait === '1' || req.query.wait === 'true';

  let claimed;
  try {
    const result = await query(`
      UPDATE agent_missions
      SET next_run_at = now() + ($1 || ' minutes')::interval, updated_at = now()
      WHERE mission_id IN (
        SELECT mission_id FROM agent_missions
        WHERE enabled = true AND (next_run_at IS NULL OR next_run_at <= now())
        ORDER BY next_run_at ASC NULLS FIRST
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING mission_id, title
    `, [String(LEASE_MINUTES), MAX_PER_TICK]);
    claimed = result.rows;
  } catch (err) {
    console.error('❌ [Cron] Could not claim due missions:', err.message);
    return res.status(503).json({ ok: false, error: err.message });
  }

  if (claimed.length === 0) {
    return res.json({ ok: true, claimed: 0, missions: [], note: 'Nothing due.' });
  }

  console.log(`⏰ [Cron] Claimed ${claimed.length} due mission(s): ${claimed.map(m => m.title).join(', ')}`);
  const { runMission } = require('../services/agents/MissionScheduler');

  const runAll = async () => {
    const results = [];
    for (const m of claimed) {
      try {
        const r = await runMission(m.mission_id);
        results.push({ missionId: m.mission_id, title: m.title, ok: !!r.success, ...r });
      } catch (err) {
        // runMission already records failures on the row; never let one bad
        // mission abort the rest of the batch.
        console.error(`❌ [Cron] Mission "${m.title}" threw: ${err.message}`);
        results.push({ missionId: m.mission_id, title: m.title, ok: false, error: err.message });
      }
    }
    return results;
  };

  if (wait) {
    const results = await runAll();
    return res.json({ ok: true, claimed: claimed.length, waited: true, results });
  }

  // Fire and forget — the response goes out now, the runs continue behind it.
  runAll().catch(err => console.error('❌ [Cron] Mission batch failed:', err.message));
  res.status(202).json({
    ok: true,
    claimed: claimed.length,
    started: claimed.map(m => ({ missionId: m.mission_id, title: m.title })),
    note: 'Runs started in the background; poll /api/missions for results.'
  });
});

/**
 * Trigger the morning executive briefing for one user.
 *
 * Briefings are not stored with a next_run_at the way missions are, so the
 * external cron's schedule is what decides the hour. Point a daily trigger at
 * this endpoint at whatever time you want the brief.
 *
 * It is NOT, however, the only thing standing between the user and a hundred
 * briefings a day: runMorningBriefing enforces its own minimum interval, so a
 * trigger accidentally left on a 15-minute schedule answers `skipped: true`
 * instead of starting another full agent run. See BRIEFING_MIN_INTERVAL_HOURS.
 *
 * Like /tick, this answers as soon as the run starts. A briefing is a full
 * agent execution with a 240s budget, far longer than a cron caller should be
 * held. Pass ?wait=1 to await the result instead.
 */
router.all('/briefing', async (req, res) => {
  const userId = req.query.userId || req.body?.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required (?userId=<uuid>).' });
  }

  const wait = req.query.wait === '1' || req.query.wait === 'true';
  const { runMorningBriefing } = require('../services/briefing');

  if (wait) {
    try {
      const result = await runMorningBriefing({ userId, requestedAt: new Date().toISOString() });
      if (result.skipped) {
        return res.json({ ok: true, userId, waited: true, skipped: true, reason: result.reason });
      }
      return res.json({ ok: true, userId, waited: true, sessionId: result.sessionId, durationMs: result.durationMs });
    } catch (err) {
      console.error('❌ [Cron] Briefing failed:', err.message);
      return res.status(503).json({ ok: false, error: err.message });
    }
  }

  // Fire and forget — nothing retries behind this now that the queue is gone,
  // so the failure has to be logged here or it is lost entirely.
  runMorningBriefing({ userId, requestedAt: new Date().toISOString() })
    .catch(err => console.error(`❌ [Cron] Briefing for ${userId} failed: ${err.message}`));

  console.log(`⏰ [Cron] Started morning briefing for ${userId}`);
  res.status(202).json({ ok: true, userId, note: 'Briefing started in the background.' });
});

/** Cheap authenticated no-op, so you can verify the secret without side effects. */
router.all('/ping', (req, res) => {
  res.json({ ok: true, service: 'FinChat cron', time: new Date().toISOString() });
});

module.exports = router;
