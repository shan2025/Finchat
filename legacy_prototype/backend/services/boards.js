// services/boards.js — Kanban boards (migration 056).
//
// A board is its own artifact, not a view of a mind map: columns are whatever
// the user names them (a product each, or To do / Doing / Done), and cards
// carry dates, priority and colored tags. What boards share with mind maps is
// everything AROUND the content — files, notes, links, share links — and those
// reuse the same services (mindMapDocFile, linkAttach, attachments).
//
// A QUEUE (migration 061) is a board of kind 'queue': each column is a lane —
// one person or team — and card order is the order of work, so the first card
// is what they do now and the next is next. A finished task is marked done
// (done_at) rather than deleted. Same tables, same routes, same History.
//
// Ownership is enforced here by always resolving a board with its user_id; a
// board, column, card or attachment that is not the caller's is "not found".
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

const KINDS = new Set(['kanban', 'queue']);
const PRIORITIES = new Set(['high', 'medium', 'low']);
const HEX = /^#[0-9a-fA-F]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Tag colours, in the order a new tag takes them. Saturated on purpose — the
// board is white, and the tags are where the colour lives.
const TAG_COLORS = ['#6631d7', '#2b59c3', '#d62d2d', '#fac710', '#12a150', '#fb8c00',
  '#0ca789', '#e84fa7', '#7a5c3e', '#5f6b7a'];
// Column header pills: pastel, so black text reads on every one.
const COLUMN_COLORS = ['#fff3a3', '#ffcd9e', '#c6f1d0', '#cde4ff', '#e2d6ff', '#ffd6ea', '#d4f4f1', '#eceff3'];

const LIMITS = { title: 200, summary: 600, detail: 4000, tags: 12, tagLabel: 40, columns: 30, cards: 1000 };

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanLong = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);

class BoardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const notFound = (what) => new BoardError(404, `${what} not found`);
const bad = (msg) => new BoardError(400, msg);

/** What History calls things: a queue has lanes and tasks, a Kanban board columns and cards. */
const nouns = (board) => (board && board.kind === 'queue'
  ? { board: 'queue', col: 'lane', card: 'task' }
  : { board: 'board', col: 'column', card: 'card' });

// ── validation ─────────────────────────────────────────────────

/** A real calendar day: the round trip rejects 2026-02-30, which Date.parse quietly rolls into March. */
function isRealDate(s) {
  if (!DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function normDate(v, field) {
  if (v === null || v === '') return null;
  if (v === undefined) return undefined;
  const s = String(v).slice(0, 10);
  if (!isRealDate(s)) throw bad(`${field} must be YYYY-MM-DD`);
  return s;
}

/**
 * Tags as stored: [{label, color}], deduplicated by label (case-insensitive).
 * A tag without a colour takes the one the board already uses for that label,
 * else the next free colour — so "Core" is the same purple on every card.
 */
function normTags(tags, palette = []) {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags)) throw bad('tags must be an array');
  const known = new Map(palette.map(t => [String(t.label).toLowerCase(), t.color]));
  // Pass 1: labels, and the colours already spoken for — explicit ones and the
  // board's own — so pass 2 never hands a new tag a colour a later tag claims.
  const picked = [];
  const seen = new Set();
  for (const t of tags.slice(0, LIMITS.tags * 2)) {
    const label = clean(typeof t === 'string' ? t : t && t.label, LIMITS.tagLabel);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const color = t && typeof t === 'object' && HEX.test(t.color || '') ? t.color : known.get(label.toLowerCase());
    picked.push({ label, color: color || null });
    if (picked.length >= LIMITS.tags) break;
  }
  // Pass 2: a colour for each tag that has none yet.
  const used = new Set([...known.values(), ...picked.map(x => x.color).filter(Boolean)]);
  let spill = 0;
  for (const t of picked) {
    if (t.color) continue;
    t.color = TAG_COLORS.find(c => !used.has(c)) || TAG_COLORS[spill++ % TAG_COLORS.length];
    used.add(t.color);
  }
  return picked;
}

function mergePalette(palette, tags) {
  const map = new Map(palette.map(t => [String(t.label).toLowerCase(), t]));
  for (const t of tags) map.set(t.label.toLowerCase(), t);
  return [...map.values()].slice(0, 60);
}

// ── reads ──────────────────────────────────────────────────────

// Attachment columns WITHOUT `data` (the bytes) — a board read must not drag
// every PDF across the wire. has_data says an original exists.
const ATT_COLS = `attachment_id, board_id, card_id, kind, filename, mimetype, size_bytes, url, provider,
  char_count, order_index, created_at, (data IS NOT NULL) AS has_data`;

/**
 * The board, if the caller may use it — its owner, or a member (migration 057).
 *   need 'view' | 'edit'  owner or editor (members are all editors today; the
 *                         two stay distinct so a viewer role is one line)
 *   need 'owner'          delete the board, manage people and share links
 * No access at all is 404, never 403 — a 403 would confirm the board exists.
 * The row comes back with `access` = 'owner' | 'editor'.
 */
async function requireBoard(boardId, userId, need = 'edit') {
  const r = await query(`
    SELECT b.*, CASE WHEN b.user_id = $2 THEN 'owner' ELSE m.role END AS access
      FROM boards b
      LEFT JOIN board_members m ON m.board_id = b.board_id AND m.user_id = $2
     WHERE b.board_id = $1 AND (b.user_id = $2 OR m.user_id IS NOT NULL)
  `, [boardId, userId]);
  const board = r.rows[0];
  if (!board) throw notFound('Board');
  if (need === 'owner' && board.access !== 'owner') throw new BoardError(403, 'Only the board owner can do that');
  return board;
}

async function listBoards(userId) {
  const r = await query(`
    SELECT b.board_id, b.title, b.description, b.updated_at, b.created_at, b.source_map_id, b.kind,
           CASE WHEN b.user_id = $1 THEN 'owner' ELSE m.role END AS access,
           u.name AS owner_name,
           (SELECT COUNT(*) FROM board_columns c WHERE c.board_id = b.board_id)::int AS column_count,
           (SELECT COUNT(*) FROM board_cards k WHERE k.board_id = b.board_id)::int AS card_count,
           (SELECT COUNT(*) FROM board_cards k WHERE k.board_id = b.board_id AND k.done_at IS NOT NULL)::int AS done_count,
           (SELECT COUNT(*) FROM board_members bm WHERE bm.board_id = b.board_id)::int AS member_count
      FROM boards b
      LEFT JOIN board_members m ON m.board_id = b.board_id AND m.user_id = $1
      LEFT JOIN users u ON u.user_id = b.user_id
     WHERE b.user_id = $1 OR m.user_id IS NOT NULL
     ORDER BY b.updated_at DESC LIMIT 100
  `, [userId]);
  return r.rows;
}

/** The whole board. `userId` null skips the access check — only share routes, which resolved a token, pass null. */
async function getBoard(boardId, userId) {
  const board = userId === null
    ? (await query('SELECT * FROM boards WHERE board_id = $1', [boardId])).rows[0]
    : await requireBoard(boardId, userId, 'view');
  if (!board) throw notFound('Board');
  const [cols, cards, atts] = await Promise.all([
    query('SELECT * FROM board_columns WHERE board_id = $1 ORDER BY order_index, created_at', [boardId]),
    query('SELECT * FROM board_cards WHERE board_id = $1 ORDER BY order_index, created_at', [boardId]),
    query(`SELECT ${ATT_COLS} FROM board_attachments WHERE board_id = $1 ORDER BY order_index, created_at`, [boardId])
  ]);
  return { board, columns: cols.rows, cards: cards.rows, attachments: atts.rows };
}

// ── history ────────────────────────────────────────────────────

const q = (s) => `“${clean(s, 80)}”`;

/**
 * One change, in the History panel's words, AND the board's updated_at bump —
 * a single statement, so history costs no extra round trip over the old touch().
 *
 * `key` coalesces a burst: typing in a card's description saves several times
 * a minute, and History should say "edited the description" once, not twelve
 * times. The same user repeating the same keyed change within two minutes
 * updates the last row instead of adding one.
 */
