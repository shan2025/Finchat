// services/shareLinks.js — "anyone with the link" for boards (and any future
// artifact), the same contract mind maps use (migration 055):
//
//   • the token IS the permission: 256 random bits, nothing derived from ids
//   • stored as-is so the owner can copy the same link again; revoke to kill it
//   • live, not a snapshot; optional expiry; documents on/off per link
//   • every failure (unknown, revoked, expired) is the same 404 to a reader
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

const EXPIRY_DAYS = [1, 7, 30, 90];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param {{table:string, idCol:string, prefix:string, page:string}} spec
 *   table   the shares table (e.g. board_shares)
 *   idCol   the column naming what is shared (e.g. board_id)
 *   page    the public page the link opens (token goes in the fragment)
 */
function shareLinks({ table, idCol, prefix, page }) {
  const view = (row) => {
    const expired = row.expires_at && new Date(row.expires_at) <= new Date();
    return {
      shareId: row.share_id,
      // Fragment: never sent to a server, so it stays out of logs and Referers.
      path: `/${page}#${row.token}`,
      includeDocs: row.include_docs,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      active: !row.revoked_at && !expired,
      viewCount: row.view_count,
      lastViewedAt: row.last_viewed_at,
      createdAt: row.created_at
    };
  };

  return {
    EXPIRY_DAYS,
    view,

    async list(targetId) {
      const r = await query(`SELECT * FROM ${table} WHERE ${idCol} = $1 ORDER BY created_at DESC LIMIT 50`, [targetId]);
      return r.rows.map(view);
    },

    /** @throws {Error} with .status 400 on a bad expiry */
    async create(targetId, userId, { includeDocs = true, expiresInDays = null } = {}) {
      const days = expiresInDays == null ? null : Number(expiresInDays);
      if (days !== null && !EXPIRY_DAYS.includes(days)) {
        const e = new Error(`expiresInDays must be null or one of ${EXPIRY_DAYS.join(', ')}`);
        e.status = 400;
        throw e;
      }
      const r = await query(`
        INSERT INTO ${table} (share_id, token, ${idCol}, user_id, include_docs, expires_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
        RETURNING *
      `, [`${prefix}_${uuidv4()}`, crypto.randomBytes(32).toString('base64url'), targetId, userId,
          includeDocs !== false, days]);
      return view(r.rows[0]);
    },

    /** Revoke; null when that share is not on this target. */
    async revoke(targetId, shareId) {
      const r = await query(`
        UPDATE ${table} SET revoked_at = COALESCE(revoked_at, now())
         WHERE share_id = $1 AND ${idCol} = $2 RETURNING *
      `, [shareId, targetId]);
      return r.rows[0] ? view(r.rows[0]) : null;
    },

    /** A live share for this token, or null. Counts nothing — see `seen`. */
    async resolve(token) {
      if (!TOKEN.test(String(token || ''))) return null;
      const r = await query(`
        SELECT share_id, ${idCol} AS target_id, user_id, include_docs, expires_at
          FROM ${table}
         WHERE token = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      `, [token]);
      return r.rows[0] || null;
    },

    /** Record a view. Fire-and-forget: a counter must never fail a read. */
    seen(shareId) {
      query(`UPDATE ${table} SET view_count = view_count + 1, last_viewed_at = now() WHERE share_id = $1`, [shareId])
        .catch(() => {});
    }
  };
}

/** Headers every public share response carries. */
function publicHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
}

module.exports = { shareLinks, publicHeaders, EXPIRY_DAYS, TOKEN };
