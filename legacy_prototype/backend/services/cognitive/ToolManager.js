// services/cognitive/ToolManager.js — Orchestrates tool execution: permission -> cache -> rate limit -> execute -> normalize -> log
const { query } = require('../../database');
const { cacheGet, cacheSet, redisCommand } = require('../redis');
const { getToolMeta } = require('./ToolRegistry');

// Tool implementation map — maps tool names to their execute() functions
const TOOL_IMPLEMENTATIONS = {
  search: require('../../tools/SearchTool'),
  stocks: require('../../tools/StockTool'),
  paper: require('../../tools/PaperTool'),
  resume: require('../../tools/ResumeTool'),
  crypto: require('../../tools/CryptoTool'),
  jobs: require('../../tools/JobsTool'),
  commodities: require('../../tools/CommoditiesTool'),
  forex: require('../../tools/ForexTool'),
  fetch: require('../../tools/FetchTool'),
  crawl: require('../../tools/CrawlTool'),
  news: require('../../tools/NewsTool'),
  wikipedia: require('../../tools/WikipediaTool'),
  reddit: require('../../tools/RedditTool'),
  quora: require('../../tools/QuoraTool'),
  watchlist: require('../../tools/WatchlistTool'),
  notifications: require('../../tools/NotificationsTool'),
  neural_map: require('../../tools/NeuralMapTool'),
  apply_draft: require('../../tools/ApplyDraftTool'),
  bash: require('../../tools/BashTool'),
  file_read: require('../../tools/FileReadTool'),
  file_write: require('../../tools/FileWriteTool'),
  file_edit: require('../../tools/FileEditTool'),
  glob: require('../../tools/GlobTool')
};

/**
 * Thrown when a tool marked `requires_approval` in its registry manifest is
 * invoked without prior human approval. The Cognitive Core catches this,
 * parks the execution in WAITING (human_approval) and notifies the user;
 * POST /api/executions/:id/approve resumes with the tool whitelisted.
 */
class ApprovalRequiredError extends Error {
  constructor(toolName, input) {
    super(`Tool "${toolName}" requires human approval before it can run.`);
    this.name = 'ApprovalRequiredError';
    this.toolName = toolName;
    this.toolInput = input;
  }
}

/**
 * Generate a unique ID for tool call/result records.
 */
function genId(prefix = 'tc') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

const ADVANCED_SYSTEM_TOOLS = new Set(['bash', 'file_read', 'file_write', 'file_edit', 'glob']);

/**
 * Tools that reach the host directly — BashTool shells out via child_process.exec,
 * the file tools write to the real filesystem. Holding one of these is equivalent
 * to holding a host shell, so they are DENY-BY-DEFAULT (P0-1): an agent may use
 * them only with an explicit `allowed = 1` row, and every other answer is a denial.
 *
 * The permissive Sprint 1 defaults below still apply to every other tool.
 */
const HOST_ACCESS_TOOLS = new Set(['bash', 'file_write', 'file_edit']);

/** The one agent permitted to hold host-access tools. Must match migration 026. */
const ADMIN_AGENT_ID = 'plato';

/**
 * Check if an agent has permission to use a given tool.
 * For Sprint 1: if no explicit permission row exists, allow by default (permissive mode).
 * Host-access tools invert that default — see HOST_ACCESS_TOOLS.
 */
async function checkPermission(agentId, toolName) {
  const hostAccess = HOST_ACCESS_TOOLS.has(toolName);

  // Host access is never ambient: a call with no agent identity carries no grant
  // to check, so it is denied rather than waved through as a system-level call.
  if (!agentId) return !hostAccess;

  // Hardcode restriction: Only the admin agent can use advanced system tools for now
  if (ADVANCED_SYSTEM_TOOLS.has(toolName) && agentId !== ADMIN_AGENT_ID) {
    return false;
  }

  try {
    const res = await query(
      'SELECT allowed FROM tool_permissions WHERE agent_id = $1 AND tool_name = $2',
      [agentId, toolName]
    );
    // No row: still allowed by default in Sprint 1, except for host-access tools,
    // which require a grant to exist — so a newly added agent starts with none.
    if (res.rows.length === 0) return !hostAccess;
    return res.rows[0].allowed === 1;
  } catch (err) {
    if (hostAccess) {
      // Fail CLOSED. A database outage must not hand out shell access.
      console.error(`🔒 ToolManager: permission lookup failed for "${toolName}" (${agentId}) — denying: ${err.message}`);
      return false;
    }
    return true; // Fail open for Sprint 1
  }
}

/**
 * Check sliding-window rate limit via Redis.
 * Returns { allowed: boolean, remaining: number }
 */
async function checkRateLimit(toolName, limitPerMinute) {
  if (!limitPerMinute || limitPerMinute <= 0) return { allowed: true, remaining: Infinity };

  const key = `ratelimit:${toolName}`;
  const now = Date.now();
  const windowMs = 60000;

  try {
    // Remove entries outside the sliding window
    await redisCommand(['ZREMRANGEBYSCORE', key, '0', String(now - windowMs)]);
    
    // Count entries in the current window
    const countResult = await redisCommand(['ZCARD', key]);
    const currentCount = parseInt(countResult) || 0;

    if (currentCount >= limitPerMinute) {
      return { allowed: false, remaining: 0 };
    }

    // Add the current request to the window
    await redisCommand(['ZADD', key, String(now), `${now}_${Math.random()}`]);
    await redisCommand(['EXPIRE', key, '120']); // TTL slightly over 1 minute

    return { allowed: true, remaining: limitPerMinute - currentCount - 1 };
  } catch {
    // If Redis is unavailable, allow the request (fail open)
    return { allowed: true, remaining: limitPerMinute };
  }
}

