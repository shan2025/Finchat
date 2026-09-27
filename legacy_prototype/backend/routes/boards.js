// routes/boards.js — /api/boards, Kanban boards (services/boards.js).
//
//   GET    /                                  the caller's boards
//   POST   /                                  {title, description?, columns?: [title]}
//   POST   /from-map                          {mapId, reuse?} → a board built from a mind map (reuse: its existing one)
//   POST   /generate                          {instruction} → a board the AI plans
//   POST   /:boardId/mind-map                 the board as a mind map (its paired map if it has one)
//   GET    /:boardId                          board + columns + cards + attachments
//   PATCH  /:boardId                          {title?, description?}
//   DELETE /:boardId
//
//   POST   /:boardId/columns                  {title, color?}
//   PATCH  /:boardId/columns/:columnId        {title?, color?}
//   DELETE /:boardId/columns/:columnId        (its cards go with it)
//   POST   /:boardId/columns/order            {columnIds: [...]}
//
//   POST   /:boardId/cards                    {columnId, title, summary?, detail?, tags?, priority?, startDate?, endDate?, color?}
//   PATCH  /:boardId/cards/:cardId            any of the above
//   DELETE /:boardId/cards/:cardId
//   POST   /:boardId/cards/order              {columns: [{columnId, cardIds: [...]}]} — a drag
//
//   POST   /:boardId/attachments              multipart "files" (+ cardId)
//   POST   /:boardId/attachments/text         {cardId?, title?, text}
//   POST   /:boardId/attachments/links        {cardId?, links?: [{url,title?}], text?}
//   GET    /:boardId/attachments/:id          one attachment + its text
//   GET    /:boardId/attachments/:id/file     view it, or ?download=1
//   DELETE /:boardId/attachments/:id
//
//   GET    /:boardId/shares  ·  POST /:boardId/shares {includeDocs, expiresInDays}  ·  DELETE /:boardId/shares/:shareId
//
// Someone else's board is 404, never 403 — a 403 would confirm it exists.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const Boards = require('../services/boards');
const { extractFromUpload } = require('../services/attachments');
const { sendDocFile, capabilities } = require('../services/cognitive/mindMapDocFile');
const { prepareLinks, linkView } = require('../services/linkAttach');
const { shareLinks } = require('../services/shareLinks');

const shares = shareLinks({ table: 'board_shares', idCol: 'board_id', prefix: 'bsh', page: 'finchat_board_share.html' });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 6 } });
const DB_MAX_BYTES = Number(process.env.MIND_MAP_DOC_DB_MAX_BYTES) || 8 * 1024 * 1024;

// ── views ──────────────────────────────────────────────────────

function attView(a) {
  return {
    attachmentId: a.attachment_id,
    cardId: a.card_id || null,
    kind: a.kind,
    filename: a.filename,
    mimetype: a.mimetype,
    size: Number(a.size_bytes) || 0,
    chars: a.char_count,
    createdAt: a.created_at,
    ...capabilities(a),
    link: a.kind === 'link' ? linkView(a.url, a.provider) : null
  };
}

function boardView({ board, columns, cards, attachments }, { includeDocs = true } = {}) {
  return {
    board: {
      boardId: board.board_id, title: board.title, description: board.description,
      tagPalette: board.tag_palette || [], sourceMapId: board.source_map_id || null,
      createdAt: board.created_at, updatedAt: board.updated_at
    },
    columns: columns.map(c => ({ columnId: c.column_id, title: c.title, color: c.color, order: c.order_index })),
    cards: cards.map(k => ({
      cardId: k.card_id, columnId: k.column_id, title: k.title, summary: k.summary, detail: k.detail,
      tags: k.tags || [], priority: k.priority, color: k.color, order: k.order_index,
      startDate: k.start_date ? Boards.isoDate(k.start_date) : null,
      endDate: k.end_date ? Boards.isoDate(k.end_date) : null
    })),
    includeDocs,
    attachments: includeDocs ? attachments.map(attView) : []
  };
}

/** One handler shape for every route: BoardError → its status, anything else → 500. */
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof Boards.BoardError || err.status === 400) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    console.error(`Boards ${label} error:`, err);
    res.status(500).json({ error: `Failed to ${label}` });
  }
};

