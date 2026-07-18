// routes/executions.js — Cognitive Core Executions Management & HITL Resumption
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { resumeExecution } = require('../services/cognitive/CognitiveCore');

// ── GET /api/executions?state=waiting ────────────────────────
// List the user's executions, defaulting to those awaiting human approval
// (feeds the approval cards on the Agents/Operations pages).
router.get('/', requireAuth, async (req, res) => {
  try {
    const state = req.query.state || 'waiting';
    const rows = await query(`
      SELECT e.execution_id, e.assigned_agent, e.current_state, e.wait_reason, e.goal,
             e.created_at, e.updated_at,
             (
               SELECT el.content FROM execution_logs el
               WHERE el.execution_id = e.execution_id AND el.phase = 'waiting'
               ORDER BY el.step_number DESC LIMIT 1
             ) AS waiting_info
      FROM executions e
      WHERE e.user_id = $1 AND e.current_state = $2
      ORDER BY e.updated_at DESC
      LIMIT 25
    `, [req.user.id, state]);
    res.json({ executions: rows.rows });
  } catch (err) {
    console.error('List executions error:', err);
    res.status(500).json({ error: 'Failed to list executions', details: err.message });
  }
});

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

// ── POST /api/executions/:id/approve ─────────────────────────
// Sprint 7 approval gate: resume a WAITING (human_approval) execution with the
// gated tool whitelisted for the re-run.
router.post('/:id/approve', requireAuth, async (req, res) => {
  const executionId = req.params.id;
  try {
    const resExec = await query('SELECT * FROM executions WHERE execution_id = $1 AND user_id = $2', [executionId, req.user.id]);
    if (resExec.rows.length === 0) return res.status(404).json({ error: 'Execution not found' });
    const execution = resExec.rows[0];
    if (execution.current_state !== 'waiting') {
      return res.status(400).json({ error: `Execution is "${execution.current_state}", not "waiting"` });
    }

    // The gated tool name was recorded in the waiting log entry
    const logRes = await query(`
      SELECT content FROM execution_logs
      WHERE execution_id = $1 AND phase = 'waiting'
      ORDER BY step_number DESC LIMIT 1
    `, [executionId]);
    const pendingTool = logRes.rows[0]?.content?.pendingTool || null;

    const result = await resumeExecution(executionId, {
      userId: req.user.id,
      resumptionMessage: `The user APPROVED the pending "${pendingTool || 'gated'}" action — proceed with it now`,
      approvedTools: pendingTool ? [pendingTool] : []
    });

    res.json({ status: 'approved', executionId, approvedTool: pendingTool, result });
  } catch (err) {
    console.error('Approve execution error:', err);
    res.status(500).json({ error: 'Failed to approve execution', details: err.message });
  }
});

// ── POST /api/executions/:id/reject ──────────────────────────
router.post('/:id/reject', requireAuth, async (req, res) => {
  const executionId = req.params.id;
  const { reason = 'Rejected by user' } = req.body;
  try {
    const resExec = await query('SELECT * FROM executions WHERE execution_id = $1 AND user_id = $2', [executionId, req.user.id]);
    if (resExec.rows.length === 0) return res.status(404).json({ error: 'Execution not found' });
    if (resExec.rows[0].current_state !== 'waiting') {
      return res.status(400).json({ error: `Execution is "${resExec.rows[0].current_state}", not "waiting"` });
    }

    const { updateState } = require('../services/cognitive/ExecutionManager');
    const { STATES } = require('../services/cognitive/StateMachine');
    await updateState(executionId, STATES.CANCELLED, {
      completionReason: 'rejected_by_user',
      result: reason
    });

    res.json({ status: 'rejected', executionId, reason });
  } catch (err) {
    console.error('Reject execution error:', err);
    res.status(500).json({ error: 'Failed to reject execution', details: err.message });
  }
});

module.exports = router;
