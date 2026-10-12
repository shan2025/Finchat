// services/boardRevert.js — undo a change from History, or everything one
// guest did (migration 065).
//
// Every change records an `undo` (services/boards.js → record). The shapes:
//
//   card_fields     {cardId, before:{col:val}, after:{col:val}}   edits, moves via "Who", done / put back
//   card_added      {cardId}
//   positions       {before:{cardId:{column_id,order_index}}, after:{…}}   a drag
//   column_added    {columnId}
//   column_fields   {columnId, before:{title,color}, after:{…}}
//   column_order    {before:{columnId:index}, after:{…}}
//   board_fields    {before:{title|description}, after:{…}}
//   attachment_added {attachmentId}
//   trash           (rows in board_trash under the same activity_id)
//
// The rule that makes undo safe on a shared board: put the "before" back ONLY
// where the board still shows this change's "after". If someone has changed
// that field, moved that card or added to that lane since, their work stays
// and the skip is reported in plain words. Undoing never destroys a later edit.
//
// Only signed-in people with access (the owner and editors) may undo; guests
// cannot, so a forwarded link cannot be used to wipe out the owner's work.
const { query } = require('../database');
const Boards = require('./boards');

const { BoardError, cardValue, actorOf, guestLabel } = Boards;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const q = (s) => `“${String(s || '').slice(0, 60)}”`;

async function requireUndoer(boardId, userId) {
  if (actorOf(userId).guestId) throw new BoardError(403, 'Only the owner and editors can undo changes');
  return Boards.requireBoard(boardId, userId);
}

/** One activity with who made it, or a 404. */
async function loadActivity(boardId, activityId) {
  const r = await query(`
    SELECT a.*, u.name AS user_name, g.number AS guest_number, g.name AS guest_name
      FROM board_activity a
      LEFT JOIN users u ON u.user_id = a.user_id
      LEFT JOIN board_guests g ON g.guest_id = a.guest_id
     WHERE a.activity_id = $1 AND a.board_id = $2`, [activityId, boardId]);
  if (!r.rows[0]) throw new BoardError(404, 'Change not found');
  return r.rows[0];
}

const whoMade = (a) => (a.guest_id ? guestLabel(a.guest_number, a.guest_name) : (a.user_name || 'Someone'));

/** Has anyone other than this change's author touched this card since it was made (and not been undone)? */
async function touchedSinceByOthers(act, cardId) {
  const r = await query(`
    SELECT 1 FROM board_activity
     WHERE board_id = $1 AND created_at > $2 AND reverted_at IS NULL AND action <> 'revert'
       AND (user_id IS DISTINCT FROM $3 OR guest_id IS DISTINCT FROM $4)
       AND (details->>'cardId' = $5 OR details->'cards' @> jsonb_build_array(jsonb_build_object('cardId', $5::text)))
     LIMIT 1`, [act.board_id, act.created_at, act.user_id, act.guest_id, cardId]);
  return r.rowCount > 0;
}

// ── one change ────────────────────────────────────────────────