async function record(boardId, userId, action, summary, details = {}, { key = null } = {}) {
  await query(`
    WITH last AS (
      SELECT activity_id FROM board_activity WHERE board_id = $1 ORDER BY created_at DESC LIMIT 1
    ), upd AS (
      UPDATE board_activity a SET summary = $5, details = $6, created_at = now()
        FROM last
       WHERE a.activity_id = last.activity_id AND a.user_id = $3 AND $7::text IS NOT NULL
         AND a.details->>'key' = $7 AND a.created_at > now() - interval '2 minutes'
      RETURNING a.activity_id
    ), bump AS (
      UPDATE boards SET updated_at = now() WHERE board_id = $1
    )
    INSERT INTO board_activity (activity_id, board_id, user_id, action, summary, details)
    SELECT $2, $1, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM upd)
  `, [boardId, 'bac_' + uuidv4(), userId || null, action, clean(summary, 400),
      JSON.stringify(key ? { ...details, key } : details), key]);
}

/** Newest first; `before` (an ISO time) pages back. Any member may read it. */
async function listActivity(boardId, userId, { before = null, limit = 50 } = {}) {
  await requireBoard(boardId, userId, 'view');
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const r = await query(`
    SELECT a.activity_id, a.user_id, a.action, a.summary, a.details, a.created_at, u.name AS user_name
      FROM board_activity a LEFT JOIN users u ON u.user_id = a.user_id
     WHERE a.board_id = $1 AND ($2::timestamptz IS NULL OR a.created_at < $2::timestamptz)
     ORDER BY a.created_at DESC LIMIT $3
  `, [boardId, before && !Number.isNaN(Date.parse(before)) ? before : null, n]);
  return r.rows;
}

/**
 * What changed on a card, in words. Pure; exported for tests.
 * @param cur   the card row before the update
 * @param f     the normalised fields being written (see cardFields)
 * @param cols  {from, to} column titles when the card moved
 * @returns {{summary:string, changes:object, key:string|null} | null}  null = nothing changed
 */
function describeCardChange(cur, f, cols = {}) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const curDate = (d) => (d ? isoDate(d) : null);
  const changes = {};
  if (f.title !== undefined && f.title !== cur.title) changes.title = { from: cur.title, to: f.title };
  if (f.column_id !== undefined && f.column_id !== cur.column_id) changes.column = { from: cols.from || null, to: cols.to || null };
  if (f.priority !== undefined && f.priority !== (cur.priority || null)) changes.priority = { from: cur.priority || null, to: f.priority };
  if ((f.start_date !== undefined && f.start_date !== curDate(cur.start_date)) ||
      (f.end_date !== undefined && f.end_date !== curDate(cur.end_date))) {
    changes.dates = {
      from: [curDate(cur.start_date), curDate(cur.end_date)],
      to: [f.start_date !== undefined ? f.start_date : curDate(cur.start_date), f.end_date !== undefined ? f.end_date : curDate(cur.end_date)]
    };
  }
  if (f.tags !== undefined) {
    const before = (cur.tags || []).map(t => t.label), after = f.tags.map(t => t.label);
    const low = (xs) => xs.map(x => x.toLowerCase());
    const added = after.filter(t => !low(before).includes(t.toLowerCase()));
    const removed = before.filter(t => !low(after).includes(t.toLowerCase()));
    if (added.length || removed.length) changes.tags = { added, removed };
  }
  if (f.summary !== undefined && f.summary !== cur.summary) changes.summary = true;
  if (f.detail !== undefined && f.detail !== cur.detail) changes.detail = true;
  if (f.color !== undefined && !same(f.color, cur.color || null)) changes.color = { from: cur.color || null, to: f.color };

  const keys = Object.keys(changes);
  if (!keys.length) return null;
  const name = q(changes.title ? changes.title.to : cur.title);
  const fmtDay = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '…');
  const phrase = {
    title: () => `renamed from ${q(changes.title.from)}`,
    column: () => `moved from ${changes.column.from || '?'} to ${changes.column.to || '?'}`,
    priority: () => (changes.priority.to ? `priority ${changes.priority.to}` : 'priority removed'),
    dates: () => (changes.dates.to[0] || changes.dates.to[1]
      ? `dates ${fmtDay(changes.dates.to[0])} → ${fmtDay(changes.dates.to[1])}` : 'dates removed'),
    tags: () => [...changes.tags.added.map(t => `+${t}`), ...changes.tags.removed.map(t => `−${t}`)].join(' '),
    summary: () => 'summary edited',
    detail: () => 'details edited',
    color: () => 'colour changed'
  };

  let summary;
  if (keys.length === 1 && changes.column) summary = `moved ${name} from ${changes.column.from || '?'} to ${changes.column.to || '?'}`;
  else if (keys.length === 1 && changes.title) summary = `renamed ${q(changes.title.from)} to ${q(changes.title.to)}`;
  else if (keys.length === 1 && changes.priority) summary = changes.priority.to ? `set the priority of ${name} to ${changes.priority.to}` : `removed the priority from ${name}`;
  else if (keys.every(k => k === 'summary' || k === 'detail')) summary = `edited the description of ${name}`;
  else summary = `updated ${name} — ${keys.map(k => phrase[k]()).join(', ')}`;

  // Only text edits coalesce: a burst of autosaves is one change to a reader.
  const key = keys.every(k => k === 'summary' || k === 'detail') ? `text:${cur.card_id}` : null;
  return { summary, changes, key };
}

// ── boards ─────────────────────────────────────────────────────

async function createBoard(userId, { title, description, columns, kind, origin = null, originDetails = {} } = {}) {
  const k = kind === undefined || kind === null || kind === '' ? 'kanban' : String(kind);
  if (!KINDS.has(k)) throw bad('kind must be kanban or queue');
  const boardId = 'brd_' + uuidv4();
  await query('INSERT INTO boards (board_id, user_id, title, description, kind) VALUES ($1,$2,$3,$4,$5)',
    [boardId, userId, clean(title, LIMITS.title) || (k === 'queue' ? 'Untitled queue' : 'Untitled board'),
     cleanLong(description, 2000), k]);
  const names = Array.isArray(columns) && columns.length
    ? columns.map(c => clean(typeof c === 'string' ? c : c && c.title, 120)).filter(Boolean).slice(0, LIMITS.columns)
    : k === 'queue' ? ['Me'] : ['To do', 'In progress', 'Done'];
  // One statement: every round trip to the database costs ~125ms from here.
  if (names.length) {
    await query(`
      INSERT INTO board_columns (column_id, board_id, title, color, order_index)
      SELECT t.id, $1, t.title, t.color, t.i - 1
        FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS t(id, title, color, i)
    `, [boardId, names.map(() => 'bcl_' + uuidv4()), names,
        names.map((_, i) => COLUMN_COLORS[i % COLUMN_COLORS.length])]);
  }
  await record(boardId, userId, 'create_board', origin || `created the ${nouns({ kind: k }).board}`, originDetails);
  return boardId;
}

async function updateBoard(boardId, userId, { title, description }) {
  const cur = await requireBoard(boardId, userId);
  const n = nouns(cur);
  const newTitle = title !== undefined ? (clean(title, LIMITS.title) || `Untitled ${n.board}`) : null;
  const newDesc = description !== undefined ? cleanLong(description, 2000) : null;
  await query('UPDATE boards SET title = COALESCE($2, title), description = COALESCE($3, description) WHERE board_id = $1',
    [boardId, newTitle, newDesc]);
  if (newTitle !== null && newTitle !== cur.title) {
    await record(boardId, userId, 'rename_board', `renamed the ${n.board} from ${q(cur.title)} to ${q(newTitle)}`,
      { from: cur.title, to: newTitle });
  } else if (newDesc !== null && newDesc !== cur.description) {
    await record(boardId, userId, 'edit_board', `edited the ${n.board} description`, {}, { key: `boarddesc:${boardId}` });
  }
}

