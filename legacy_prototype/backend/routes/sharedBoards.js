// routes/sharedBoards.js — the public side of a board share link. No login.
//
//   GET /:token                          the board, read-only
//   GET /:token/attachments/:id          one attachment's text
//   GET /:token/attachments/:id/file     view it, or ?download=1
//
// Same contract as routes/sharedMindMaps.js: the token is the permission, every
// failure is one 404, and the owner is never revealed.
const express = require('express');
const router = express.Router();
const Boards = require('../services/boards');
const { sendDocFile } = require('../services/cognitive/mindMapDocFile');
const { publicHeaders } = require('../services/shareLinks');
const { boardView, attView, shares } = require('./boards');

const NOT_FOUND = { error: 'This link is not valid any more — ask for a new one.' };

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
    res.json({ ...boardView(full, { includeDocs: share.include_docs }), expiresAt: share.expires_at });
  } catch (err) {
    if (err instanceof Boards.BoardError) return res.status(404).json(NOT_FOUND);
    console.error('Shared board read error:', err);
    res.status(500).json({ error: 'Failed to load the shared board' });
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
