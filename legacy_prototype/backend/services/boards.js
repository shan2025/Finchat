// services/boards.js — Kanban boards (migration 056).
//
// A board is its own artifact, not a view of a mind map: columns are whatever
// the user names them (a product each, or To do / Doing / Done), and cards
// carry dates, priority and colored tags. What boards share with mind maps is
// everything AROUND the content — files, notes, links, share links — and those
// reuse the same services (mindMapDocFile, linkAttach, attachments).
//
// Ownership is enforced here by always resolving a board with its user_id; a
// board, column, card or attachment that is not the caller's is "not found".
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

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

async function requireBoard(boardId, userId) {
  const r = await query('SELECT * FROM boards WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
  if (!r.rows.length) throw notFound('Board');
  return r.rows[0];
}

async function listBoards(userId) {
  const r = await query(`
    SELECT b.board_id, b.title, b.description, b.updated_at, b.created_at, b.source_map_id,
           (SELECT COUNT(*) FROM board_columns c WHERE c.board_id = b.board_id)::int AS column_count,
           (SELECT COUNT(*) FROM board_cards k WHERE k.board_id = b.board_id)::int AS card_count
      FROM boards b WHERE b.user_id = $1 ORDER BY b.updated_at DESC LIMIT 100
  `, [userId]);
  return r.rows;
}

/** The whole board. `userId` null skips the ownership check — only share routes, which resolved a token, pass null. */
async function getBoard(boardId, userId) {
  const board = userId === null
    ? (await query('SELECT * FROM boards WHERE board_id = $1', [boardId])).rows[0]
    : await requireBoard(boardId, userId);
  if (!board) throw notFound('Board');
  const [cols, cards, atts] = await Promise.all([
    query('SELECT * FROM board_columns WHERE board_id = $1 ORDER BY order_index, created_at', [boardId]),
    query('SELECT * FROM board_cards WHERE board_id = $1 ORDER BY order_index, created_at', [boardId]),
    query(`SELECT ${ATT_COLS} FROM board_attachments WHERE board_id = $1 ORDER BY order_index, created_at`, [boardId])
  ]);
  return { board, columns: cols.rows, cards: cards.rows, attachments: atts.rows };
}

async function touch(boardId) {
  await query('UPDATE boards SET updated_at = now() WHERE board_id = $1', [boardId]);
}

// ── boards ─────────────────────────────────────────────────────

async function createBoard(userId, { title, description, columns } = {}) {
  const boardId = 'brd_' + uuidv4();
  await query('INSERT INTO boards (board_id, user_id, title, description) VALUES ($1,$2,$3,$4)',
    [boardId, userId, clean(title, LIMITS.title) || 'Untitled board', cleanLong(description, 2000)]);
  const names = Array.isArray(columns) && columns.length
    ? columns.map(c => clean(typeof c === 'string' ? c : c && c.title, 120)).filter(Boolean).slice(0, LIMITS.columns)
    : ['To do', 'In progress', 'Done'];
  // One statement: every round trip to the database costs ~125ms from here.
  if (names.length) {
    await query(`
      INSERT INTO board_columns (column_id, board_id, title, color, order_index)
      SELECT t.id, $1, t.title, t.color, t.i - 1
        FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS t(id, title, color, i)
    `, [boardId, names.map(() => 'bcl_' + uuidv4()), names,
        names.map((_, i) => COLUMN_COLORS[i % COLUMN_COLORS.length])]);
  }
  return boardId;
}

async function updateBoard(boardId, userId, { title, description }) {
  await requireBoard(boardId, userId);
  await query(`UPDATE boards SET title = COALESCE($2, title), description = COALESCE($3, description),
               updated_at = now() WHERE board_id = $1`,
    [boardId, title !== undefined ? (clean(title, LIMITS.title) || 'Untitled board') : null,
     description !== undefined ? cleanLong(description, 2000) : null]);
}

async function deleteBoard(boardId, userId) {
  const r = await query('DELETE FROM boards WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
  if (!r.rowCount) throw notFound('Board');
}

// ── columns ────────────────────────────────────────────────────

async function addColumn(boardId, userId, { title, color }) {
  await requireBoard(boardId, userId);
  const count = await query('SELECT COUNT(*)::int AS n, COALESCE(MAX(order_index)+1,0) AS next FROM board_columns WHERE board_id = $1', [boardId]);
  if (count.rows[0].n >= LIMITS.columns) throw bad(`A board holds at most ${LIMITS.columns} columns`);
  const columnId = 'bcl_' + uuidv4();
  await query('INSERT INTO board_columns (column_id, board_id, title, color, order_index) VALUES ($1,$2,$3,$4,$5)',
    [columnId, boardId, clean(title, 120) || 'New column',
     HEX.test(color || '') ? color : COLUMN_COLORS[count.rows[0].n % COLUMN_COLORS.length], count.rows[0].next]);
  await touch(boardId);
  return columnId;
}

async function updateColumn(boardId, userId, columnId, { title, color }) {
  await requireBoard(boardId, userId);
  if (color !== undefined && color !== null && !HEX.test(color)) throw bad('color must be #rrggbb');
  const r = await query(`UPDATE board_columns SET title = COALESCE($3, title), color = COALESCE($4, color)
                         WHERE column_id = $1 AND board_id = $2`,
    [columnId, boardId, title !== undefined ? (clean(title, 120) || 'Untitled') : null, color || null]);
  if (!r.rowCount) throw notFound('Column');
  await touch(boardId);
}

async function deleteColumn(boardId, userId, columnId) {
  await requireBoard(boardId, userId);
  const r = await query('DELETE FROM board_columns WHERE column_id = $1 AND board_id = $2', [columnId, boardId]);
  if (!r.rowCount) throw notFound('Column');
  await touch(boardId);
}

/** Set column order from a full list of ids. Unknown ids are ignored. */
async function orderColumns(boardId, userId, columnIds) {
  await requireBoard(boardId, userId);
  const ids = (Array.isArray(columnIds) ? columnIds : []).filter(x => typeof x === 'string').slice(0, LIMITS.columns);
  if (!ids.length) return;
  await query(`UPDATE board_columns c SET order_index = t.i
                 FROM unnest($2::text[]) WITH ORDINALITY AS t(id, i)
                WHERE c.column_id = t.id AND c.board_id = $1`, [boardId, ids]);
  await touch(boardId);
}

// ── cards ──────────────────────────────────────────────────────

async function requireColumn(boardId, columnId) {
  const r = await query('SELECT column_id FROM board_columns WHERE column_id = $1 AND board_id = $2', [columnId, boardId]);
  if (!r.rows.length) throw bad('columnId is not a column on this board');
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

async function addCard(boardId, userId, input = {}) {
  const board = await requireBoard(boardId, userId);
  await requireColumn(boardId, input.columnId);
  const n = await query('SELECT COUNT(*)::int AS n FROM board_cards WHERE board_id = $1', [boardId]);
  if (n.rows[0].n >= LIMITS.cards) throw bad(`A board holds at most ${LIMITS.cards} cards`);
  const f = cardFields({ title: input.title || 'Untitled card', ...input }, board);
  if (f.start_date && f.end_date && f.end_date < f.start_date) throw bad('endDate is before startDate');
  const next = await query('SELECT COALESCE(MAX(order_index)+1,0) AS next FROM board_cards WHERE column_id = $1', [input.columnId]);
  const cardId = 'bcd_' + uuidv4();
  await query(`
    INSERT INTO board_cards (card_id, board_id, column_id, title, summary, detail, tags, priority,
                             start_date, end_date, color, order_index)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [cardId, boardId, input.columnId, f.title, f.summary || '', f.detail || '', JSON.stringify(f.tags || []),
      f.priority || null, f.start_date || null, f.end_date || null, f.color || null, Number(next.rows[0].next) || 0]);
  await saveTags(board, f.tags);
  await touch(boardId);
  return cardId;
}

async function updateCard(boardId, userId, cardId, input = {}) {
  const board = await requireBoard(boardId, userId);
  const cur = (await query('SELECT * FROM board_cards WHERE card_id = $1 AND board_id = $2', [cardId, boardId])).rows[0];
  if (!cur) throw notFound('Card');
  const f = cardFields(input, board);
  const start = f.start_date !== undefined ? f.start_date : (cur.start_date ? isoDate(cur.start_date) : null);
  const end = f.end_date !== undefined ? f.end_date : (cur.end_date ? isoDate(cur.end_date) : null);
  if (start && end && end < start) throw bad('endDate is before startDate');
  if (input.columnId !== undefined && input.columnId !== cur.column_id) {
    await requireColumn(boardId, input.columnId);
    f.column_id = input.columnId;
  }
  const keys = Object.keys(f);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const vals = keys.map(k => (k === 'tags' ? JSON.stringify(f[k]) : f[k]));
  await query(`UPDATE board_cards SET ${sets.join(', ')}, updated_at = now() WHERE card_id = $1 AND board_id = $2`,
    [cardId, boardId, ...vals]);
  await saveTags(board, f.tags);
  await touch(boardId);
}

function isoDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  // pg returns DATE as a local-midnight Date; format it back without a UTC shift.
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function deleteCard(boardId, userId, cardId) {
  await requireBoard(boardId, userId);
  const r = await query('DELETE FROM board_cards WHERE card_id = $1 AND board_id = $2', [cardId, boardId]);
  if (!r.rowCount) throw notFound('Card');
  await touch(boardId);
}

/**
 * Persist a drag: the full card order of every column the drag touched.
 * One statement, so a card can never be half-moved; every id must be a card on
 * this board and every column a column on it, or nothing is written.
 */
async function reorderCards(boardId, userId, columns) {
  await requireBoard(boardId, userId);
  const list = Array.isArray(columns) ? columns.slice(0, LIMITS.columns) : [];
  const ids = [], cols = [], idx = [];
  for (const c of list) {
    if (!c || typeof c.columnId !== 'string' || !Array.isArray(c.cardIds)) continue;
    c.cardIds.slice(0, LIMITS.cards).forEach((id, i) => { ids.push(String(id)); cols.push(c.columnId); idx.push(i); });
  }
  if (!ids.length) return;
  const colSet = [...new Set(cols)];
  const okCols = await query('SELECT column_id FROM board_columns WHERE board_id = $1 AND column_id = ANY($2::text[])', [boardId, colSet]);
  if (okCols.rows.length !== colSet.length) throw bad('a column in that move is not on this board');
  const okCards = await query('SELECT COUNT(*)::int AS n FROM board_cards WHERE board_id = $1 AND card_id = ANY($2::text[])', [boardId, ids]);
  if (okCards.rows[0].n !== new Set(ids).size) throw bad('a card in that move is not on this board');
  await query(`
    UPDATE board_cards k SET column_id = t.col, order_index = t.i, updated_at = now()
      FROM unnest($2::text[], $3::text[], $4::int[]) AS t(id, col, i)
     WHERE k.card_id = t.id AND k.board_id = $1
  `, [boardId, ids, cols, idx]);
  await touch(boardId);
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
  return r.rows[0];
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
  const r = await query('DELETE FROM board_attachments WHERE attachment_id = $1 AND board_id = $2', [attachmentId, boardId]);
  if (!r.rowCount) throw notFound('Attachment');
  await touch(boardId);
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
    columns: columnsSpec.map(c => c.title)
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
  const { board, columns, cards } = await getBoard(boardId, userId);
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
    await query('UPDATE boards SET source_map_id = $2 WHERE board_id = $1', [boardId, mapId]);
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
        Array.isArray(k.tags) && k.tags.length ? `Tags: ${k.tags.map(t => t.label).join(', ')}` : ''
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

/**
 * Build a board from a plain-language instruction ("launch plan for the POS
 * app, 6 weeks, design / backend / marketing"). One model call, then the same
 * batched inserts as fromMindMap.
 */
async function generateBoard(userId, instruction, { today = new Date() } = {}) {
  const text = cleanLong(instruction, GEN_LIMITS.instruction);
  if (text.length < 3) throw bad('Describe what the board should plan');
  const { runInference } = require('./inference');
  const iso = isoDate(today);
  const res = await runInference({
    messages: [
      { role: 'system', content: BOARD_PROMPT },
      { role: 'user', content: `TODAY: ${iso}\n\nWHAT TO PLAN:\n${text}` }
    ],
    temperature: 0.4, jsonMode: true, feature: 'board', userId
  });
  let raw;
  try {
    raw = parseJsonLoose(res.content);
  } catch (e) {
    throw new BoardError(502, 'The AI answered with something that was not a board — try again');
  }
  const plan = normalizePlan(raw, text.slice(0, 60));
  if (plan.columns.length < 2 || plan.cardCount < 1) {
    throw new BoardError(422, 'The AI could not turn that into a board — add a little more about what you are planning');
  }

  const boardId = await createBoard(userId, { title: plan.title, description: plan.description, columns: plan.columns.map(c => c.title) });
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
  TAG_COLORS, COLUMN_COLORS, LIMITS, BoardError,
  listBoards, getBoard, requireBoard, createBoard, updateBoard, deleteBoard,
  addColumn, updateColumn, deleteColumn, orderColumns,
  addCard, updateCard, deleteCard, reorderCards,
  requireCard, insertAttachment, getAttachment, deleteAttachment, attachmentsWithData,
  fromMindMap, boardForMap, toMindMap, generateBoard,
  normTags, isoDate, normalizePlan, planPalette, mapRowsFromBoard
};
