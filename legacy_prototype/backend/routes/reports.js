// routes/reports.js — Sprint Y · Reports API
//   GET  /api/reports              — list recent snapshots (optionally ?kind=)
//   GET  /api/reports/kinds        — available report kinds
//   GET  /api/reports/:id          — one full snapshot
//   POST /api/reports/generate     — generate a new snapshot { kind, days? }

const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { generate, KINDS, TITLES } = require('../services/cognitive/ReportEngine');

router.get('/kinds', requireAuth, (req, res) => {
  res.json({ kinds: KINDS.map(k => ({ kind: k, title: TITLES[k] || k })) });
});

router.get('/', requireAuth, async (req, res) => {
  try {
    // Only the caller's own reports. Legacy rows with a NULL user_id were
    // generated system-wide (pooling every account's activity) and must not be
    // shown to anyone now that reports are per-user.
    const params = [req.user.id];
    let where = `user_id = $1`;
    if (req.query.kind && KINDS.includes(req.query.kind)) {
      params.push(req.query.kind);
      where += ` AND kind = $2`;
    }
    const q = await query(`
      SELECT report_id, kind, title, period_start, period_end, summary, payload, created_at
      FROM report_snapshots WHERE ${where}
      ORDER BY created_at DESC LIMIT 50
    `, params);
    res.json({ reports: q.rows });
  } catch (err) {
    console.error('Reports list error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const q = await query(`SELECT * FROM report_snapshots WHERE report_id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (q.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: q.rows[0] });
  } catch (err) {
    console.error('Report get error:', err);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { kind } = req.body;
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
    }
    const days = Math.max(1, Math.min(180, parseInt(req.body.days) || 7));
    // Every kind is now user-scoped: a report reflects only the caller's own
    // memory/activity, never a pool of every account's data.
    const report = await generate({ kind, userId: req.user.id, days });
    res.json({ ok: true, report });
  } catch (err) {
    console.error('Report generate error:', err);
    res.status(500).json({ error: 'Report generation failed', details: err.message });
  }
});

module.exports = router;