async function deleteBoard(boardId, userId) {
  await requireBoard(boardId, userId, 'owner');
  const r = await query('DELETE FROM boards WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
  if (!r.rowCount) throw notFound('Board');
}

// ── columns ────────────────────────────────────────────────────

async function addColumn(boardId, userId, { title, color }) {
  const n = nouns(await requireBoard(boardId, userId));
  const count = await query('SELECT COUNT(*)::int AS n, COALESCE(MAX(order_index)+1,0) AS next FROM board_columns WHERE board_id = $1', [boardId]);
  if (count.rows[0].n >= LIMITS.columns) throw bad(`A ${n.board} holds at most ${LIMITS.columns} ${n.col}s`);
  const columnId = 'bcl_' + uuidv4();
  const name = clean(title, 120) || `New ${n.col}`;
  await query('INSERT INTO board_columns (column_id, board_id, title, color, order_index) VALUES ($1,$2,$3,$4,$5)',
    [columnId, boardId, name,
     HEX.test(color || '') ? color : COLUMN_COLORS[count.rows[0].n % COLUMN_COLORS.length], count.rows[0].next]);
  await record(boardId, userId, 'add_column', `added the ${n.col} ${q(name)}`, { columnId });
  return columnId;
}

async function updateColumn(boardId, userId, columnId, { title, color }) {
  const n = nouns(await requireBoard(boardId, userId));
  if (color !== undefined && color !== null && !HEX.test(color)) throw bad('color must be #rrggbb');
  // The old title rides along from the same statement (FROM sees the row before the update).
  const r = await query(`
    UPDATE board_columns c SET title = COALESCE($3, c.title), color = COALESCE($4, c.color)
      FROM (SELECT title AS old_title FROM board_columns WHERE column_id = $1) o
     WHERE c.column_id = $1 AND c.board_id = $2
    RETURNING c.title, o.old_title`,
    [columnId, boardId, title !== undefined ? (clean(title, 120) || 'Untitled') : null, color || null]);
  if (!r.rowCount) throw notFound('Column');
  const { title: now, old_title: was } = r.rows[0];
  if (now !== was) await record(boardId, userId, 'rename_column', `renamed the ${n.col} ${q(was)} to ${q(now)}`, { columnId, from: was, to: now });
  else if (color) await record(boardId, userId, 'color_column', `changed the colour of ${q(now)}`, { columnId, color });
}

async function deleteColumn(boardId, userId, columnId) {
  const n = nouns(await requireBoard(boardId, userId));
  const r = await query(`
    DELETE FROM board_columns WHERE column_id = $1 AND board_id = $2
    RETURNING title, (SELECT COUNT(*) FROM board_cards WHERE column_id = $1)::int AS cards`, [columnId, boardId]);
  if (!r.rowCount) throw notFound('Column');
  const { title, cards } = r.rows[0];
  await record(boardId, userId, 'delete_column',
    `deleted the ${n.col} ${q(title)}${cards ? ` and its ${cards} ${n.card}${cards === 1 ? '' : 's'}` : ''}`, { columnId, title, cards });
}

/** Set column order from a full list of ids. Unknown ids are ignored. */
async function orderColumns(boardId, userId, columnIds) {
  const n = nouns(await requireBoard(boardId, userId));
  const ids = (Array.isArray(columnIds) ? columnIds : []).filter(x => typeof x === 'string').slice(0, LIMITS.columns);
  if (!ids.length) return;
  await query(`UPDATE board_columns c SET order_index = t.i
                 FROM unnest($2::text[]) WITH ORDINALITY AS t(id, i)
                WHERE c.column_id = t.id AND c.board_id = $1`, [boardId, ids]);
  await record(boardId, userId, 'order_columns', `reordered the ${n.col}s`, {}, { key: `colorder:${boardId}` });
}

// ── cards ──────────────────────────────────────────────────────

/** The column's title, or a 400 when it is not on this board. */
async function requireColumn(boardId, columnId) {
  const r = await query('SELECT column_id, title FROM board_columns WHERE column_id = $1 AND board_id = $2', [columnId, boardId]);
  if (!r.rows.length) throw bad('columnId is not a column on this board');
  return r.rows[0].title;
}

async function saveTags(board, tags) {
  if (!tags || !tags.length) return;
  const palette = mergePalette(board.tag_palette || [], tags);
  await query('UPDATE boards SET tag_palette = $2 WHERE board_id = $1', [board.board_id, JSON.stringify(palette)]);
}

function cardFields(input, board) {
  const f = {};
  if (input.title !== undefined) f.title = clean(input.title, LIMITS.title) || 'Untitled card';
  if (input.summary !== undefined) f.summary = cleanLong(input.summary, LIMITS.summary);
  if (input.detail !== undefined) f.detail = cleanLong(input.detail, LIMITS.detail);
  if (input.priority !== undefined) {
    const p = input.priority === null || input.priority === '' ? null : String(input.priority).toLowerCase();
    if (p !== null && !PRIORITIES.has(p)) throw bad('priority must be high, medium, low or null');
    f.priority = p;
  }
  if (input.color !== undefined) {
    if (input.color !== null && input.color !== '' && !HEX.test(input.color)) throw bad('color must be #rrggbb');
    f.color = input.color || null;
  }
  const start = normDate(input.startDate, 'startDate');
  const end = normDate(input.endDate, 'endDate');
  if (start !== undefined) f.start_date = start;
  if (end !== undefined) f.end_date = end;
  const tags = normTags(input.tags, board.tag_palette || []);
  if (tags !== undefined) f.tags = tags;
  return f;
}

/**
 * A new card at the back of its column — or, with position 'front', ahead of
 * everything still waiting there (a queue's "do this first"). The front is
 * worked out from tasks not yet done: a finished one keeps its old slot number.
 */
async function addCard(boardId, userId, input = {}) {
  const board = await requireBoard(boardId, userId);
  const words = nouns(board);
  const colTitle = await requireColumn(boardId, input.columnId);
  const n = await query('SELECT COUNT(*)::int AS n FROM board_cards WHERE board_id = $1', [boardId]);
  if (n.rows[0].n >= LIMITS.cards) throw bad(`A ${words.board} holds at most ${LIMITS.cards} ${words.card}s`);
  const f = cardFields({ title: input.title || `Untitled ${words.card}`, ...input }, board);
  if (f.start_date && f.end_date && f.end_date < f.start_date) throw bad('endDate is before startDate');
  const front = input.position === 'front';
  const next = await query(front
    ? 'SELECT COALESCE(MIN(order_index)-1,0) AS next FROM board_cards WHERE column_id = $1 AND done_at IS NULL'
    : 'SELECT COALESCE(MAX(order_index)+1,0) AS next FROM board_cards WHERE column_id = $1', [input.columnId]);
  const cardId = 'bcd_' + uuidv4();
  await query(`
    INSERT INTO board_cards (card_id, board_id, column_id, title, summary, detail, tags, priority,
                             start_date, end_date, color, order_index)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [cardId, boardId, input.columnId, f.title, f.summary || '', f.detail || '', JSON.stringify(f.tags || []),
      f.priority || null, f.start_date || null, f.end_date || null, f.color || null, Number(next.rows[0].next) || 0]);
  await saveTags(board, f.tags);
  await record(boardId, userId, 'add_card', board.kind === 'queue'
    ? (front ? `put the task ${q(f.title)} at the front of ${colTitle}'s queue` : `added the task ${q(f.title)} to ${colTitle}'s queue`)
    : `added the card ${q(f.title)} to ${colTitle}`, { cardId, columnId: input.columnId });
  return cardId;
}

/** Any of the card fields, a move (columnId), and — on a queue — done: true | false. */
async function updateCard(boardId, userId, cardId, input = {}) {
  const board = await requireBoard(boardId, userId);
  const cur = (await query(`SELECT k.*, c.title AS column_title FROM board_cards k
                              JOIN board_columns c ON c.column_id = k.column_id
                             WHERE k.card_id = $1 AND k.board_id = $2`, [cardId, boardId])).rows[0];
  if (!cur) throw notFound('Card');
  if (input.done !== undefined) {
    if (board.kind !== 'queue') throw bad('Only a queue marks tasks done — move the card to a Done column instead');
    await setCardDone(boardId, userId, cardId, !!input.done, { board });
  }
  const f = cardFields(input, board);
  const start = f.start_date !== undefined ? f.start_date : (cur.start_date ? isoDate(cur.start_date) : null);
  const end = f.end_date !== undefined ? f.end_date : (cur.end_date ? isoDate(cur.end_date) : null);
  if (start && end && end < start) throw bad('endDate is before startDate');
  let toColumn = null;
  if (input.columnId !== undefined && input.columnId !== cur.column_id) {
    toColumn = await requireColumn(boardId, input.columnId);
    f.column_id = input.columnId;
  }
  const keys = Object.keys(f);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const vals = keys.map(k => (k === 'tags' ? JSON.stringify(f[k]) : f[k]));
  await query(`UPDATE board_cards SET ${sets.join(', ')}, updated_at = now() WHERE card_id = $1 AND board_id = $2`,
    [cardId, boardId, ...vals]);
  await saveTags(board, f.tags);
  const change = describeCardChange(cur, f, { from: cur.column_title, to: toColumn });
  if (change) {
    await record(boardId, userId, 'update_card', change.summary, { cardId, changes: change.changes }, { key: change.key });
  }
}

function isoDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  // pg returns DATE as a local-midnight Date; format it back without a UTC shift.
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * A queue task finished (done) or un-finished (put back). Finishing takes it
 * out of the lane; putting it back puts it at the FRONT, since the usual reason
 * is a Done pressed too early. One statement each. Already in that state — a
 * double click, or a teammate got there first — is a quiet no-op (false).
 */
async function setCardDone(boardId, userId, cardId, done, { board = null } = {}) {
  const b = board || await requireBoard(boardId, userId);
  if (b.kind !== 'queue') throw bad('Only a queue marks tasks done — move the card to a Done column instead');
  const r = await query(done
    ? `UPDATE board_cards k SET done_at = now(), updated_at = now()
        WHERE k.card_id = $1 AND k.board_id = $2 AND k.done_at IS NULL
      RETURNING k.title, k.column_id, (SELECT title FROM board_columns c WHERE c.column_id = k.column_id) AS lane`
    : `UPDATE board_cards k SET done_at = NULL, updated_at = now(),
              order_index = (SELECT COALESCE(MIN(o.order_index) - 1, 0) FROM board_cards o
                              WHERE o.column_id = k.column_id AND o.done_at IS NULL)
        WHERE k.card_id = $1 AND k.board_id = $2 AND k.done_at IS NOT NULL
      RETURNING k.title, k.column_id, (SELECT title FROM board_columns c WHERE c.column_id = k.column_id) AS lane`,
    [cardId, boardId]);
  if (!r.rowCount) {
    const exists = await query('SELECT 1 FROM board_cards WHERE card_id = $1 AND board_id = $2', [cardId, boardId]);
    if (!exists.rowCount) throw notFound('Card');
    return false;
  }
  const { title, lane, column_id: columnId } = r.rows[0];
  await record(boardId, userId, done ? 'done_card' : 'undone_card',
    done ? `finished ${q(title)} from ${lane}'s queue` : `put ${q(title)} back at the front of ${lane}'s queue`,
    { cardId, columnId });
  return true;
}

async function deleteCard(boardId, userId, cardId) {
  const n = nouns(await requireBoard(boardId, userId));
  const r = await query('DELETE FROM board_cards WHERE card_id = $1 AND board_id = $2 RETURNING title', [cardId, boardId]);
  if (!r.rowCount) throw notFound('Card');
  await record(boardId, userId, 'delete_card', `deleted the ${n.card} ${q(r.rows[0].title)}`, { cardId, title: r.rows[0].title });
}

/**
 * Persist a drag: the full card order of every column the drag touched.
 * One statement, so a card can never be half-moved; every id must be a card on
 * this board and every column a column on it, or nothing is written.
 */
async function reorderCards(boardId, userId, columns) {
  const board = await requireBoard(boardId, userId);
  const list = Array.isArray(columns) ? columns.slice(0, LIMITS.columns) : [];
  const ids = [], cols = [], idx = [];
  for (const c of list) {
    if (!c || typeof c.columnId !== 'string' || !Array.isArray(c.cardIds)) continue;
    c.cardIds.slice(0, LIMITS.cards).forEach((id, i) => { ids.push(String(id)); cols.push(c.columnId); idx.push(i); });
  }
  if (!ids.length) return;
  const colSet = [...new Set(cols)];
  // Validate and read the "before" in one go: which column each card sat in,
  // and every column's title, so History can say "moved X from A to B".
  const [okCols, before] = await Promise.all([
    query('SELECT column_id, title FROM board_columns WHERE board_id = $1', [boardId]),
    query('SELECT card_id, column_id, title FROM board_cards WHERE board_id = $1 AND card_id = ANY($2::text[])', [boardId, ids])
  ]);
  const colTitle = new Map(okCols.rows.map(c => [c.column_id, c.title]));
  if (!colSet.every(c => colTitle.has(c))) throw bad('a column in that move is not on this board');
  if (before.rows.length !== new Set(ids).size) throw bad('a card in that move is not on this board');
  await query(`
    UPDATE board_cards k SET column_id = t.col, order_index = t.i, updated_at = now()
      FROM unnest($2::text[], $3::text[], $4::int[]) AS t(id, col, i)
     WHERE k.card_id = t.id AND k.board_id = $1
  `, [boardId, ids, cols, idx]);

  const target = new Map(ids.map((id, i) => [id, cols[i]]));
  const moved = before.rows.filter(k => target.get(k.card_id) !== k.column_id);
  if (moved.length === 1) {
    const k = moved[0];
    await record(boardId, userId, 'move_card',
      `moved ${q(k.title)} from ${colTitle.get(k.column_id)} to ${colTitle.get(target.get(k.card_id))}`,
      { cardId: k.card_id, from: colTitle.get(k.column_id), to: colTitle.get(target.get(k.card_id)) });
  } else if (moved.length > 1) {
    await record(boardId, userId, 'move_card', `moved ${moved.length} ${nouns(board).card}s`,
      { cards: moved.map(k => ({ cardId: k.card_id, title: k.title, from: colTitle.get(k.column_id), to: colTitle.get(target.get(k.card_id)) })) });
  } else {
    const where = colTitle.get(colSet[0]);
    await record(boardId, userId, 'order_cards',
      board.kind === 'queue' ? `reordered ${where}'s queue` : `reordered the cards in ${where}`, {}, { key: `order:${colSet[0]}` });
  }
}

// ── attachments ────────────────────────────────────────────────

async function requireCard(boardId, cardId) {
  if (!cardId) return null;
  const r = await query('SELECT card_id FROM board_cards WHERE card_id = $1 AND board_id = $2', [cardId, boardId]);
  if (!r.rows.length) throw bad('cardId is not a card on this board');
  return cardId;
}

async function insertAttachment(row) {
  const r = await query(`
    INSERT INTO board_attachments (attachment_id, board_id, card_id, user_id, kind, filename, mimetype,
                                   size_bytes, url, provider, extracted, char_count, data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING ${ATT_COLS}
  `, ['bat_' + uuidv4(), row.boardId, row.cardId || null, row.userId, row.kind, row.filename, row.mimetype || '',
      row.size || 0, row.url || null, row.provider || null, row.text || '', (row.text || '').length, row.data || null]);
  const a = r.rows[0];
  const where = row.cardId
    ? (await query('SELECT title FROM board_cards WHERE card_id = $1', [row.cardId])).rows.map(k => ` to ${q(k.title)}`)[0] || ''
    : ' to the board';
  const what = a.kind === 'link' ? 'added the link' : a.kind === 'text' ? 'added the note' : 'attached';
  await record(row.boardId, row.userId, 'attach', `${what} ${q(a.filename)}${where}`,
    { attachmentId: a.attachment_id, cardId: a.card_id || null, kind: a.kind });
  return a;
}

// Originals above this stay as extracted text only — the same cap as mind map documents.
const DB_MAX_BYTES = Number(process.env.MIND_MAP_DOC_DB_MAX_BYTES) || 8 * 1024 * 1024;

/**
 * One uploaded file (multer's shape) onto a card, or onto the board when
 * cardId is null: text extracted for search and the AI, the bytes kept when
 * small enough to store. The caller has already checked access and the card.
 */
async function attachUpload(boardId, cardId, userId, f) {
  const { extractFromUpload } = require('./attachments');
  const extracted = await extractFromUpload(f);
  return insertAttachment({
    boardId, cardId, userId, kind: extracted.kind === 'image' ? 'image' : 'document',
    filename: String(f.originalname || 'file').slice(0, 200), mimetype: f.mimetype || '',
    size: f.size || 0, text: String(extracted.text || ''), data: f.buffer && f.buffer.length <= DB_MAX_BYTES ? f.buffer : null
  });
}

/** One attachment the caller may read. `withData` pulls the bytes — only the file route asks. */
async function getAttachment(boardId, attachmentId, { withData = false } = {}) {
  const cols = withData ? `${ATT_COLS}, extracted, data` : `${ATT_COLS}, extracted`;
  const r = await query(`SELECT ${cols} FROM board_attachments WHERE attachment_id = $1 AND board_id = $2`,
    [attachmentId, boardId]);
  return r.rows[0] || null;
}

async function deleteAttachment(boardId, userId, attachmentId) {
  await requireBoard(boardId, userId);
  const r = await query('DELETE FROM board_attachments WHERE attachment_id = $1 AND board_id = $2 RETURNING filename, card_id',
    [attachmentId, boardId]);
  if (!r.rowCount) throw notFound('Attachment');
  await record(boardId, userId, 'detach', `removed ${q(r.rows[0].filename)}`, { attachmentId, cardId: r.rows[0].card_id || null });
}

// ── people ─────────────────────────────────────────────────────

/**
 * Everyone with access: the owner first, then editors. Emails only go to the
 * owner (they typed them in); editors see names and usernames.
 */
async function listMembers(boardId, userId) {
  const board = await requireBoard(boardId, userId, 'view');
  const r = await query(`
    SELECT u.user_id, u.name, u.username, u.email, 'owner' AS role, NULL::timestamptz AS added_at, 0 AS o
      FROM boards b JOIN users u ON u.user_id = b.user_id WHERE b.board_id = $1
    UNION ALL
    SELECT u.user_id, u.name, u.username, u.email, m.role, m.created_at, 1
      FROM board_members m JOIN users u ON u.user_id = m.user_id WHERE m.board_id = $1
    ORDER BY o, added_at
  `, [boardId]);
  return {
    access: board.access,
    members: r.rows.map(m => ({
      userId: m.user_id, name: m.name, username: m.username, role: m.role, addedAt: m.added_at,
      email: board.access === 'owner' ? m.email : undefined, you: m.user_id === userId
    }))
  };
}

/** A person, by email or username — never an agent's or the system's own row. */
async function findPerson(identifier) {
  const id = clean(identifier, 200).replace(/^@/, '');
  if (!id) throw bad('Type their email or FinChat username');
  const r = await query(`
    SELECT user_id, name, username FROM users
     WHERE (lower(email) = lower($1) OR lower(username) = lower($1))
       AND COALESCE(role, '') <> 'system' AND COALESCE(email, '') NOT LIKE '%@system.finchat.local'
     LIMIT 1`, [id]);
  if (!r.rows.length) {
    throw new BoardError(404, `No FinChat account matches "${id}" — they need to sign up first, then you can invite them`);
  }
  return r.rows[0];
}

async function addMember(boardId, userId, { identifier } = {}) {
  const board = await requireBoard(boardId, userId, 'owner');
  const person = await findPerson(identifier);
  if (person.user_id === board.user_id) throw bad('You own this board already');
  const r = await query(`
    INSERT INTO board_members (board_id, user_id, role, added_by) VALUES ($1, $2, 'editor', $3)
    ON CONFLICT (board_id, user_id) DO NOTHING RETURNING user_id`, [boardId, person.user_id, userId]);
  if (r.rowCount) {
    await record(boardId, userId, 'add_member', `gave ${person.name || person.username} edit access`, { memberId: person.user_id });
  }
  return { userId: person.user_id, name: person.name, username: person.username, added: !!r.rowCount };
}

/** The owner removes anyone; an editor may remove only themselves ("leave"). */
async function removeMember(boardId, userId, memberId) {
  const board = await requireBoard(boardId, userId, 'view');
  if (board.access !== 'owner' && memberId !== userId) throw new BoardError(403, 'Only the board owner can remove people');
  const r = await query(`
    DELETE FROM board_members m USING users u
     WHERE m.board_id = $1 AND m.user_id = $2 AND u.user_id = m.user_id
    RETURNING u.name, u.username`, [boardId, memberId]);
  if (!r.rowCount) throw notFound('Member');
  const who = r.rows[0].name || r.rows[0].username;
  await record(boardId, userId, 'remove_member', memberId === userId ? 'left the board' : `removed ${who}'s edit access`,
    { memberId });
}

/**
 * Someone signed in opened an EDIT link: they join as an editor. Idempotent —
 * opening the link again, or the owner opening it, just returns the board.
 */
async function joinByLink(boardId, userId) {
  const b = (await query('SELECT user_id FROM boards WHERE board_id = $1', [boardId])).rows[0];
  if (!b) throw notFound('Board');
  if (b.user_id === userId) return { joined: false };
  const r = await query(`
    INSERT INTO board_members (board_id, user_id, role, added_by) VALUES ($1, $2, 'editor', 'link')
    ON CONFLICT (board_id, user_id) DO NOTHING RETURNING user_id`, [boardId, userId]);
  if (r.rowCount) await record(boardId, userId, 'join', 'joined as an editor from an edit link', {});
  return { joined: !!r.rowCount };
}

/** Cheap "has anything changed?" for editors watching the same board. */
async function boardStamp(boardId, userId) {
  await requireBoard(boardId, userId, 'view');
  const r = await query(`
    SELECT b.updated_at, a.user_id AS by_id, u.name AS by_name
      FROM boards b
      LEFT JOIN LATERAL (SELECT user_id FROM board_activity WHERE board_id = b.board_id ORDER BY created_at DESC LIMIT 1) a ON true
      LEFT JOIN users u ON u.user_id = a.user_id
     WHERE b.board_id = $1`, [boardId]);
  const row = r.rows[0] || {};
  return { updatedAt: row.updated_at, byId: row.by_id || null, byName: row.by_name || null };
}

async function attachmentsWithData(boardId) {
  const r = await query(`SELECT ${ATT_COLS}, extracted, data FROM board_attachments WHERE board_id = $1 ORDER BY order_index, created_at`, [boardId]);
  return r.rows;
}

// ── from a mind map ────────────────────────────────────────────

/**
 * Build a board from a mind map the caller owns.
 *
 *   columns  = the root's branches, in order
 *   cards    = each branch's children
 *   detail   = anything deeper, folded into the card as an indented list
 *
 * A map that is only one level deep (branches, no children) becomes one
 * column with a card per branch — a board of one card would be pointless.
 * Documents and links on those nodes come along, copied inside the database.
 */
async function fromMindMap(userId, mapId) {
  const mapRes = await query('SELECT * FROM mind_maps WHERE map_id = $1 AND user_id = $2', [mapId, userId]);
  const map = mapRes.rows[0];
  if (!map) throw notFound('Mind map');
  const nodes = (await query('SELECT * FROM mind_map_nodes WHERE map_id = $1 ORDER BY order_index, created_at', [mapId])).rows;
  const root = nodes.find(n => !n.parent_id);
  if (!root) throw bad('That map is empty');
  const kids = (id) => nodes.filter(n => n.parent_id === id);
  const branches = kids(root.node_id);

  const deeper = (id, depth) => kids(id).flatMap(k => [
    `${'  '.repeat(depth)}• ${k.label}${k.summary ? ' — ' + k.summary : ''}`, ...deeper(k.node_id, depth + 1)
  ]);

  const flat = branches.every(b => kids(b.node_id).length === 0);
  const columnsSpec = flat
    ? [{ title: root.label || 'Topics', node: root, cards: branches }]
    : branches.map(b => ({ title: b.label, node: b, cards: kids(b.node_id) }));

  const boardId = await createBoard(userId, {
    title: map.title || root.label, description: root.summary || '',
    columns: columnsSpec.map(c => c.title),
    origin: `made this board from the mind map ${q(map.title || root.label)}`, originDetails: { mapId }
  });
  await query('UPDATE boards SET source_map_id = $2 WHERE board_id = $1', [boardId, mapId]);
  const cols = (await query('SELECT column_id FROM board_columns WHERE board_id = $1 ORDER BY order_index', [boardId])).rows;

  // All cards in one statement (see createBoard on round trips).
  const cardForNode = new Map();
  const rows = { id: [], col: [], title: [], summary: [], detail: [], color: [], order: [] };
  for (let ci = 0; ci < columnsSpec.length; ci++) {
    const spec = columnsSpec[ci];
    for (let k = 0; k < spec.cards.length && rows.id.length < LIMITS.cards; k++) {
      const n = spec.cards[k];
      const extra = deeper(n.node_id, 0);
      const detail = [n.detail, extra.length ? extra.join('\n') : ''].filter(Boolean).join('\n\n');
      const cardId = 'bcd_' + uuidv4();
      rows.id.push(cardId);
      rows.col.push(cols[ci].column_id);
      rows.title.push(clean(n.label, LIMITS.title) || 'Untitled');
      rows.summary.push(cleanLong(n.summary, LIMITS.summary));
      rows.detail.push(cleanLong(detail, LIMITS.detail));
      rows.color.push(HEX.test(n.color || '') ? n.color : null);
      rows.order.push(k);
      cardForNode.set(n.node_id, cardId);
    }
  }
  if (rows.id.length) {
    await query(`
      INSERT INTO board_cards (card_id, board_id, column_id, title, summary, detail, color, order_index)
      SELECT t.id, $1, t.col, t.title, t.summary, t.detail, t.color, t.ord
        FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[])
             AS t(id, col, title, summary, detail, color, ord)
    `, [boardId, rows.id, rows.col, rows.title, rows.summary, rows.detail, rows.color, rows.order]);
  }

  // Attachments: a node's own go on its card; a grandchild's go on the card it
  // was folded into; the root's and the branches' (no card of their own) go on
  // the board itself.
  const parentOf = new Map(nodes.map(n => [n.node_id, n.parent_id]));
  const cardFor = (nodeId) => {
    for (let id = nodeId; id; id = parentOf.get(id)) if (cardForNode.has(id)) return cardForNode.get(id);
    return null;
  };
  // Copied INSIDE the database in one statement, so the originals' bytes never
  // travel through Node, and each copy lands on its card directly.
  const docs = (await query('SELECT doc_id, node_id FROM mind_map_docs WHERE map_id = $1 AND user_id = $2',
    [mapId, userId])).rows;
  if (docs.length) {
    await query(`
      INSERT INTO board_attachments (attachment_id, board_id, card_id, user_id, kind, filename, mimetype,
                                     size_bytes, url, provider, extracted, char_count, data, order_index, created_at)
      SELECT m.att_id, $1, m.card_id, $2, d.kind, d.filename, d.mimetype, d.size_bytes, d.url, d.provider,
             d.extracted, d.char_count, d.data, 0, d.created_at
        FROM mind_map_docs d
        JOIN unnest($3::text[], $4::text[], $5::text[]) AS m(doc_id, card_id, att_id) ON m.doc_id = d.doc_id
       WHERE d.user_id = $2
    `, [boardId, userId, docs.map(d => d.doc_id), docs.map(d => (d.node_id ? cardFor(d.node_id) : null)),
        docs.map(() => 'bat_' + uuidv4())]);
  }
  return boardId;
}

/**
 * The board already paired with a map, if any — so the map's Board button
 * opens that board instead of minting a fresh copy on every click.
 */
async function boardForMap(userId, mapId) {
  const r = await query(`SELECT board_id FROM boards WHERE user_id = $1 AND source_map_id = $2
                          ORDER BY updated_at DESC LIMIT 1`, [userId, mapId]);
  return r.rows[0] ? r.rows[0].board_id : null;
}

// ── to a mind map ──────────────────────────────────────────────

/**
 * The mirror of fromMindMap: the board as a mind map.
 *
 *   root     = the board (title, description)
 *   branches = its columns, in order
 *   leaves   = each column's cards; priority, dates and tags go in the detail
 *
 * A board already paired with a map (either direction) opens that map instead,
 * and a board converted here is paired with its new map. Both are copies —
 * editing one does not change the other.
 */
async function toMindMap(userId, boardId) {
  const { board, columns, cards: all } = await getBoard(boardId, userId);
  // A queue reads front to back: what is still waiting, in order, then what is done.
  const cards = board.kind === 'queue'
    ? [...all.filter(k => !k.done_at), ...all.filter(k => k.done_at).sort((a, b) => a.done_at - b.done_at)]
    : all;
  // The paired map is the OWNER's. An editor gets a map of their own and the
  // pairing is left alone — otherwise one editor's click would repoint the
  // owner's "Mind map" button at a map the owner cannot open.
  const isOwner = board.access === 'owner';
  if (board.source_map_id) {
    const r = await query('SELECT map_id FROM mind_maps WHERE map_id = $1 AND user_id = $2', [board.source_map_id, userId]);
    if (r.rows.length) return { mapId: r.rows[0].map_id, existed: true };
  }

  const Engine = require('./cognitive/MindMapEngine');
  const mapId = await Engine.createMap({
    userId, title: board.title, topic: board.title, sourceType: 'topic',
    meta: { fromBoard: boardId, convertedAt: new Date().toISOString() }
  });
  try {
    const rows = mapRowsFromBoard(mapId, board, columns, cards, () => 'mmn_' + uuidv4());
    await Engine.insertNodes(rows);

    // Files and links come along, copied inside the database (see fromMindMap).
    const nodeForCard = new Map(rows.filter(r => r.cardId).map(r => [r.cardId, r.node_id]));
    const atts = (await query('SELECT attachment_id, card_id FROM board_attachments WHERE board_id = $1', [boardId])).rows;
    if (atts.length) {
      await query(`
        INSERT INTO mind_map_docs (doc_id, user_id, map_id, node_id, filename, mimetype, size_bytes,
                                   stored_name, kind, extracted, char_count, data, url, provider, created_at)
        SELECT m.doc_id, $1, $2, m.node_id, a.filename, a.mimetype, a.size_bytes, NULL, a.kind,
               a.extracted, a.char_count, a.data, a.url, a.provider, a.created_at
          FROM board_attachments a
          JOIN unnest($3::text[], $4::text[], $5::text[]) AS m(att_id, node_id, doc_id) ON m.att_id = a.attachment_id
         WHERE a.board_id = $6
      `, [userId, mapId, atts.map(a => a.attachment_id),
          atts.map(a => (a.card_id && nodeForCard.get(a.card_id)) || null),
          atts.map(() => 'mmd_' + uuidv4()), boardId]);
    }
    if (isOwner) await query('UPDATE boards SET source_map_id = $2 WHERE board_id = $1', [boardId, mapId]);
    await record(boardId, userId, 'to_mind_map', 'made a mind map from this board', { mapId });
  } catch (err) {
    // Half a map is worse than an error; the cascade takes nodes and docs with it.
    await query('DELETE FROM mind_maps WHERE map_id = $1', [mapId]).catch(() => {});
    throw err;
  }
  return { mapId, existed: false };
}

/** Pure: the node rows for toMindMap, parents before children. Exported for tests. */
function mapRowsFromBoard(mapId, board, columns, cards, newId) {
  const row = (fields) => ({ map_id: mapId, entity_id: null, summary: '', detail: '', ...fields });
  const rootId = newId();
  const rows = [row({ node_id: rootId, parent_id: null, label: clean(board.title, 120) || 'Board',
    summary: clean(board.description, 400), node_type: 'root', order_index: 0 })];
  columns.forEach((col, ci) => {
    const colCards = cards.filter(k => k.column_id === col.column_id);
    const colId = newId();
    rows.push(row({ node_id: colId, parent_id: rootId, label: clean(col.title, 120) || 'Column',
      summary: `${colCards.length} card${colCards.length === 1 ? '' : 's'}`,
      node_type: colCards.length ? 'branch' : 'leaf', order_index: ci }));
    colCards.forEach((k, i) => {
      const facts = [
        k.priority ? `Priority: ${k.priority}` : '',
        k.start_date || k.end_date
          ? `Dates: ${k.start_date ? isoDate(k.start_date) : '…'} → ${k.end_date ? isoDate(k.end_date) : '…'}` : '',
        Array.isArray(k.tags) && k.tags.length ? `Tags: ${k.tags.map(t => t.label).join(', ')}` : '',
        k.done_at ? `Done: ${isoDate(k.done_at)}` : ''
      ].filter(Boolean).join(' · ');
      rows.push({ ...row({ node_id: newId(), parent_id: colId, label: clean(k.title, 120) || 'Untitled',
        summary: clean(k.summary, 400), detail: [k.detail, facts].filter(Boolean).join('\n\n').slice(0, 1500),
        node_type: 'leaf', order_index: i }), cardId: k.card_id });
    });
  });
  return rows;
}

// ── built by AI ────────────────────────────────────────────────

const GEN_LIMITS = { columns: 8, cardsPerColumn: 12, cards: 80, tagsPerCard: 4, instruction: 4000 };

const BOARD_PROMPT = `You plan work as a KANBAN BOARD.

Respond ONLY with JSON of this exact shape:
{"title":"<3-7 word board title>",
 "description":"<one sentence: what this board plans>",
 "columns":[
   {"title":"<column name>",
    "cards":[{"title":"<verb-first task, under 10 words>","summary":"<one line>",
              "detail":"<optional: steps or acceptance notes>",
              "tags":["<1-3 word area>"],"priority":"high|medium|low|null",
              "startDate":"YYYY-MM-DD|null","endDate":"YYYY-MM-DD|null"}]}
 ]}

Rules:
- Columns follow what the user asked for. If they name stages, phases, people or products as the columns, use those.
  Otherwise use workflow stages such as Backlog / To do / In progress / Review / Done.
- A timeframe ("in 6 weeks", "by March") is NOT a reason for week columns — it goes in the card dates.
  Only use time-period columns when the user explicitly asks for them, and then they must cover the WHOLE
  timeframe (group periods, e.g. "Weeks 1-2", rather than stopping early).
- 3 to 6 columns. Cards are concrete, doable tasks, never vague themes. 2 to 8 cards per column.
- With workflow-stage columns, most cards start in the first columns — do not invent finished work.
- Tags name the workstream or area. REUSE the same tag labels across cards so they group; at most 3 per card.
  When the user lists areas (design, backend, marketing…), every area gets cards and its own tag.
- Priority only where it genuinely differs; use null otherwise.
- Dates only when the user gave a timeframe or deadline. Spread the cards across the WHOLE timeframe, in a
  sensible order, starting from TODAY — never in the past, never past the deadline. Otherwise null.
- No markdown, no HTML, no backslashes.`;

// Same JSON shape as a board, so normalizePlan and the inserts are shared —
// but "columns" are lanes (who does the work) and card order is work order.
const QUEUE_PROMPT = `You line up work as a WORK QUEUE: one lane per person (or team), and each lane is an ORDERED list —
the first task is what that person does NOW, the second is NEXT, then the rest in order.

Respond ONLY with JSON of this exact shape:
{"title":"<3-7 word title>",
 "description":"<one sentence: what this queue lines up>",
 "columns":[
   {"title":"<person, role or team>",
    "cards":[{"title":"<verb-first task, under 10 words>","summary":"<one line>",
              "detail":"<optional: steps or notes>",
              "tags":["<1-3 word area>"],"priority":"high|medium|low|null",
              "startDate":"YYYY-MM-DD|null","endDate":"YYYY-MM-DD|null"}]}
 ]}

Rules:
- One entry in "columns" per person, role or team the user names, using their names. If they name nobody,
  use a single lane called "Me".
- Lanes are WHO does the work — never stages such as To do / In progress / Done.
- Within a lane, cards are in the ORDER they should be done: what others wait on first, then the most urgent,
  then the rest. 2 to 10 cards per lane. Cards are concrete, doable tasks, never vague themes.
- Tags name the workstream or area. REUSE the same tag labels across lanes so they group; at most 3 per card.
- Priority only where it genuinely differs; use null otherwise.
- Dates only when the user gave a timeframe or deadline: spread each lane's cards across it in order, starting
  from TODAY — never in the past, never past the deadline. Otherwise null.
- No markdown, no HTML, no backslashes.`;

const genDate = (v) => {
  const s = String(v == null ? '' : v).slice(0, 10);
  return isRealDate(s) ? s : null;
};

/**
 * Turn what the model produced into a bounded plan. Pure; exported for tests.
 * Shape is enforced, not trusted: counts clamped, bad dates and priorities
 * dropped, an end before its start dropped, empty columns kept (a "Done"
 * column with nothing in it yet is honest).
 */
function normalizePlan(raw, fallbackTitle = 'New board') {
  const columns = [];
  let total = 0;
  for (const c of (Array.isArray(raw?.columns) ? raw.columns : []).slice(0, GEN_LIMITS.columns)) {
    const title = clean(c && (c.title || c.name), 120);
    if (!title) continue;
    const cards = [];
    for (const k of (Array.isArray(c.cards) ? c.cards : []).slice(0, GEN_LIMITS.cardsPerColumn)) {
      if (total >= GEN_LIMITS.cards) break;
      const cardTitle = clean(typeof k === 'string' ? k : k && (k.title || k.name), LIMITS.title);
      if (!cardTitle) continue;
      const p = String(k.priority || '').toLowerCase();
      let startDate = genDate(k.startDate), endDate = genDate(k.endDate);
      if (startDate && endDate && endDate < startDate) endDate = null;
      cards.push({
        title: cardTitle,
        summary: cleanLong(k.summary, LIMITS.summary),
        detail: cleanLong(k.detail, LIMITS.detail),
        tags: (Array.isArray(k.tags) ? k.tags : []).map(t => clean(typeof t === 'string' ? t : t && t.label, LIMITS.tagLabel))
          .filter(Boolean).slice(0, GEN_LIMITS.tagsPerCard),
        priority: PRIORITIES.has(p) ? p : null,
        startDate, endDate
      });
      total++;
    }
    columns.push({ title, cards });
  }
  return {
    title: clean(raw?.title, LIMITS.title) || clean(fallbackTitle, LIMITS.title) || 'New board',
    description: cleanLong(raw?.description, 2000),
    columns,
    cardCount: total
  };
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_READ_PROMPT = `The user wants a KANBAN BOARD built from this image. It may be a photo of a whiteboard or sticky notes,
a handwritten list, a screenshot of another board, a sketch, a timetable, a document or a slide.

Write down, as plain text, everything in it that could become part of a plan:
- every heading, list, column or group, and which items sit under each one
- every task, item or note, in the image's own words
- any names, owners, dates, deadlines, priorities, labels or arrows that link items
- colours ONLY when a legend or the layout shows they mean something (e.g. "red = urgent"); otherwise leave colours out
Keep the image's structure: if it already has columns or lists, say so and keep items under them.
If handwriting is unclear, give your best reading. If the image has nothing plan-like, describe what it shows.
Plain text only, no preamble.`;

/**
 * What the image says, as text, via a vision model (Gemini — see the vision
 * route in inference.js). Transcribing first and planning second keeps the
 * board itself on the same JSON path as a typed instruction, which is far
 * steadier than asking a vision model for structured output directly.
 */
async function readImageForPlan(userId, image) {
  if (!image || !image.buffer || !image.buffer.length) return '';
  const mimetype = String(image.mimetype || '').toLowerCase();
  if (!IMAGE_TYPES.has(mimetype)) throw bad('Use a PNG, JPEG, WebP or GIF image');
  if (image.buffer.length > IMAGE_MAX_BYTES) throw bad('That image is over 8 MB — use a smaller one');
  const { runInference } = require('./inference');
  // No userId, on purpose — the same as chat attachments (attachments.js):
  // reading an image runs on the shared vision key. With a userId, a BYOK user
  // who holds a DeepSeek key but no Gemini key, and whose shared allowance is
  // spent, resolves to NO vision provider at all ("No vision-capable provider",
  // seen 2026-09-28). Planning the board from the transcript still bills the
  // user's own keys in generateBoard.
  const ask = () => runInference({
    workload: 'vision', feature: 'vision', temperature: 0.1,
    messages: [{ role: 'user', content: [
      { type: 'text', text: IMAGE_READ_PROMPT },
      { type: 'image_url', image_url: { url: `data:${mimetype};base64,${image.buffer.toString('base64')}` } }
    ] }]
  });
  // Gemini is the only vision provider, and its "model overloaded" 503s come in
  // short bursts (measured 2026-09-28: two 503s, then an answer). inference.js
  // already retries each model; one more full pass after a pause rides out a
  // burst that outlasted those retries.
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await ask();
      break;
    } catch (e) {
      console.warn(`⚠️ Board from image: vision attempt ${attempt} failed — ${e.message}`);
      if (attempt >= 2) {
        throw new BoardError(503, "Google's image reader is busy right now — try again in a minute, or describe the plan in words");
      }
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  const text = cleanLong(res && res.content, 8000);
  if (!text) throw new BoardError(422, 'Nothing readable was found in that image');
  return text;
}

const PLAN_FILES_MAX = 5;
const PLAN_SOURCE_BUDGET = 14000;   // characters of source across every file, split evenly

/**
 * Every attached file as text. Images go through the vision transcription
 * above; documents through the same extractor chat attachments use (PDF, DOCX,
 * text, Markdown, CSV, JSON…). A file that yields nothing fails the request by
 * name — a board silently built from four of five files would be wrong.
 */
async function readFilesForPlan(files) {
  const list = (files || []).filter(f => f && f.buffer && f.buffer.length);
  if (list.length > PLAN_FILES_MAX) throw bad(`Attach at most ${PLAN_FILES_MAX} files`);
  const each = Math.floor(PLAN_SOURCE_BUDGET / Math.max(list.length, 1));
  const { extractFromUpload } = require('./attachments');
  // Sequential on purpose: two vision calls at once double the chance of
  // meeting Gemini's 503 bursts, and a board request is not latency-critical.
  const out = [];
  for (const f of list) {
    const name = clean(f.originalname || 'file', 120);
    if (String(f.mimetype || '').startsWith('image/')) {
      out.push({ name, kind: 'IMAGE', text: (await readImageForPlan(null, f)).slice(0, each) });
      continue;
    }
    const x = await extractFromUpload(f);
    const text = String(x.text || '');
    if (x.kind !== 'document' || /^\[(Unsupported|Could not|File appears)/.test(text)) {
      throw bad(`Could not read ${q(name)} — use a PDF, Word, PowerPoint, Excel, text, Markdown or CSV file, or an image`);
    }
    out.push({ name, kind: 'DOCUMENT', text: text.slice(0, each) });
  }
  return out;
}

/**
 * Build a board from a plain-language instruction ("launch plan for the POS
 * app, 6 weeks, design / backend / marketing"), from files (images, PDFs,
 * Word documents, text), or both. One planning call — plus one vision call per
 * image — then the same batched inserts as fromMindMap. kind 'queue' plans
 * lanes of people with their tasks in order instead of workflow columns.
 */
async function generateBoard(userId, instruction, { today = new Date(), image = null, files = [], kind = 'kanban' } = {}) {
  const queue = kind === 'queue';
  if (!KINDS.has(kind || 'kanban')) throw bad('kind must be kanban or queue');
  const text = cleanLong(instruction, GEN_LIMITS.instruction);
  const all = [...(image ? [image] : []), ...(files || [])];
  if (text.length < 3 && !all.length) {
    throw bad(queue ? 'Say who does what, or add a file or image' : 'Describe what the board should plan, or add a file or image');
  }
  const sources = await readFilesForPlan(all);
  const { runInference } = require('./inference');
  const iso = isoDate(today);
  const what = queue ? 'queue' : 'board';
  const ask = [
    `TODAY: ${iso}`,
    `WHAT TO PLAN:\n${text || `Turn the attached files into a ${what}.`}`,
    sources.length ? 'FROM THE FILES THE USER ATTACHED:\n\n' +
      sources.map(s => `### ${s.kind}: ${s.name}${s.kind === 'IMAGE' ? ' (transcribed)' : ''}\n${s.text}`).join('\n\n') + '\n\n' +
      (queue
        ? 'Build the queue from these files. Where they name people, owners or teams, those are the lanes; ' +
          'their tasks or action points are the cards, in their own words, in the order they should be done. '
        : 'Build the board from these files. Where they already have columns, lists, phases or groups, those are the columns; ' +
          'their items, tasks, requirements or action points are the cards, in their own words. ') +
      'Do not drop items, and do not ' +
      'invent work they do not imply beyond what the user asked for above. A deadline or dates written in a file count as ' +
      "the user's timeframe. Never put sticky-note or marker colours in card text." : ''
  ].filter(Boolean).join('\n\n');
  const res = await runInference({
    messages: [
      { role: 'system', content: queue ? QUEUE_PROMPT : BOARD_PROMPT },
      { role: 'user', content: ask }
    ],
    temperature: 0.4, jsonMode: true, feature: 'board', userId
  });
  let raw;
  try {
    raw = parseJsonLoose(res.content);
  } catch (e) {
    throw new BoardError(502, `The AI answered with something that was not a ${what} — try again`);
  }
  const plan = normalizePlan(raw, text.slice(0, 60));
  // One lane is a fine queue (just your own); one column is not much of a board.
  if (plan.columns.length < (queue ? 1 : 2) || plan.cardCount < 1) {
    throw new BoardError(422, `The AI could not turn that into a ${what} — add a little more about ${queue ? 'who does what' : 'what you are planning'}`);
  }

  const boardId = await createBoard(userId, {
    title: plan.title, description: plan.description, columns: plan.columns.map(c => c.title), kind: queue ? 'queue' : 'kanban',
    origin: sources.length ? `built this ${what} with AI from ${sources.map(s => q(s.name)).join(', ')}` : `built this ${what} with AI`,
    originDetails: { instruction: text.slice(0, 300), files: sources.map(s => s.name) }
  });
  try {
    const cols = (await query('SELECT column_id FROM board_columns WHERE board_id = $1 ORDER BY order_index', [boardId])).rows;
    // One palette for the whole board, so a tag is the same colour on every card.
    const palette = planPalette(plan);
    const colorOf = new Map(palette.map(t => [t.label.toLowerCase(), t.color]));
    const rows = { id: [], col: [], title: [], summary: [], detail: [], tags: [], priority: [], start: [], end: [], order: [] };
    plan.columns.forEach((c, ci) => c.cards.forEach((k, i) => {
      rows.id.push('bcd_' + uuidv4());
      rows.col.push(cols[ci].column_id);
      rows.title.push(k.title);
      rows.summary.push(k.summary);
      rows.detail.push(k.detail);
      rows.tags.push(JSON.stringify(k.tags.map(label => ({ label, color: colorOf.get(label.toLowerCase()) })).filter(t => t.color)));
      rows.priority.push(k.priority);
      rows.start.push(k.startDate);
      rows.end.push(k.endDate);
      rows.order.push(i);
    }));
    if (rows.id.length) {
      await query(`
        INSERT INTO board_cards (card_id, board_id, column_id, title, summary, detail, tags, priority,
                                 start_date, end_date, order_index)
        SELECT t.id, $1, t.col, t.title, t.summary, t.detail, t.tags::jsonb, t.priority, t.sd::date, t.ed::date, t.ord
          FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                      $9::text[], $10::text[], $11::int[])
               AS t(id, col, title, summary, detail, tags, priority, sd, ed, ord)
      `, [boardId, rows.id, rows.col, rows.title, rows.summary, rows.detail, rows.tags, rows.priority,
          rows.start, rows.end, rows.order]);
    }
    if (palette.length) await query('UPDATE boards SET tag_palette = $2 WHERE board_id = $1', [boardId, JSON.stringify(palette)]);
  } catch (err) {
    await query('DELETE FROM boards WHERE board_id = $1', [boardId]).catch(() => {});
    throw err;
  }
  return { boardId, title: plan.title, cardCount: plan.cardCount };
}

/** Every distinct tag in a plan, coloured in order of first use. Pure; exported for tests. */
function planPalette(plan) {
  const seen = new Map();
  for (const c of plan.columns) for (const k of c.cards) for (const label of k.tags) {
    const key = label.toLowerCase();
    if (!seen.has(key) && seen.size < 60) seen.set(key, { label, color: TAG_COLORS[seen.size % TAG_COLORS.length] });
  }
  return [...seen.values()];
}

function parseJsonLoose(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (err) {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw err;
    return JSON.parse(m[0]);
  }
}

module.exports = {
  TAG_COLORS, COLUMN_COLORS, LIMITS, KINDS, BoardError,
  listBoards, getBoard, requireBoard, createBoard, updateBoard, deleteBoard,
  addColumn, updateColumn, deleteColumn, orderColumns,
  addCard, updateCard, setCardDone, deleteCard, reorderCards,
  requireCard, insertAttachment, attachUpload, getAttachment, deleteAttachment, attachmentsWithData,
  fromMindMap, boardForMap, toMindMap, generateBoard,
  listActivity, listMembers, addMember, removeMember, joinByLink, boardStamp, record, readFilesForPlan,
  normTags, isoDate, normalizePlan, planPalette, mapRowsFromBoard, describeCardChange
};
