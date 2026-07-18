// routes/missions.js — Sprint 7 mission engine API (CRUD + run-now + history)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  listMissions, getMission, createMission, updateMission, deleteMission,
  runMission, missionHistory
} = require('../services/agents/MissionScheduler');

// ── GET /api/missions ──────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json({ missions: await listMissions(req.user.id) });
  } catch (err) {
    console.error('List missions error:', err);
    res.status(500).json({ error: 'Failed to list missions', details: err.message });
  }
});

// ── POST /api/missions ─────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { agentId, title, goal, cadence, enabled, maxTokensPerRun } = req.body;
    const mission = await createMission({
      userId: req.user.id, agentId, title, goal, cadence,
      enabled: !!enabled, maxTokensPerRun
    });
    res.status(201).json({ mission });
  } catch (err) {
    console.error('Create mission error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── PUT /api/missions/:id ──────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const mission = await updateMission(req.params.id, req.user.id, req.body);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    res.json({ mission });
  } catch (err) {
    console.error('Update mission error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE /api/missions/:id ───────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ok = await deleteMission(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ error: 'Mission not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete mission error:', err);
    res.status(500).json({ error: 'Failed to delete mission', details: err.message });
  }
});

// ── POST /api/missions/:id/run-now ─────────────────────────────
// Fires the mission immediately (even if disabled — that's how you test one
// before enabling its schedule). Runs synchronously so the caller gets the result.
router.post('/:id/run-now', requireAuth, async (req, res) => {
  try {
    const mission = await getMission(req.params.id, req.user.id);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    const result = await runMission(mission.mission_id, { manual: true });
    res.json({ result });
  } catch (err) {
    console.error('Run mission error:', err);
    res.status(500).json({ error: 'Failed to run mission', details: err.message });
  }
});

// ── GET /api/missions/:id/history ──────────────────────────────
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const data = await missionHistory(req.params.id, req.user.id, parseInt(req.query.limit) || 10);
    if (!data) return res.status(404).json({ error: 'Mission not found' });
    res.json(data);
  } catch (err) {
    console.error('Mission history error:', err);
    res.status(500).json({ error: 'Failed to fetch mission history', details: err.message });
  }
});

module.exports = router;