const APPLY = {
  async card_fields(act, u, skipped) {
    const cur = (await query('SELECT * FROM board_cards WHERE card_id = $1 AND board_id = $2', [u.cardId, act.board_id])).rows[0];
    if (!cur) { skipped.push(`${q(act.details.title || 'that card')} has been deleted since`); return; }
    const sets = {};
    for (const [field, after] of Object.entries(u.after || {})) {
      if (same(cardValue(field, cur[field]), after)) sets[field] = u.before[field];
      else skipped.push(`${q(cur.title)}: ${FIELD_WORDS[field] || field} was changed again since — kept`);
    }
    if (sets.column_id) {
      const ok = await query('SELECT 1 FROM board_columns WHERE column_id = $1 AND board_id = $2', [sets.column_id, act.board_id]);
      if (!ok.rowCount) { delete sets.column_id; skipped.push(`${q(cur.title)}: its old lane is gone — left where it is`); }
    }
    const keys = Object.keys(sets);
    if (!keys.length) return;
    await query(`UPDATE board_cards SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
                  WHERE card_id = $1 AND board_id = $2`,
      [u.cardId, act.board_id, ...keys.map(k => (k === 'tags' ? JSON.stringify(sets[k] || []) : sets[k]))]);
  },

  async card_added(act, u, skipped) {
    const cur = (await query('SELECT title FROM board_cards WHERE card_id = $1 AND board_id = $2', [u.cardId, act.board_id])).rows[0];
    if (!cur) return;   // already gone: nothing to undo
    if (await touchedSinceByOthers(act, u.cardId)) {
      skipped.push(`${q(cur.title)} was changed by someone else after it was added — kept`);
      return;
    }
    await query('DELETE FROM board_cards WHERE card_id = $1 AND board_id = $2', [u.cardId, act.board_id]);
  },

  async positions(act, u, skipped) {
    const ids = Object.keys(u.after || {});
    const cur = await query('SELECT card_id, column_id, order_index, title FROM board_cards WHERE board_id = $1 AND card_id = ANY($2::text[])',
      [act.board_id, ids]);
    const cols = new Set((await query('SELECT column_id FROM board_columns WHERE board_id = $1', [act.board_id])).rows.map(c => c.column_id));
    const back = [];
    for (const k of cur.rows) {
      const a = u.after[k.card_id], b = u.before[k.card_id];
      if (k.column_id !== a.column_id || Number(k.order_index) !== a.order_index) {
        skipped.push(`${q(k.title)} was moved again since — left where it is`);
      } else if (!cols.has(b.column_id)) {
        skipped.push(`${q(k.title)}: its old lane is gone — left where it is`);
      } else back.push([k.card_id, b.column_id, b.order_index]);
    }
    if (!back.length) return;
    await query(`
      UPDATE board_cards k SET column_id = t.col, order_index = t.i, updated_at = now()
        FROM unnest($2::text[], $3::text[], $4::int[]) AS t(id, col, i)
       WHERE k.card_id = t.id AND k.board_id = $1`,
      [act.board_id, back.map(x => x[0]), back.map(x => x[1]), back.map(x => x[2])]);
  },

  async column_added(act, u, skipped) {
    const r = await query(`SELECT title, (SELECT COUNT(*) FROM board_cards WHERE column_id = $1)::int AS cards
                             FROM board_columns WHERE column_id = $1 AND board_id = $2`, [u.columnId, act.board_id]);
    const col = r.rows[0];
    if (!col) return;
    if (col.cards) { skipped.push(`${q(col.title)} still has ${col.cards} card${col.cards === 1 ? '' : 's'} — kept`); return; }
    await query('DELETE FROM board_columns WHERE column_id = $1 AND board_id = $2', [u.columnId, act.board_id]);
  },

  async column_fields(act, u, skipped) {
    const cur = (await query('SELECT title, color FROM board_columns WHERE column_id = $1 AND board_id = $2', [u.columnId, act.board_id])).rows[0];
    if (!cur) { skipped.push('that column has been deleted since'); return; }
    const sets = {};
    for (const [field, after] of Object.entries(u.after || {})) {
      if (same(cur[field], after)) sets[field] = u.before[field];
      else if (!same(u.before[field], after)) skipped.push(`${q(cur.title)}: ${field === 'title' ? 'name' : 'colour'} was changed again since — kept`);
    }
    if (!Object.keys(sets).length) return;
    await query('UPDATE board_columns SET title = COALESCE($3, title), color = COALESCE($4, color) WHERE column_id = $1 AND board_id = $2',
      [u.columnId, act.board_id, sets.title ?? null, sets.color ?? null]);
  },

  async column_order(act, u, skipped) {
    const cur = await query('SELECT column_id, order_index FROM board_columns WHERE board_id = $1', [act.board_id]);
    const now = Object.fromEntries(cur.rows.map(c => [c.column_id, Number(c.order_index)]));
    const moved = Object.keys(u.after || {}).filter(id => id in now && now[id] !== u.after[id]);
    if (moved.length) { skipped.push('the column order was changed again since — kept'); return; }
    const ids = Object.keys(u.before || {}).filter(id => id in now && u.before[id] !== undefined);
    if (!ids.length) return;
    await query(`UPDATE board_columns c SET order_index = t.i
                   FROM unnest($2::text[], $3::int[]) AS t(id, i)
                  WHERE c.column_id = t.id AND c.board_id = $1`, [act.board_id, ids, ids.map(id => u.before[id])]);
  },

  async board_fields(act, u, skipped) {
    const cur = (await query('SELECT title, description FROM boards WHERE board_id = $1', [act.board_id])).rows[0];
    const sets = {};
    for (const [field, after] of Object.entries(u.after || {})) {
      if (same(cur[field], after)) sets[field] = u.before[field];
      else skipped.push(`the ${field === 'title' ? 'name' : 'description'} was changed again since — kept`);
    }
    if (!Object.keys(sets).length) return;
    await query('UPDATE boards SET title = COALESCE($2, title), description = COALESCE($3, description) WHERE board_id = $1',
      [act.board_id, sets.title ?? null, sets.description ?? null]);
  },

  async attachment_added(act, u) {
    await query('DELETE FROM board_attachments WHERE attachment_id = $1 AND board_id = $2', [u.attachmentId, act.board_id]);
  },

  /**
   * Bring deleted rows back from the trash: columns, then cards (into their
   * old column, or the first one if that is gone too), then files (onto their
   * card, or onto the board if the card is gone). Rows that already exist again
   * are left alone. The trash rows go once restored.
   */
  async trash(act, u, skipped) {
    const t = await query('SELECT kind, COUNT(*)::int AS n FROM board_trash WHERE activity_id = $1 GROUP BY kind', [act.activity_id]);
    if (!t.rowCount) { skipped.push('nothing left in the trash to restore'); return; }
    await query(`
      INSERT INTO board_columns
      SELECT (jsonb_populate_record(NULL::board_columns, payload)).*
        FROM board_trash WHERE activity_id = $1 AND kind = 'column'
      ON CONFLICT (column_id) DO NOTHING`, [act.activity_id]);
    const first = (await query('SELECT column_id FROM board_columns WHERE board_id = $1 ORDER BY order_index LIMIT 1', [act.board_id])).rows[0];
    const cards = await query(`
      INSERT INTO board_cards
      SELECT (jsonb_populate_record(NULL::board_cards,
                t.payload || jsonb_build_object('column_id', COALESCE(c.column_id, $2::text)))).*
        FROM board_trash t LEFT JOIN board_columns c ON c.column_id = t.payload->>'column_id'
       WHERE t.activity_id = $1 AND t.kind = 'card' AND COALESCE(c.column_id, $2::text) IS NOT NULL
      ON CONFLICT (card_id) DO NOTHING`, [act.activity_id, first ? first.column_id : null]);
    const wanted = (t.rows.find(r => r.kind === 'card') || {}).n || 0;
    if (cards.rowCount < wanted && !first) skipped.push('there is no column left to put the cards back in');
    await query(`
      INSERT INTO board_attachments
      SELECT (jsonb_populate_record(NULL::board_attachments,
                t.payload || jsonb_build_object('card_id', k.card_id))).*
        FROM board_trash t LEFT JOIN board_cards k ON k.card_id = t.payload->>'card_id'
       WHERE t.activity_id = $1 AND t.kind = 'attachment'
      ON CONFLICT (attachment_id) DO NOTHING`, [act.activity_id]);
    await query('DELETE FROM board_trash WHERE activity_id = $1', [act.activity_id]);
  }
};

