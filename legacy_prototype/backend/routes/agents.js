// routes/agents.js — Real-Time Agent Operations Status API
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { listPersonas } = require('../services/personas');
const { runDebate } = require('../services/agents/DebateOrchestrator');
const { refreshRegistry, getAgentConfig } = require('../services/agents/AgentRegistry');

const VALID_RISK = ['Low', 'Medium', 'High'];
// Optional per-agent model override — any Groq-supported model string, plus '' meaning "use default".
const VALID_MODELS = [
  '', // default (llama-3.3-70b-versatile)
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'deepseek-r1-distill-llama-70b'
];

/**
 * GET /api/agents/status
 * Returns real-time operational state (WORKING, IDLE, WAITING) for Plato, Aurelius, Rasha, and Nova.
 * Also returns recent cognitive activity feed and token budgets.
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const personas = listPersonas(); // plato, aurelius, rasha, nova

    // 1. Check active executions right now
    const resActive = await query(`
      SELECT execution_id, assigned_agent, current_state, goal, created_at, updated_at,
             iterations_used, max_iterations, tool_calls_used, max_tool_calls, tokens_used, wait_reason
      FROM executions
      WHERE current_state IN ('running', 'ready', 'waiting')
      ORDER BY updated_at DESC
    `);
    const activeExecutions = resActive.rows;

    // 1b. Per-agent lifetime burn metrics + average task duration (for ETA)
    const resMetrics = await query(`
      SELECT assigned_agent,
             COUNT(*)                                          AS task_count,
             COALESCE(SUM(tokens_used), 0)                     AS total_tokens,
             COALESCE(SUM(tool_calls_used), 0)                 AS total_tool_calls,
             COALESCE(SUM(iterations_used), 0)                 AS total_iterations,
             COALESCE(
               AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))
               FILTER (WHERE current_state = 'completed'), 0)  AS avg_duration_seconds
      FROM executions
      WHERE assigned_agent IS NOT NULL
      GROUP BY assigned_agent
    `);
    const metricsByAgent = {};
    for (const m of resMetrics.rows) {
      metricsByAgent[m.assigned_agent] = {
        tasks: parseInt(m.task_count) || 0,
        tokens: parseInt(m.total_tokens) || 0,
        toolCalls: parseInt(m.total_tool_calls) || 0,
        iterations: parseInt(m.total_iterations) || 0,
        avgDurationSeconds: Math.round(parseFloat(m.avg_duration_seconds) || 0)
      };
    }

    // 2. Map agent states
    // Default all to IDLE, seeded with lifetime burn
    const agentStatusMap = {};
    for (const p of personas) {
      const burn = metricsByAgent[p.id] || { tasks: 0, tokens: 0, toolCalls: 0, iterations: 0, avgDurationSeconds: 0 };
      agentStatusMap[p.id] = {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
         role: p.roleTitle || p.role || p.title || 'Specialist Agent',
        status: 'IDLE', // IDLE | WORKING | WAITING
        activeTask: null,
        burn, // { tasks, tokens, toolCalls, iterations, avgDurationSeconds }
        updatedAt: new Date().toISOString()
      };
    }

    // Assign active statuses based on active executions
    for (const exec of activeExecutions) {
      const agentId = exec.assigned_agent || 'plato';
      if (agentStatusMap[agentId]) {
        const status = exec.current_state === 'waiting' ? 'WAITING' : 'WORKING';

        // ETA: estimate remaining seconds from this agent's average completed duration.
        const avgDur = agentStatusMap[agentId].burn.avgDurationSeconds;
        const elapsedSeconds = Math.round((Date.now() - new Date(exec.created_at).getTime()) / 1000);
        let etaSeconds = null;
        if (exec.current_state === 'waiting') {
          etaSeconds = null; // paused for human input — no meaningful ETA
        } else if (avgDur > 0) {
          etaSeconds = Math.max(0, avgDur - elapsedSeconds);
        } else if (exec.max_iterations > 0) {
          // Fallback: extrapolate from progress through the iteration budget (~4s/iteration)
          const remainingIters = Math.max(0, exec.max_iterations - exec.iterations_used);
          etaSeconds = remainingIters * 4;
        }

        agentStatusMap[agentId].status = status;
        agentStatusMap[agentId].activeTask = {
          executionId: exec.execution_id,
          goal: exec.goal,
          state: exec.current_state,
          waitReason: exec.wait_reason,
          iterations: `${exec.iterations_used}/${exec.max_iterations}`,
          toolCalls: `${exec.tool_calls_used}/${exec.max_tool_calls}`,
          tokensUsed: exec.tokens_used || 0,
          elapsedSeconds,
          etaSeconds,
          startedAt: exec.created_at,
          updatedAt: exec.updated_at
        };
        agentStatusMap[agentId].updatedAt = exec.updated_at;
      }
    }

    // 3. Get recent execution stream (last 15 completed/failed/waiting tasks)
    const resHistory = await query(`
      SELECT e.execution_id, e.assigned_agent, e.current_state, e.goal, e.completion_reason, e.wait_reason,
             e.created_at, e.updated_at, e.iterations_used, e.tool_calls_used,
             (
               SELECT json_agg(json_build_object('tool', (el.content->>'tool'), 'output', el.content->'output', 'error', el.content->'error'))
               FROM execution_logs el
               WHERE el.execution_id = e.execution_id AND el.phase = 'using_tool'
             ) as tools_invoked
      FROM executions e
      ORDER BY e.updated_at DESC
      LIMIT 15
    `);
    const recentActivity = resHistory.rows.map(row => ({
      executionId: row.execution_id,
      agentId: row.assigned_agent || 'plato',
      state: row.current_state,
      goal: row.goal,
      completionReason: row.completion_reason,
      waitReason: row.wait_reason,
      iterationsUsed: row.iterations_used,
      toolCallsUsed: row.tool_calls_used,
      toolsInvoked: row.tools_invoked || [],
      startedAt: row.created_at,
      updatedAt: row.updated_at,
      durationSeconds: Math.round((new Date(row.updated_at).getTime() - new Date(row.created_at).getTime()) / 1000)
    }));

    // 4. Get queue / background job status from BullMQ
    let queueStatus = { active: 0, waiting: 0, completed: 0, failed: 0 };
    try {
      const { getQueue } = require('../services/queue/WorkerPool');
      const q = getQueue();
      if (q) {
        const counts = await q.getJobCounts('active', 'waiting', 'completed', 'failed');
        queueStatus = counts;
      }
    } catch (qErr) {
      // Ignore if queue not reachable right now
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      agents: Object.values(agentStatusMap),
      recentActivity,
      queueStatus
    });

  } catch (err) {
    console.error('Fetch agents status error:', err);
    res.status(500).json({ error: 'Failed to fetch agent status', details: err.message });
  }
});

/**
 * POST /api/agents/debate
 * Sprint 5 · Phase 5A — run a multi-agent debate: Plato delegates to specialists,
 * they argue their positions, and Plato synthesizes a consensus executive decision.
 *
 * Body: { goal: string, participants?: string[], maxRounds?: number, conversationId?: string }
 */
