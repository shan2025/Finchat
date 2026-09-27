// tools/BoardsTool.js — let an agent read and fill the user's Kanban boards.
//
// The point of it: "put the Duxbe POS spec and the pricing sheet on the POS
// card" — the agent resolves the names in Drive (names and links only), and
// attaches the links to the card. Everything is scoped to the executing user's
// own boards through services/boards.js; there is no way to reach anyone else's.
//
// Boards, columns and cards are addressed by id OR by name, so the agent can
// act on what the user said without a lookup round-trip first.
const Boards = require('../services/boards');
const { prepareLinks } = require('../services/linkAttach');

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
  }
  return { action: 'list' };
}

/** Exact id, then exact name, then the one name that contains it. Ambiguity is an error, not a guess. */
function pick(list, want, idKey, what) {
  const w = String(want || '').trim();
  if (!w) throw new Error(`Which ${what}? Give its name or id.`);
  const byId = list.find(x => x[idKey] === w);
  if (byId) return byId;
  const lw = w.toLowerCase();
  const exact = list.filter(x => String(x.title || '').toLowerCase() === lw);
  if (exact.length === 1) return exact[0];
  const partial = list.filter(x => String(x.title || '').toLowerCase().includes(lw));
  if (partial.length === 1) return partial[0];
  const names = (exact.length > 1 ? exact : partial.length ? partial : list).slice(0, 12).map(x => `"${x.title}"`).join(', ');
  throw new Error(partial.length > 1 || exact.length > 1
    ? `More than one ${what} matches "${w}": ${names}. Say which.`
    : `No ${what} called "${w}". There is: ${names || 'none'}.`);
}

async function findBoard(userId, want) {
  const boards = await Boards.listBoards(userId);
  return pick(boards, want, 'board_id', 'board');
}

/** Drive names → links (best match each). Unresolved names are reported, never invented. */
async function driveLinks(userId, names) {
  if (!Array.isArray(names) || !names.length) return { links: [], missing: [] };
  const Drive = require('../services/googleDrive');
  const results = await Drive.resolveNames(userId, names.map(String));
  return {
    links: results.filter(r => r.match).map(r => ({ url: r.match.url, title: r.match.title })),
    missing: results.filter(r => !r.match).map(r => r.name)
  };
}

async function attach(userId, boardId, cardId, { links = [], driveNames = [] }) {
  let drive = { links: [], missing: [] };
  let driveError = null;
  try {
    drive = await driveLinks(userId, driveNames);
  } catch (err) {
    driveError = err.message;
  }
  const asObjects = (Array.isArray(links) ? links : [links]).filter(Boolean)
    .map(l => (typeof l === 'string' ? { url: l } : l));
  const prepared = await prepareLinks(userId, { links: [...asObjects, ...drive.links] });
  const saved = [];
  for (const l of prepared.links) {
    await Boards.insertAttachment({ boardId, cardId, userId, kind: 'link', filename: l.title, url: l.url, provider: l.provider });
    saved.push({ title: l.title, url: l.url });
  }
  return { attached: saved, notFoundInDrive: drive.missing, rejected: prepared.rejected, driveError };
}

async function execute(input, context = {}) {
  const p = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') throw new Error('Boards need a signed-in user context');
  const action = p.action || 'list';

  if (action === 'list') {
    const boards = await Boards.listBoards(userId);
    return { boards: boards.map(b => ({ id: b.board_id, title: b.title, columns: b.column_count, cards: b.card_count })) };
  }

  if (action === 'create_board') {
    const boardId = await Boards.createBoard(userId, { title: p.title, description: p.description, columns: p.columns });
    return { created: true, boardId, link: `/finchat_boards.html?board=${boardId}` };
  }

  const b = await findBoard(userId, p.board);
  const full = await Boards.getBoard(b.board_id, userId);

  if (action === 'get') {
    const colName = new Map(full.columns.map(c => [c.column_id, c.title]));
    return {
      board: full.board.title,
      columns: full.columns.map(c => c.title),
      cards: full.cards.map(k => ({
        id: k.card_id, column: colName.get(k.column_id), title: k.title, summary: k.summary,
        tags: (k.tags || []).map(t => t.label), priority: k.priority,
        dates: [k.start_date && Boards.isoDate(k.start_date), k.end_date && Boards.isoDate(k.end_date)].filter(Boolean).join(' → ') || null,
        attachments: full.attachments.filter(a => a.card_id === k.card_id).map(a => a.url ? `${a.filename} <${a.url}>` : a.filename)
      })),
      link: `/finchat_boards.html?board=${b.board_id}`
    };
  }

  const cardInput = {
    title: p.title, summary: p.summary, detail: p.detail, tags: p.tags, priority: p.priority,
    startDate: p.startDate, endDate: p.endDate
  };
  for (const k of Object.keys(cardInput)) if (cardInput[k] === undefined) delete cardInput[k];

  if (action === 'add_card') {
    const col = pick(full.columns, p.column, 'column_id', 'column');
    const cardId = await Boards.addCard(b.board_id, userId, { ...cardInput, columnId: col.column_id });
    const extra = (p.links || p.driveNames) ? await attach(userId, b.board_id, cardId, p) : null;
    return { added: true, cardId, column: col.title, ...(extra || {}), link: `/finchat_boards.html?board=${b.board_id}` };
  }

  if (action === 'update_card') {
    const card = pick(full.cards, p.card, 'card_id', 'card');
    const patch = { ...cardInput };
    if (p.column) patch.columnId = pick(full.columns, p.column, 'column_id', 'column').column_id;
    await Boards.updateCard(b.board_id, userId, card.card_id, patch);
    return { updated: true, cardId: card.card_id };
  }

  if (action === 'attach') {
    const cardId = p.card ? pick(full.cards, p.card, 'card_id', 'card').card_id : null;
    const out = await attach(userId, b.board_id, cardId, p);
    return { ...out, card: cardId ? full.cards.find(k => k.card_id === cardId).title : '(the board itself)',
      note: 'Tell the user what was attached, and name anything not found in Drive — never invent a link.' };
  }

  throw new Error(`Unknown boards action "${action}". Use list, get, create_board, add_card, update_card or attach.`);
}

module.exports = { execute, pick };
