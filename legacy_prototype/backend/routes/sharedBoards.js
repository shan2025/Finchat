// routes/sharedBoards.js — the public side of a board share link. No login.
//
//   GET /:token                          the board, read-only (+ role: view | edit)
//   POST /:token/join                    signed in + edit link → become an editor
//   GET /:token/attachments/:id          one attachment's text
//   GET /:token/attachments/:id/file     view it, or ?download=1
//
//   EDIT LINKS, no account (migration 065):
//   POST  /:token/guest                  this browser becomes a guest → {key, …}; keep the key
//   PATCH /:token/guest                  {name} — the name History shows next to their number
//   *     /:token/edit/…                 the board routes (routes/boards.js) as that guest, header
//                                        X-Board-Guest: <key>; only the routes in GUEST_ROUTES
//
// Same contract as routes/sharedMindMaps.js: the token is the permission, every
// failure is one 404, and the owner is never revealed. Turning a link off
// shuts out every guest who came through it on their next request.
const express = require('express');
const router = express.Router();
const Boards = require('../services/boards');
const { sendDocFile } = require('../services/cognitive/mindMapDocFile');
const { publicHeaders } = require('../services/shareLinks');
const { requireAuth } = require('../middleware/auth');
const boardsRouter = require('./boards');
const { boardView, attView, shares } = boardsRouter;

const NOT_FOUND = { error: 'This link is not valid any more — ask for a new one.' };

/**
 * What a guest may do: read the board and its History, and change cards,
 * columns and files. Not: rename or delete the board, share links, people,
 * Ask AI (it spends the owner's credits), mind maps, or undo.
 */
const GUEST_ROUTES = [
  ['GET', /^\/$/], ['GET', /^\/(stamp|activity)$/],
  ['POST', /^\/columns(\/order)?$/], ['PATCH', /^\/columns\/[\w-]+$/], ['DELETE', /^\/columns\/[\w-]+$/],
  ['POST', /^\/cards(\/order)?$/], ['PATCH', /^\/cards\/[\w-]+$/], ['DELETE', /^\/cards\/[\w-]+$/],
  ['POST', /^\/attachments(\/text|\/links)?$/, 'docs'], ['GET', /^\/attachments\/[\w-]+(\/file)?$/, 'docs'],
  ['DELETE', /^\/attachments\/[\w-]+$/, 'docs']
];

function guestMayUse(method, path, share) {
  const rule = GUEST_ROUTES.find(([m, re]) => m === method && re.test(path));
  return !!rule && (rule[2] !== 'docs' || share.include_docs);
}

/** The edit link behind this request, or a 404 already sent. */
async function editShare(req, res) {
  const share = await resolve(req, res);
  if (!share) return null;
  if (share.role !== 'edit') { res.status(403).json({ error: 'This link is view-only — ask the owner for edit access.' }); return null; }
  return share;
}

router.post('/:token/guest', async (req, res) => {
  try {
    const share = await editShare(req, res);
    if (!share) return;
    res.status(201).json({ ok: true, ...await Boards.createGuest(share.target_id, share.share_id) });
  } catch (err) {
    if (err instanceof Boards.BoardError) return res.status(err.status).json({ error: err.message });
    console.error('Shared board guest error:', err);
    res.status(500).json({ error: 'Failed to open the board for editing' });
  }
});

router.patch('/:token/guest', async (req, res) => {
  try {
    const share = await editShare(req, res);
    if (!share) return;
    const guest = await Boards.guestByKey(share.target_id, req.get('X-Board-Guest'));
    if (!guest) return res.status(401).json({ error: 'guest_unknown' });
    res.json({ ok: true, ...await Boards.renameGuest(guest.guestId, req.body?.name || '') });
  } catch (err) {
    console.error('Shared board guest rename error:', err);
    res.status(500).json({ error: 'Failed to save your name' });
  }
});

