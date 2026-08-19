// routes/executions.js — Cognitive Core Executions Management & HITL Resumption
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { resumeExecution } = require('../services/cognitive/CognitiveCore');
const { buildExecutionTrace } = require('../services/cognitive/ExecutionTrace');

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

// ── GET /api/executions/list/recent ──────────────────────────
// Recent executions for the signed-in user, newest first — feeds the Brain
// Model's "load a real run" picker. Two path segments so it never collides
// with GET /:id.
router.get('/list/recent', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const rows = await query(`
      SELECT execution_id, assigned_agent, current_state, completion_reason, goal,
             tokens_used, tool_calls_used, created_at, updated_at
      FROM executions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [req.user.id, limit]);
    res.json({ executions: rows.rows });
  } catch (err) {
    console.error('Recent executions error:', err);
    res.status(500).json({ error: 'Failed to list recent executions', details: err.message });
  }
});

// ── POST /api/executions/race ────────────────────────────────
// Multi-agent race: Plato picks 2–3 relevant specialists and dispatches the
// SAME question to each in parallel (each its own execution). Every run streams
// its own brain:pulse events tagged with the shared raceId, so the Brain Model
// groups them onto one map and shows them racing. Returns immediately — the
// runs stream live over the socket. Reuses CognitiveCore.run; no new tables.
router.post('/race', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const question = (req.body && req.body.question || '').trim();
  const requested = Array.isArray(req.body && req.body.agents) ? req.body.agents.slice(0, 3) : null;
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    const { run } = require('../services/cognitive/CognitiveCore');
    const { findTopAgents } = require('../services/agents/AgentRegistry');

    let field = (requested && requested.length) ? requested : await findTopAgents(question, 3);
    if (!field || field.length < 2) field = ['nova', 'aurelius', 'rasha'];

    // A race costs one run per agent — guard the wallet before firing them.
    const ur = await query('SELECT token_balance, is_frozen FROM users WHERE user_id = $1', [userId]);
    const u = ur.rows[0];
    if (u && u.is_frozen) return res.status(403).json({ error: 'Account frozen' });
    if (u && u.token_balance < field.length * 5) {
      return res.status(402).json({ error: 'Insufficient tokens for a race', need: field.length * 5, balance: u.token_balance });
    }

    const raceId = 'race_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    // Fire the lanes in parallel; do NOT await — they stream over the socket and
    // can take tens of seconds each. Failures are logged, never surfaced as a 500.
    for (const agentName of field) {
      run({ goal: question, userId, agentName, workload: 'chat', raceId })
        .catch(err => console.warn(`⚠️ Race ${raceId} lane "${agentName}" failed: ${err.message}`));
    }

    res.json({ raceId, agents: field, question });
  } catch (err) {
    console.error('Race dispatch error:', err);
    res.status(500).json({ error: 'Failed to start race', details: err.message });
  }
});

// ── GET /api/executions/:id/trace ────────────────────────────
// Read-only: reshape one real execution into the Brain Model's ExecutionTrace.
// Adds no tables and writes nothing — see services/cognitive/ExecutionTrace.js.
router.get('/:id/trace', requireAuth, async (req, res) => {
  try {
    const trace = await buildExecutionTrace({ executionId: req.params.id, userId: req.user.id });
    if (!trace) return res.status(404).json({ error: 'Execution not found' });
    if (trace.forbidden) return res.status(403).json({ error: 'Not your execution' });
    res.json({ trace });
  } catch (err) {
    console.error('Build execution trace error:', err);
    res.status(500).json({ error: 'Failed to build execution trace', details: err.message });
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