router.post('/debate', requireAuth, async (req, res) => {
  try {
    const { goal, participants, maxRounds, conversationId } = req.body || {};
    if (!goal || typeof goal !== 'string' || !goal.trim()) {
      return res.status(400).json({ error: 'A non-empty "goal" is required.' });
    }

    const result = await runDebate({
      goal: goal.trim(),
      userId: req.user.id,
      conversationId: conversationId || null,
      participants: Array.isArray(participants) ? participants : null,
      maxRounds: Number.isInteger(maxRounds) ? Math.max(0, Math.min(maxRounds, 4)) : 2
    });

    res.json({ status: 'ok', debate: result });
  } catch (err) {
    console.error('Debate route error:', err);
    res.status(500).json({ error: 'Failed to run debate', details: err.message });
  }
});

/**
 * GET /api/agents/debates — recent debates (history list).
 */
router.get('/debates', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const r = await query(
      `SELECT debate_id, goal, participants, conflict_detected, conflict_summary,
              rounds_run, final_consensus, status, created_at
       FROM debates ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json({ debates: r.rows });
  } catch (err) {
    console.error('List debates error:', err);
    res.status(500).json({ error: 'Failed to list debates' });
  }
});

/**
 * GET /api/agents/debates/:id — a single debate with its full transcript.
 */
router.get('/debates/:id', requireAuth, async (req, res) => {
  try {
    const dRes = await query(`SELECT * FROM debates WHERE debate_id = $1`, [req.params.id]);
    if (dRes.rows.length === 0) return res.status(404).json({ error: 'Debate not found' });
    const aRes = await query(
      `SELECT round_number, agent_id, position FROM debate_arguments
       WHERE debate_id = $1 ORDER BY round_number ASC, argument_id ASC`, [req.params.id]);
    res.json({ debate: dRes.rows[0], arguments: aRes.rows });
  } catch (err) {
    console.error('Get debate error:', err);
    res.status(500).json({ error: 'Failed to fetch debate' });
  }
});

/**
 * GET /api/agents/:agentId/config — the agent's runtime tuning (risk + traits).
 */
router.get('/:agentId/config', requireAuth, async (req, res) => {
  try {
    const cfg = await getAgentConfig(req.params.agentId);
    if (!cfg) return res.status(404).json({ error: 'Agent not found' });
    res.json({ agentId: cfg.agentId, name: cfg.name, settings: cfg.runtimeSettings || {} });
  } catch (err) {
    console.error('Get agent config error:', err);
    res.status(500).json({ error: 'Failed to load agent config' });
  }
});

/**
 * PUT /api/agents/:agentId/config — persist risk + traits; busts the registry cache
 * so the very next cognitive run uses the new tuning.
 * Body: { risk: 'Low'|'Medium'|'High', formal, brief, serious } (0-100 sliders)
 */
router.put('/:agentId/config', requireAuth, async (req, res) => {
  try {
    const existing = await getAgentConfig(req.params.agentId);
    if (!existing) return res.status(404).json({ error: 'Agent not found' });

    const { risk, formal, brief, serious, model } = req.body || {};
    const clamp = (v, d) => (Number.isFinite(+v) ? Math.max(0, Math.min(100, Math.round(+v))) : d);
    const cur = existing.runtimeSettings || {};
    const next = {
      risk: VALID_RISK.includes(risk) ? risk : (cur.risk || 'Low'),
      formal: clamp(formal, cur.formal != null ? cur.formal : 50),
      brief: clamp(brief, cur.brief != null ? cur.brief : 50),
      serious: clamp(serious, cur.serious != null ? cur.serious : 50),
      model: (typeof model === 'string' && VALID_MODELS.includes(model)) ? model : (cur.model || '')
    };

    await query(`UPDATE agent_configs SET runtime_settings = $1::jsonb WHERE agent_id = $2`,
      [JSON.stringify(next), req.params.agentId]);
    await refreshRegistry();

    res.json({ status: 'ok', agentId: req.params.agentId, settings: next });
  } catch (err) {
    console.error('Update agent config error:', err);
    res.status(500).json({ error: 'Failed to update agent config' });
  }
});

/**
 * GET /api/agents/:agentId/audit — real audit-trail rows for this agent
 * (written by SentinelAgent.postLog on every completed cognitive execution).
 */
router.get('/:agentId/audit', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const result = await query(
      `SELECT log_id, action, target_type, target_id, details, created_at
       FROM audit_logs
       WHERE details->>'delegatedAgent' = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.agentId, limit]
    );
    res.json({ agentId: req.params.agentId, logs: result.rows });
  } catch (err) {
    console.error('Agent audit error:', err);
    res.status(500).json({ error: 'Failed to load agent audit logs' });
  }
});