// ── boards ─────────────────────────────────────────────────────

router.get('/', requireAuth, handle('list boards', async (req, res) => {
  const rows = await Boards.listBoards(req.user.id);
  res.json({ boards: rows.map(b => ({
    boardId: b.board_id, title: b.title, description: b.description, sourceMapId: b.source_map_id || null,
    columnCount: b.column_count, cardCount: b.card_count, updatedAt: b.updated_at
  })) });
}));

router.post('/', requireAuth, handle('create the board', async (req, res) => {
  const boardId = await Boards.createBoard(req.user.id, req.body || {});
  res.status(201).json({ ok: true, boardId });
}));

router.post('/from-map', requireAuth, handle('build a board from that map', async (req, res) => {
  const mapId = String(req.body?.mapId || '');
  if (!mapId) return res.status(400).json({ error: 'mapId is required' });
  // reuse: open the board already made from this map rather than a new copy.
  if (req.body?.reuse) {
    const existing = await Boards.boardForMap(req.user.id, mapId);
    if (existing) return res.json({ ok: true, boardId: existing, existed: true });
  }
  const boardId = await Boards.fromMindMap(req.user.id, mapId);
  res.status(201).json({ ok: true, boardId, existed: false });
}));

router.post('/generate', requireAuth, handle('build the board', async (req, res) => {
  const out = await Boards.generateBoard(req.user.id, req.body?.instruction);
  res.status(201).json({ ok: true, ...out });
}));

router.post('/:boardId/mind-map', requireAuth, handle('make a mind map from the board', async (req, res) => {
  const out = await Boards.toMindMap(req.user.id, req.params.boardId);
  res.status(out.existed ? 200 : 201).json({ ok: true, ...out });
}));

router.get('/:boardId', requireAuth, handle('load the board', async (req, res) => {
  res.json(boardView(await Boards.getBoard(req.params.boardId, req.user.id)));
}));

router.patch('/:boardId', requireAuth, handle('update the board', async (req, res) => {
  await Boards.updateBoard(req.params.boardId, req.user.id, req.body || {});
  res.json({ ok: true });
}));

router.delete('/:boardId', requireAuth, handle('delete the board', async (req, res) => {
  await Boards.deleteBoard(req.params.boardId, req.user.id);
  res.json({ ok: true });
}));

// ── columns ────────────────────────────────────────────────────

router.post('/:boardId/columns/order', requireAuth, handle('reorder columns', async (req, res) => {
  await Boards.orderColumns(req.params.boardId, req.user.id, req.body?.columnIds);
  res.json({ ok: true });
}));

router.post('/:boardId/columns', requireAuth, handle('add the column', async (req, res) => {
  const columnId = await Boards.addColumn(req.params.boardId, req.user.id, req.body || {});
  res.status(201).json({ ok: true, columnId });
}));

router.patch('/:boardId/columns/:columnId', requireAuth, handle('update the column', async (req, res) => {
  await Boards.updateColumn(req.params.boardId, req.user.id, req.params.columnId, req.body || {});
  res.json({ ok: true });
}));

router.delete('/:boardId/columns/:columnId', requireAuth, handle('delete the column', async (req, res) => {
  await Boards.deleteColumn(req.params.boardId, req.user.id, req.params.columnId);
  res.json({ ok: true });
}));

// ── cards ──────────────────────────────────────────────────────

router.post('/:boardId/cards/order', requireAuth, handle('move the card', async (req, res) => {
  await Boards.reorderCards(req.params.boardId, req.user.id, req.body?.columns);
  res.json({ ok: true });
}));

router.post('/:boardId/cards', requireAuth, handle('add the card', async (req, res) => {
  const cardId = await Boards.addCard(req.params.boardId, req.user.id, req.body || {});
  res.status(201).json({ ok: true, cardId });
}));

router.patch('/:boardId/cards/:cardId', requireAuth, handle('update the card', async (req, res) => {
  await Boards.updateCard(req.params.boardId, req.user.id, req.params.cardId, req.body || {});
  res.json({ ok: true });
}));

router.delete('/:boardId/cards/:cardId', requireAuth, handle('delete the card', async (req, res) => {
  await Boards.deleteCard(req.params.boardId, req.user.id, req.params.cardId);
  res.json({ ok: true });
}));

