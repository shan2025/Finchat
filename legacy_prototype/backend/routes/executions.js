// routes/executions.js — Cognitive Core Executions Management & HITL Resumption
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { resumeExecution } = require('../services/cognitive/CognitiveCore');

// ── GET /api/executions/:id ──────────────────────────────────
// Fetch details and current status of an execution
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const resExec = await query('SELECT * FROM executions WHERE execution_id = $1', [req.params.id]);
    if (resExec.rows.length === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    const execution = resExec.rows[0];

    const resLogs = await query('SELECT * FROM execution_logs WHERE execution_id = $1 ORDER BY step_number ASC', [req.params.id]);

    res.json({
      execution,
      logs: resLogs.rows
    });
  } catch (err) {
    console.error('Fetch execution error:', err);
    res.status(500).json({ error: 'Failed to fetch execution details', details: err.message });
  }
});

// ── POST /api/executions/:id/resume ──────────────────────────
// Resume a paused execution from WAITING state (HITL Approval)
router.post('/:id/resume', requireAuth, async (req, res) => {
  const executionId = req.params.id;
  const { modifiedParameters = {}, resumptionMessage = 'Approved' } = req.body;
  const userId = req.user.id;

  try {
    // Check if execution exists and is in waiting state
    const resExec = await query('SELECT * FROM executions WHERE execution_id = $1', [executionId]);
    if (resExec.rows.length === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    const execution = resExec.rows[0];
    if (execution.current_state !== 'waiting') {
      return res.status(400).json({
        error: `Execution cannot be resumed because it is currently in "${execution.current_state}" state (must be "waiting")`
      });
    }

    // Run resume in background or synchronously based on query/header
    const resumedResult = await resumeExecution(executionId, {
      userId,
      modifiedParameters,
      resumptionMessage
    });

    res.json({
      status: 'resumed',
      executionId,
      resumptionMessage,
      result: resumedResult
    });
  } catch (err) {
    console.error('Resume execution error:', err);
    res.status(500).json({ error: 'Failed to resume execution', details: err.message });
  }
});

module.exports = router;