/**
 * GET /api/agents/memory-graph — quick counts for the Operations "Knowledge Memory" tile.
 * Surfaces the Sprint 5C Graph-RAG state so users can see it's populating over time.
 */
router.get('/memory-graph', requireAuth, async (req, res) => {
  try {
    const [ents, edges, recipes, topEnts] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM entities WHERE user_id = $1`, [req.user.id]),
      query(`SELECT COUNT(*)::int AS c FROM entity_edges WHERE user_id = $1`, [req.user.id]),
      query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(times_reused),0)::int AS reuses FROM skill_recipes`),
      query(`SELECT canonical_name, entity_type, mention_count FROM entities WHERE user_id = $1 ORDER BY mention_count DESC LIMIT 6`, [req.user.id])
    ]);
    res.json({
      entities: ents.rows[0].c,
      edges: edges.rows[0].c,
      recipes: recipes.rows[0].c,
      recipeReuses: recipes.rows[0].reuses,
      topEntities: topEnts.rows
    });
  } catch (err) {
    console.error('Memory-graph route error:', err);
    res.status(500).json({ error: 'Failed to load memory graph summary' });
  }
});

/**
 * GET /api/agents/integrity — compact proof-of-conversation + Solana anchoring summary
 * for the Operations "System Integrity" strip.
 */
router.get('/integrity', requireAuth, async (req, res) => {
  try {
    const agg = await query(`
      SELECT COUNT(*)::int AS total_blocks,
             COUNT(*) FILTER (WHERE solana_confirmed = 1)::int AS anchored_blocks,
             COALESCE(MAX(chain_height), 0) AS max_height
      FROM proof_chain
    `);
    const lastAnchor = await query(`
      SELECT hash, chain_height, solana_tx, solana_slot, timestamp
      FROM proof_chain
      WHERE solana_confirmed = 1
      ORDER BY chain_height DESC
      LIMIT 1
    `);
    const { isReachable } = require('../services/solana');
    const solanaOnline = await isReachable();

    res.json({
      totalBlocks: agg.rows[0].total_blocks,
      anchoredBlocks: agg.rows[0].anchored_blocks,
      maxHeight: parseInt(agg.rows[0].max_height) || 0,
      solanaOnline,
      lastAnchor: lastAnchor.rows[0] || null
    });
  } catch (err) {
    console.error('Integrity summary error:', err);
    res.status(500).json({ error: 'Failed to load integrity summary' });
  }
});

module.exports = router;