// ── attachments ────────────────────────────────────────────────

router.post('/:boardId/attachments', requireAuth, (req, res, next) => {
  upload.array('files', 6)(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Each file must be under 15 MB.' });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, handle('attach the files', async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded (field name: "files")' });
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const cardId = await Boards.requireCard(req.params.boardId, req.body?.cardId || null);
  const saved = [];
  for (const f of req.files) {
    const extracted = await extractFromUpload(f);
    const text = String(extracted.text || '');
    saved.push(attView(await Boards.insertAttachment({
      boardId: req.params.boardId, cardId, userId: req.user.id,
      kind: extracted.kind === 'image' ? 'image' : 'document',
      filename: String(f.originalname || 'file').slice(0, 200), mimetype: f.mimetype || '',
      size: f.size || 0, text, data: f.buffer && f.buffer.length <= DB_MAX_BYTES ? f.buffer : null
    })));
  }
  res.status(201).json({ ok: true, attachments: saved });
}));

router.post('/:boardId/attachments/text', requireAuth, handle('save the note', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const cardId = await Boards.requireCard(req.params.boardId, req.body?.cardId || null);
  const text = String(req.body?.text || '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    || (text.replace(/\s+/g, ' ').slice(0, 60) + (text.length > 60 ? '…' : ''));
  const a = await Boards.insertAttachment({
    boardId: req.params.boardId, cardId, userId: req.user.id, kind: 'text',
    filename: title, mimetype: 'text/plain', size: Buffer.byteLength(text, 'utf8'), text
  });
  res.status(201).json({ ok: true, attachment: attView(a) });
}));

router.post('/:boardId/attachments/links', requireAuth, handle('attach the links', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const cardId = await Boards.requireCard(req.params.boardId, req.body?.cardId || null);
  const { links, rejected } = await prepareLinks(req.user.id, { links: req.body?.links, text: req.body?.text });
  if (!links.length) return res.status(400).json({ error: 'No usable links — paste full http(s) addresses.', rejected });
  const saved = [];
  for (const l of links) {
    saved.push(attView(await Boards.insertAttachment({
      boardId: req.params.boardId, cardId, userId: req.user.id, kind: 'link',
      filename: l.title, url: l.url, provider: l.provider
    })));
  }
  res.status(201).json({ ok: true, attachments: saved, rejected });
}));

router.get('/:boardId/attachments/:id', requireAuth, handle('load the attachment', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const a = await Boards.getAttachment(req.params.boardId, req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  res.json({ attachment: { ...attView(a), text: a.extracted || '' } });
}));

router.get('/:boardId/attachments/:id/file', requireAuth, handle('load the file', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const a = await Boards.getAttachment(req.params.boardId, req.params.id, { withData: true });
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  res.set('Cache-Control', 'private, max-age=3600');
  if (!sendDocFile(res, a, { download: req.query.download === '1' })) {
    res.status(404).json({ error: 'This attachment has no stored file or text.' });
  }
}));

router.delete('/:boardId/attachments/:id', requireAuth, handle('remove the attachment', async (req, res) => {
  await Boards.deleteAttachment(req.params.boardId, req.user.id, req.params.id);
  res.json({ ok: true });
}));

// ── share links ────────────────────────────────────────────────

router.get('/:boardId/shares', requireAuth, handle('load share links', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  res.json({ shares: await shares.list(req.params.boardId) });
}));

router.post('/:boardId/shares', requireAuth, handle('create a share link', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const share = await shares.create(req.params.boardId, req.user.id, {
    includeDocs: req.body?.includeDocs !== false, expiresInDays: req.body?.expiresInDays ?? null
  });
  res.status(201).json({ ok: true, share });
}));

router.delete('/:boardId/shares/:shareId', requireAuth, handle('revoke the share link', async (req, res) => {
  await Boards.requireBoard(req.params.boardId, req.user.id);
  const share = await shares.revoke(req.params.boardId, req.params.shareId);
  if (!share) return res.status(404).json({ error: 'Share link not found' });
  res.json({ ok: true, share });
}));

module.exports = router;
module.exports.boardView = boardView;
module.exports.attView = attView;
module.exports.shares = shares;