/**
 * Execute a tool with the full pipeline:
 * 1. Permission check
 * 2. Cache check (Redis, per-tool TTL)
 * 3. Rate limit (Redis sliding window)
 * 4. Execute
 * 5. Normalize output
 * 6. Log to tool_calls / tool_results
 *
 * @param {object} options
 * @param {string} options.executionId - Parent execution ID
 * @param {string} options.agentId - Agent requesting the tool
 * @param {string} options.toolName - Name of the tool (e.g. 'search', 'stocks')
 * @param {string} options.input - Input string for the tool
 * @returns {Promise<{ output: any, cached: boolean, durationMs: number, callId: string }>}
 */
async function executeTool({ executionId, agentId, toolName, input, allowWeb = true, approvedTools = [], context = {} }) {
  const meta = getToolMeta(toolName);
  if (!meta) {
    throw new Error(`Unknown tool: "${toolName}". Available tools: ${Object.keys(TOOL_IMPLEMENTATIONS).join(', ')}`);
  }

  // Composer WEB toggle: hard-block open-web tools when the user disabled web access
  if (meta.web && !allowWeb) {
    throw new Error(`Tool "${toolName}" needs web access, which the user has turned OFF for this conversation. Answer from your other tools or ask the user to enable the WEB toggle.`);
  }

  // 1. Permission check
  //
  // This MUST come before the approval gate below, and used to come after it —
  // which is how the seeded "Daily research digest" mission hung for a day.
  // Nova planned a `bash` step, the gate parked the run and asked a human to
  // approve it, and approving would then have hit this check and been refused,
  // because bash is an ADVANCED_SYSTEM_TOOL restricted to the admin agent. The
  // human was being asked to authorise something that could not run either way,
  // and the mission waited forever on a decision with no effect.
  //
  // Checking permission first turns that into an immediate error the agent can
  // actually recover from mid-plan. It also stops the app from ever showing an
  // approval card for unsandboxed host shell access to an agent that is not
  // allowed to use it — a prompt no one should be trained to click through.
  const permitted = await checkPermission(agentId, toolName);
  if (!permitted) {
    throw new Error(`Agent "${agentId}" does not have permission to use tool "${toolName}"`);
  }

  // Human-in-the-loop gate: irreversible tools park the execution for approval
  if (meta.requires_approval && !approvedTools.includes(toolName)) {
    throw new ApprovalRequiredError(toolName, input);
  }

  const impl = TOOL_IMPLEMENTATIONS[toolName];
  if (!impl || typeof impl.execute !== 'function') {
    throw new Error(`Tool "${toolName}" is registered but has no execute() implementation`);
  }

  // 2. Cache check
  const cacheKey = `tool:${toolName}:${input}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    // Log as cached hit
    const callId = genId('tc');
    await logToolCall(callId, executionId, agentId, toolName, input, 'completed');
    await logToolResult(callId, cached, null, true, 0);
    return { output: cached, cached: true, durationMs: 0, callId };
  }

  // 3. Rate limit
  const rateCheck = await checkRateLimit(toolName, meta.rateLimitPerMinute);
  if (!rateCheck.allowed) {
    throw new Error(`Rate limit exceeded for tool "${toolName}". Try again in a few seconds.`);
  }

  // 4. Execute
  const callId = genId('tc');
  await logToolCall(callId, executionId, agentId, toolName, input, 'running');

  const startTime = Date.now();
  let output = null;
  let error = null;

  try {
    // Context (userId etc.) is a second arg — existing single-arg tools ignore it.
    output = await impl.execute(input, context);
  } catch (execErr) {
    error = execErr.message;
  }

  const durationMs = Date.now() - startTime;

  // 5. Update call status and log result
  await updateToolCallStatus(callId, error ? 'failed' : 'completed');
  await logToolResult(callId, output, error, false, durationMs);

  // 6. Cache successful results
  if (!error && output) {
    await cacheSet(cacheKey, output, meta.cacheTTLSeconds || 300);
  }

  if (error) {
    return { output: { error }, cached: false, durationMs, callId };
  }

  return { output, cached: false, durationMs, callId };
}

/**
 * Log a tool call record to the tool_calls table.
 */
async function logToolCall(callId, executionId, agentId, toolName, input, status) {
  // Use 'system' as agent_id if none provided, to satisfy NOT NULL constraint
  const safeAgentId = agentId || 'system';
  
  try {
    await query(`
      INSERT INTO tool_calls (call_id, execution_id, agent_id, tool_name, arguments, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [callId, executionId, safeAgentId, toolName, JSON.stringify({ input }), status]);
  } catch (err) {
    console.warn(`⚠️ ToolManager: Failed to log tool_call: ${err.message}`);
  }
}

/**
 * Update the status of an existing tool call.
 */
async function updateToolCallStatus(callId, status) {
  try {
    await query('UPDATE tool_calls SET status = $1 WHERE call_id = $2', [status, callId]);
  } catch (err) {
    console.warn(`⚠️ ToolManager: Failed to update tool_call status: ${err.message}`);
  }
}

/**
 * Log a tool result record to the tool_results table.
 */
async function logToolResult(callId, output, error, cached, durationMs) {
  const resultId = genId('tr');
  try {
    await query(`
      INSERT INTO tool_results (result_id, call_id, output, error, cached, duration_ms)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [resultId, callId, output ? JSON.stringify(output) : null, error, cached ? 1 : 0, durationMs]);
  } catch (err) {
    console.warn(`⚠️ ToolManager: Failed to log tool_result: ${err.message}`);
  }
}

module.exports = {
  executeTool, checkPermission, checkRateLimit, ApprovalRequiredError,
  HOST_ACCESS_TOOLS, ADMIN_AGENT_ID
};
