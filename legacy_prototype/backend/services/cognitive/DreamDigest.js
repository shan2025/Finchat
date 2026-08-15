// services/cognitive/DreamDigest.js — Sprint X · Stage 4
//
// The nightly digest that makes the memory feel alive: while the user is away,
// the graph consolidates (dream) and then tells the user what changed.
//
//   dream()  →  merge duplicates / fade stale links / surface gaps
//   gather   →  per-user learning over the window (what YOU taught it)
//   notify   →  "While you were away: merged 3, learned 12, found 2 gaps."
//
// The notification goes through createNotification, so it fans out to every
// channel the user enabled (in-app bell, email, Telegram, push). A dream_digest
// report snapshot is also written so the same run shows up in Reports.
//
// Best-effort throughout: a digest must never break the dream cycle or chat.

const { query } = require('../../database');
const { dreamAllUsers } = require('./MemoryEngine');
const { createNotification } = require('../notifications');

// ── Recipients: users who taught the graph something in the window ──────────
// The graph is largely shared, but node_events carry the user_id of the chat
// that produced them, so "you learned N" is genuinely personal.
async function activeUsers(windowHours) {
  const r = await query(`
    SELECT user_id,
           COUNT(*) FILTER (WHERE event_type = 'created')                       AS learned,
           COUNT(*) FILTER (WHERE event_type IN ('mentioned', 'created'))       AS touched,
           COUNT(*) FILTER (WHERE event_type = 'activated')                     AS recalled
    FROM node_events
    WHERE user_id IS NOT NULL
      AND created_at > now() - ($1 || ' hours')::interval
    GROUP BY user_id
  `, [String(windowHours)]);
  return r.rows.map(row => ({
    userId: row.user_id,
    learned: Number(row.learned) || 0,
    touched: Number(row.touched) || 0,
    recalled: Number(row.recalled) || 0
  }));
}

// New links formed across the graph in the window (system-level, not per user).
async function newLinkCount(windowHours) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM entity_edges WHERE created_at > now() - ($1 || ' hours')::interval`,
    [String(windowHours)]
  );
  return r.rows[0]?.n || 0;
}

// Compose the human-facing digest for one user. Mixes what they taught the
// system (personal) with what the overnight consolidation did (shared).
function composeMessage(user, consolidation, newLinks) {
  const learnedPhrase =
    user.learned > 0 ? `learned ${user.learned} new concept${user.learned === 1 ? '' : 's'}`
    : user.touched > 0 ? `reinforced ${user.touched} concept${user.touched === 1 ? '' : 's'}`
    : null;

  const parts = [];
  if (learnedPhrase) parts.push(learnedPhrase);
  if (user.recalled > 0) parts.push(`recalled ${user.recalled} while answering you`);
  if (newLinks > 0) parts.push(`formed ${newLinks} new link${newLinks === 1 ? '' : 's'}`);
  if (consolidation.merged > 0) parts.push(`merged ${consolidation.merged} duplicate${consolidation.merged === 1 ? '' : 's'}`);
  if (consolidation.gapsFound > 0) parts.push(`found ${consolidation.gapsFound} knowledge gap${consolidation.gapsFound === 1 ? '' : 's'}`);

  // Fold the tail into a natural sentence: "a, b, c and d".
  let body;
  if (parts.length === 0) {
    body = 'Your memory stayed steady — nothing new to consolidate.';
  } else if (parts.length === 1) {
    body = `While you were away, I ${parts[0]}.`;
  } else {
    body = `While you were away, I ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
  }

  const decayNote = consolidation.edgesDecayed > 0
    ? ` (${consolidation.edgesDecayed} stale connection${consolidation.edgesDecayed === 1 ? '' : 's'} faded, ${consolidation.edgesStrengthened} recent one${consolidation.edgesStrengthened === 1 ? '' : 's'} strengthened.)`
    : '';

  return { title: '🌙 While you were away', content: body + decayNote };
}

/**
 * Run one nightly digest cycle:
 *   1. consolidate the shared graph (dream)
 *   2. figure out who learned something in the window
 *   3. notify each of them (in-app + their external channels)
 *   4. write a dream_digest report snapshot for the Reports page
 *
 * @param {object}  opts
 * @param {boolean} [opts.notify=true]      - actually send notifications
 * @param {number}  [opts.windowHours=24]   - how far back "while you were away" reaches
 * @returns {Promise<{consolidation, newLinks, recipients, notified, digests}>}
 */
async function runNightlyDigest({ notify = true, windowHours = 24 } = {}) {
  // 1. Consolidate every user's graph. dreamAllUsers() does the graph-wide
  //    sweep once and writes a per-user dream_report insight for each owner.
  const { consolidation: sweep, reports } = await dreamAllUsers();

  // Merging, decay and strengthening are graph-wide, so every digest quotes the
  // same figures. Gaps are not — they come out of one user's own graph, so each
  // digest quotes that user's own count rather than a system-wide total.
  const shared = {
    merged: sweep.merged.length,
    edgesDecayed: sweep.edgesDecayed,
    edgesStrengthened: sweep.edgesStrengthened
  };
  const reportByUser = new Map(reports.map(r => [r.userId, r]));

  // 2 + 3. Per-user digests.
  const [users, newLinks] = await Promise.all([activeUsers(windowHours), newLinkCount(windowHours)]);
  const digests = [];
  let notified = 0;

  for (const user of users) {
    // Only ping a user who has some personal signal — don't nag idle accounts
    // with a pure system-maintenance report.
    if (user.learned === 0 && user.touched === 0 && user.recalled === 0) continue;

    const consolidation = {
      ...shared,
      gapsFound: reportByUser.get(user.userId)?.gapsFound || 0
    };
    const { title, content } = composeMessage(user, consolidation, newLinks);
    digests.push({ userId: user.userId, title, content, ...user });

    if (notify) {
      const row = await createNotification({
        userId: user.userId,
        type: 'dream_digest',
        title,
        content,
        link: 'finchat_reports.html'
      });
      if (row) notified++;
    }
  }

  // 4. A shareable narrative snapshot for the Reports page (global, best-effort).
  try {
    const { generate } = require('./ReportEngine');
    await generate({ kind: 'dream_digest', userId: null, days: 1 });
  } catch (err) {
    console.warn(`⚠️ DreamDigest report snapshot failed: ${err.message}`);
  }

  const gapsFound = reports.reduce((n, r) => n + (r.gapsFound || 0), 0);

  console.log(`🌙 Dream digest: consolidated (merged ${shared.merged}, faded ${shared.edgesDecayed}, gaps ${gapsFound} across ${reports.length} graph(s)); notified ${notified}/${users.length} active user(s).`);
  return {
    consolidation: { ...shared, gapsFound },
    newLinks,
    recipients: users.length,
    notified,
    digests
  };
}

module.exports = { runNightlyDigest, composeMessage };