// The board routes, as a guest. The link and the guest are checked on every
// request; the first change gives the guest their number.
router.use('/:token/edit', async (req, res, next) => {
  try {
    const share = await editShare(req, res);
    if (!share) return;
    const path = req.path.replace(/\/+$/, '') || '/';
    if (!guestMayUse(req.method, path, share)) return res.status(403).json({ error: 'Only the owner can do that' });
    let guest = await Boards.guestByKey(share.target_id, req.get('X-Board-Guest'));
    if (!guest) return res.status(401).json({ error: 'guest_unknown' });
    if (req.method !== 'GET' && guest.number == null) guest = await Boards.numberGuest(guest.guestId, share.target_id) || guest;
    req.boardGuest = { ...guest, includeDocs: share.include_docs };
    req.url = '/' + encodeURIComponent(share.target_id) + (req.url === '/' ? '' : req.url);
    boardsRouter(req, res, next);
  } catch (err) {
    console.error('Shared board edit error:', err);
    res.status(500).json({ error: 'Failed to reach the board' });
  }
});

async function resolve(req, res) {
  const share = await shares.resolve(req.params.token);
  if (!share) { res.status(404).json(NOT_FOUND); return null; }
  publicHeaders(res);
  return share;
}

async function sharedAttachment(req, res, share, withData) {
  if (!share.include_docs) { res.status(404).json(NOT_FOUND); return null; }
  const a = await Boards.getAttachment(share.target_id, req.params.id, { withData });
  if (!a) { res.status(404).json(NOT_FOUND); return null; }
  return a;
}

router.get('/:token', async (req, res) => {
  try {
    const share = await resolve(req, res);
    if (!share) return;
    const full = await Boards.getBoard(share.target_id, null);
    shares.seen(share.share_id);
    // role 'edit' sends the page on to the editor: as a member after /join
    // when signed in, otherwise as a guest through /edit.
    res.json({ ...boardView(full, { includeDocs: share.include_docs }), expiresAt: share.expires_at, role: share.role || 'view' });
  } catch (err) {
    if (err instanceof Boards.BoardError) return res.status(404).json(NOT_FOUND);
    console.error('Shared board read error:', err);
    res.status(500).json({ error: 'Failed to load the shared board' });
  }
});

// An EDIT link opened by someone signed in: they become an editor and go to
// the real board under their own name. Without an account they edit as a
// numbered guest instead (/guest and /edit above).
router.post('/:token/join', requireAuth, async (req, res) => {
  try {
    const share = await resolve(req, res);
    if (!share) return;
    if (share.role !== 'edit') return res.status(403).json({ error: 'This link is view-only — ask the owner for edit access.' });
    const out = await Boards.joinByLink(share.target_id, req.user.id);
    res.json({ ok: true, boardId: share.target_id, joined: out.joined });
  } catch (err) {
    if (err instanceof Boards.BoardError) return res.status(404).json(NOT_FOUND);
    console.error('Shared board join error:', err);
    res.status(500).json({ error: 'Failed to join the board' });
  }
});

router.get('/:token/attachments/:id', async (req, res) => {
  try {
    const share = await resolve(req, res);
    if (!share) return;
    const a = await sharedAttachment(req, res, share, false);
    if (!a) return;
    res.json({ attachment: { ...attView(a), text: a.extracted || '' } });
  } catch (err) {
    console.error('Shared board attachment error:', err);
    res.status(500).json({ error: 'Failed to load the attachment' });
  }
});

router.get('/:token/attachments/:id/file', async (req, res) => {
  try {
    const share = await resolve(req, res);
    if (!share) return;
    const a = await sharedAttachment(req, res, share, true);
    if (!a) return;
    if (!sendDocFile(res, a, { download: req.query.download === '1' })) {
      res.status(404).json({ error: 'This attachment has no stored file or text.' });
    }
  } catch (err) {
    console.error('Shared board file error:', err);
    res.status(500).json({ error: 'Failed to load the file' });
  }
});

module.exports = router;
module.exports.guestMayUse = guestMayUse;
