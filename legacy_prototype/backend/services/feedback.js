// services/feedback.js — the user's thumbs on an agent's answer.
//
// This is the only quality signal the system has that is not about whether a
// run FINISHED. AgentLeaderboard turns it into helpfulness / usefulness, Plato's
// routing reads it through the profiles, and RouteOptimizer stops paving a route
// whose answers were rated down.
//
// Stored on the run itself, executions.metrics.feedback = { rating, at }, in the
// jsonb column CognitiveCore already merges into — no table and no migration.
// One rating per run: executions belong to exactly one user, and a run's answer
// is what is being judged, so "who rated" is always the owner.
//
// The chat message an answer was delivered as is linked the same way,
// metrics.messageId (see linkMessage), so a reopened conversation can show the
// rating it was given and re-rate the right run.

/** 'up' | 'down' | 1 | -1 → 1 | -1; null / 'none' / 0 → null (clear); anything else → undefined. */
function parseRating(v) {
  if (v === null || v === 0 || v === '0' || v === 'none' || v === 'clear') return null;
  if (v === 1 || v === '1' || v === 'up') return 1;
  if (v === -1 || v === '-1' || v === 'down') return -1;
  return undefined;
}

/**
 * Set (or clear) the rating on a run the user owns.
 * @returns {Promise<{ found: boolean, rating?: 1|-1|null }>}
 */
async function setRating({ query, executionId, userId, rating }) {
  const sql = rating === null
    ? `UPDATE executions SET metrics = COALESCE(metrics, '{}'::jsonb) - 'feedback'
        WHERE execution_id = $1 AND user_id = $2 RETURNING execution_id`
    : `UPDATE executions
          SET metrics = COALESCE(metrics, '{}'::jsonb)
                || jsonb_build_object('feedback', jsonb_build_object('rating', $3::int, 'at', now()))
        WHERE execution_id = $1 AND user_id = $2 RETURNING execution_id`;
  const params = rating === null ? [executionId, userId] : [executionId, userId, rating];
  const res = await query(sql, params);
  return res.rowCount ? { found: true, rating } : { found: false };
}

/** Remember which chat message delivered this run's answer. Best-effort. */
async function linkMessage({ query, executionId, userId, messageId }) {
  if (!executionId || !messageId) return;
  await query(
    `UPDATE executions SET metrics = COALESCE(metrics, '{}'::jsonb) || jsonb_build_object('messageId', $3::text)
      WHERE execution_id = $1 AND user_id = $2`,
    [executionId, userId, String(messageId)]);
}

/**
 * For a reopened conversation: which run delivered each message, and how the
 * user rated it. Returns Map<messageId, { executionId, rating }>.
 */
async function lookupByMessages({ query, userId, messageIds }) {
  const ids = (messageIds || []).filter(Boolean).map(String);
  if (!ids.length) return new Map();
  const res = await query(
    `SELECT execution_id, metrics->>'messageId' AS message_id, metrics->'feedback'->>'rating' AS rating
       FROM executions
      WHERE user_id = $1 AND metrics->>'messageId' = ANY($2::text[])`,
    [userId, ids]);
  return new Map(res.rows.map(r => [r.message_id, {
    executionId: r.execution_id,
    rating: r.rating === '1' ? 1 : r.rating === '-1' ? -1 : null
  }]));
}

module.exports = { parseRating, setRating, linkMessage, lookupByMessages };
