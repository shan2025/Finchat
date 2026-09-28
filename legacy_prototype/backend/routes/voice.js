// routes/voice.js — /api/voice
//
//   POST /transcribe    multipart "audio" → {text}
//
// Signed-in only: each call spends the shared Groq Whisper allowance.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { transcribe, TranscribeError } = require('../services/transcribe');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.post('/transcribe', requireAuth, (req, res, next) => {
  upload.single('audio')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That recording is too long — keep it under two minutes' });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio received (field name: "audio")' });
    const text = await transcribe(req.file);
    res.json({ ok: true, text });
  } catch (err) {
    if (err instanceof TranscribeError) return res.status(err.status).json({ error: err.message });
    console.error('Voice transcribe error:', err);
    res.status(500).json({ error: 'Failed to transcribe' });
  }
});

module.exports = router;