const FIELD_WORDS = {
  title: 'the title', summary: 'the summary', detail: 'the details', tags: 'the tags', priority: 'the priority',
  start_date: 'the start date', end_date: 'the end date', color: 'the colour', column_id: 'the lane',
  done_at: 'done / not done', order_index: 'its place in the queue'
};

/** Apply one activity's undo and mark it reverted. Returns the skips. */
async function applyUndo(act, userId) {
  if (!act.undo) throw new BoardError(400, 'This change cannot be undone');
  if (act.reverted_at) throw new BoardError(400, 'This change has already been undone');
  const fn = APPLY[act.undo.type];
  if (!fn) throw new BoardError(400, 'This change cannot be undone');
  const skipped = [];
  await fn(act, act.undo, skipped);
  await query('UPDATE board_activity SET reverted_at = now(), reverted_by = $2 WHERE activity_id = $1', [act.activity_id, actorOf(userId).userId]);
  return skipped;
}

/** Undo one change from History. */
async function revertActivity(boardId, userId, activityId) {
  await requireUndoer(boardId, userId);
  const act = await loadActivity(boardId, activityId);
  const skipped = await applyUndo(act, userId);
  await Boards.record(boardId, userId, 'revert', `undid ${whoMade(act)}'s change: ${act.summary}`,
    { activityId, skipped });
  return { undone: 1, skipped };
}

/**
 * Undo everything one guest did on this board that is still standing, newest
 * first — so their later edits come off before the cards they made disappear.
 */
async function revertGuest(boardId, userId, guestId) {
  await requireUndoer(boardId, userId);
  const g = (await query('SELECT number, name FROM board_guests WHERE guest_id = $1 AND board_id = $2', [guestId, boardId])).rows[0];
  if (!g) throw new BoardError(404, 'Guest not found');
  const acts = await query(`
    SELECT a.*, NULL AS user_name, $3::int AS guest_number, $4::text AS guest_name
      FROM board_activity a
     WHERE a.board_id = $1 AND a.guest_id = $2 AND a.undo IS NOT NULL AND a.reverted_at IS NULL
     ORDER BY a.created_at DESC`, [boardId, guestId, g.number, g.name]);
  const skipped = [];
  for (const act of acts.rows) skipped.push(...await applyUndo(act, userId));
  const label = guestLabel(g.number, g.name);
  if (acts.rows.length) {
    await Boards.record(boardId, userId, 'revert',
      `undid ${acts.rows.length} change${acts.rows.length === 1 ? '' : 's'} by ${label}`, { guestId, count: acts.rows.length, skipped });
  }
  return { undone: acts.rows.length, skipped, label };
}

module.exports = { revertActivity, revertGuest, APPLY };
