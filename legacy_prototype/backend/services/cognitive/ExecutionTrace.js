// services/cognitive/ExecutionTrace.js — read-only assembler that reshapes one
// real execution into the Brain Model's ExecutionTrace shape.
//
// This is the "instrument the existing pipeline" seam: it adds NO tables and
// NO writes. Every field is read back from rows the cognitive loop already
// persists — executions, execution_logs, tool_calls/tool_results, reflections,
// and (best-effort) the entity graph provenance on entity_edges. The map's
// districts/buildings are derived from the tools the run actually used (always
// present) and enriched with knowledge entities when the graph has them.
//
// The Brain Model UI does the geometry (isometric layout); this only supplies
// the ordered route, the fuel/verification/fog facts, and the controller log.
const { query } = require('../../database');

// Which knowledge "district" each tool belongs to, and its tone
// ('a' = analytical/orange, 's' = source/green, 'n' = neutral). Shared taxonomy
// so replay, live stream, and route-yield all resolve legs the same way.
const { TOOL_DISTRICT, DEFAULT_DISTRICT } = require('./toolDistricts');

// Identity + colour for the four specialists + Plato, matching the Brain Model
// demo palette and the avatar files in the frontend.
// The real FinChat roster: Plato supervises; Nova / Aurelius / Rasha are the
// specialists. (There is no "Cato" — that was a design-mock placeholder.)
const AGENT_META = {
  plato: { name: 'Plato', role: 'Supervisor', color: '#9a5c8a', avatar: 'plato_avatar.png' },
  nova: { name: 'Nova', role: 'Finance', color: '#e08a44', avatar: 'nova_avatar.png' },
  aurelius: { name: 'Aurelius', role: 'Research', color: '#93a56e', avatar: 'aurelius_avatar.png' },
  rasha: { name: 'Rasha', role: 'Analyst', color: '#c76b6b', avatar: 'rasha_avatar.png' }
};
const DOC_TYPES = new Set(['document', 'report', 'filing', 'paper', 'source']);
const UNVERIFIED_TOOLS = new Set(['reddit', 'quora']);

const cap = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const toolLabel = (t) => cap(t);
const agentMeta = (id) => AGENT_META[id] || { name: cap(id) || 'Agent', role: 'Agent', color: '#c67139', avatar: '' };
const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function asText(v, max = 160) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function reasonTitle(reason) {
  return reason === 'natural' ? 'Answer produced'
    : reason === 'budget_exceeded' ? 'Stopped — budget exhausted'
    : reason === 'error' ? 'Stopped — error'
    : reason === 'rejected_by_user' ? 'Rejected by user'
    : reason === 'resumed' ? 'Resumed' : 'Completed';
}

// Minimal citation extraction over accumulated tool outputs — the same idea as
// CognitiveCore.extractSources, kept local so this stays a pure reader.
function extractSources(toolRows) {
  const out = [], seen = new Set();
  const push = (tool, title, url, verified) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ tool, title: String(title || url).slice(0, 160), url, verified });
  };
  for (const row of toolRows) {
    const r = row && row.output;
    if (!r || typeof r !== 'object' || r.error) continue;
    const verified = !UNVERIFIED_TOOLS.has(row.tool_name) && r.verified !== false;
    if (r.url && (r.title || r.text)) push(row.tool_name, r.title, r.url, verified);
    if (r.topArticle && r.topArticle.url) push(row.tool_name, r.topArticle.title, r.topArticle.url, verified);
    for (const list of [r.results, r.papers, r.pages].filter(Array.isArray)) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        push(row.tool_name, item.title || item.question || item.name || item.snippet,
          item.url || item.pdfUrl || item.link, verified);
      }
    }
  }
  return out.slice(0, 10);
}

/**
 * Assemble one execution into a Brain Model trace. Returns null if the row does
 * not exist, or { forbidden: true } if it belongs to another user.
 *
 * @param {object} opts
 * @param {string} opts.executionId
 * @param {string|null} [opts.userId] - when set, the row must belong to them
 */
async function buildExecutionTrace({ executionId, userId = null }) {
  const execRes = await query('SELECT * FROM executions WHERE execution_id = $1', [executionId]);
  if (execRes.rows.length === 0) return null;
  const e = execRes.rows[0];
  if (userId && e.user_id && e.user_id !== userId) return { forbidden: true };

  const logsRes = await query(
    'SELECT phase, step_number, content, started_at FROM execution_logs WHERE execution_id = $1 ORDER BY step_number ASC, log_id ASC',
    [executionId]
  );
  const logs = logsRes.rows;

  let toolRows = [];
  try {
    const tRes = await query(`
      SELECT tc.tool_name, tc.status, tc.created_at, tr.output, tr.error, tr.duration_ms, tr.cached
      FROM tool_calls tc LEFT JOIN tool_results tr ON tr.call_id = tc.call_id
      WHERE tc.execution_id = $1 ORDER BY tc.created_at ASC
    `, [executionId]);
    toolRows = tRes.rows;
  } catch (_) { /* best-effort */ }

  let reflection = null;
  try {
    const rRes = await query('SELECT summary, learnings FROM reflections WHERE execution_id = $1 ORDER BY created_at DESC LIMIT 1', [executionId]);
    reflection = rRes.rows[0] || null;
  } catch (_) { /* table may lag */ }

  let entities = [];
  try {
    const enRes = await query(`
      SELECT DISTINCT e.entity_id, e.canonical_name, e.entity_type
      FROM entity_edges ee
      JOIN entities e ON (e.entity_id = ee.from_entity_id OR e.entity_id = ee.to_entity_id)
      WHERE ee.context_execution_id = $1 LIMIT 24
    `, [executionId]);
    entities = enRes.rows;
  } catch (_) { /* graph enrichment optional */ }

  const t0 = new Date(e.created_at).getTime();
  const relMs = (ts) => (ts ? Math.max(0, new Date(ts).getTime() - t0) : 0);
  const endMs = Math.max(relMs(e.updated_at), 0);
  const meta = agentMeta(e.assigned_agent);

  // ── Map: districts + buildings ──────────────────────────────────────────
  const districts = new Map();
  const buildings = [];
  const buildingByTool = new Map();
  const ensureDistrict = (d) => { if (!districts.has(d[0])) districts.set(d[0], { id: d[0], name: d[1], tone: d[2] }); return d[0]; };
  const toolBuilding = (tool) => {
    if (buildingByTool.has(tool)) return buildingByTool.get(tool);
    const d = TOOL_DISTRICT[tool] || DEFAULT_DISTRICT;
    ensureDistrict(d);
    const id = 'tool:' + tool;
    buildings.push({ id, label: toolLabel(tool), district: d[0], kind: 'tool', uses: 0, storeys: 3 });
    buildingByTool.set(tool, id);
    return id;
  };
  for (const en of entities) {
    const dt = (en.entity_type || 'concept').toLowerCase();
    const dId = 'kd:' + dt;
    ensureDistrict([dId, cap(dt), 'a']);
    buildings.push({
      id: 'ent:' + en.entity_id, label: en.canonical_name, district: dId,
      kind: DOC_TYPES.has(dt) ? 'doc' : 'concept', uses: 1, storeys: 2
    });
  }

  // ── Route: ordered waypoints + controller log ───────────────────────────
  const waypoints = [{ buildingId: null, reason: 'Task received at the Question Hub', atMs: 0, offRoad: false, phase: 'hub' }];
  const events = [{ atMs: 0, title: 'Task issued', body: `Routed to ${meta.name}. Budget ${e.max_tokens} tokens.`, kind: 'plato' }];
  let toolCursor = 0;

  for (const lg of logs) {
    const c = lg.content || {};
    const at = relMs(lg.started_at);
    if (lg.phase === 'using_tool') {
      const tool = c.tool || (toolRows[toolCursor] && toolRows[toolCursor].tool_name) || 'tool';
      const bId = toolBuilding(tool);
      const b = buildings.find((x) => x.id === bId); if (b) b.uses++;
      const errored = !!c.error;
      waypoints.push({
        buildingId: bId,
        reason: errored ? `Tool "${tool}" failed: ${asText(c.error)}` : (asText(c.input) || `Used ${toolLabel(tool)}`),
        atMs: at, offRoad: errored, phase: 'tool'
      });
      events.push({
        atMs: at, title: `${meta.name} used ${toolLabel(tool)}`,
        body: errored ? 'Failed: ' + asText(c.error) : asText(c.input), kind: errored ? 'fog' : (e.assigned_agent || 'plato')
      });
      toolCursor++;
    } else if (lg.phase === 'planning') {
      const steps = c.plan && Array.isArray(c.plan.steps) ? c.plan.steps.length : 0;
      events.push({ atMs: at, title: `Planned ${steps} step${steps === 1 ? '' : 's'}`, body: '', kind: 'plato' });
    } else if (lg.phase === 'thinking') {
      const last = waypoints.length ? waypoints[waypoints.length - 1].buildingId : null;
      waypoints.push({ buildingId: last, reason: asText(c.thought) || 'Reasoning', atMs: at, offRoad: false, phase: 'think' });
    } else if (lg.phase === 'waiting') {
      events.push({ atMs: at, title: 'Waiting for approval', body: asText(c.message || c.reason), kind: 'plato' });
    }
  }

  const okReason = e.completion_reason || (e.current_state === 'completed' ? 'natural' : e.current_state);
  const isDone = ['completed', 'failed', 'cancelled'].includes(e.current_state);

  // Sources + verification.
  const sources = extractSources(toolRows);
  const unverified = sources.filter((s) => !s.verified).length;
  const erroredTools = toolRows.filter((t) => t.error);

  // Terminal waypoint at the answer.
  if (isDone) {
    const last = waypoints.length ? waypoints[waypoints.length - 1].buildingId : null;
    waypoints.push({
      buildingId: last, reason: reflection?.summary || asText(e.result, 140) || reasonTitle(okReason),
      atMs: endMs, offRoad: false, phase: 'answer'
    });
    events.push({
      atMs: endMs, title: reasonTitle(okReason), body: asText(e.result, 200),
      kind: okReason === 'natural' ? 'done' : 'fog'
    });
  }
  if (reflection && reflection.summary) {
    events.push({ atMs: endMs, title: 'Verified by reflection', body: asText(reflection.summary, 180), kind: 'clear' });
  }

  // ── Fog: what the run couldn't ground ────────────────────────────────────
  const fog = [];
  for (const t of erroredTools) {
    fog.push({ name: `${toolLabel(t.tool_name)} returned no ground`, state: 'unknown', body: `The ${toolLabel(t.tool_name)} call failed (${asText(t.error, 100)}). Anything downstream of it was asserted without that source.` });
  }
  if (okReason === 'budget_exceeded') {
    fog.push({ name: 'Answer cut off by budget', state: 'unknown', body: 'The run hit its token ceiling before finishing. The tail of the reasoning was produced under pressure or not at all.' });
  }
  for (const s of sources.filter((x) => !x.verified).slice(0, 2)) {
    fog.push({ name: `Unverified: ${asText(s.title, 60)}`, state: 'unknown', body: `Cited from ${s.tool}, a community source. Treated as opinion until corroborated.` });
  }

  // ── Vitals ───────────────────────────────────────────────────────────────
  const confidence = okReason === 'natural' ? 88 : okReason === 'budget_exceeded' ? 52 : okReason === 'error' ? 34 : 70;
  const risk = clamp(Math.round(erroredTools.length * 22 + unverified * 14), 0, 95);
  const verified = isDone && okReason === 'natural' && erroredTools.length === 0 && unverified === 0;
  const chain = toolRows.length
    ? `${meta.name} routed ${meta.name === 'Plato' ? '' : 'via '}${toolRows.map((t) => toolLabel(t.tool_name)).join(' → ')} → answer.`
    : `${meta.name} answered directly, with no external tools.`;

  const agent = {
    id: e.assigned_agent || 'plato', name: meta.name, role: meta.role, color: meta.color, avatar: meta.avatar,
    fuel: round1((e.tokens_used || 0) / 1000), fuelCap: Math.max(1, round1((e.max_tokens || 15000) / 1000)),
    promptTokens: e.prompt_tokens_used || 0, completionTokens: e.completion_tokens_used || 0,
    iterations: e.iterations_used || 0, toolCalls: e.tool_calls_used || 0,
    confidence, risk, rate: clamp(Math.round(confidence * 0.8), 10, 95),
    completionReason: okReason, state: e.current_state,
    bio: reflection?.summary || `Answered “${asText(e.goal, 90)}” using ${toolRows.length} tool call${toolRows.length === 1 ? '' : 's'} over ${e.iterations_used || 0} reasoning turn${(e.iterations_used || 0) === 1 ? '' : 's'}.`,
    chain, finishAt: endMs
  };

  // Why Plato selected this agent (capability vs history), stamped into metrics
  // by CognitiveCore at routing time.
  let metrics = e.metrics;
  if (typeof metrics === 'string') { try { metrics = JSON.parse(metrics); } catch (_) { metrics = null; } }
  const routing = (metrics && metrics.routing) || null;

  return {
    executionId, question: e.goal, createdAt: e.created_at, updatedAt: e.updated_at,
    durationMs: endMs, live: !isDone,
    agent, districts: [...districts.values()], buildings, waypoints, events, fog, sources, routing,
    verification: { verified, summary: reflection?.summary || null, reason: okReason }
  };
}

// Shared map-location helpers — reused by the live stream (BrainStream.js) so a
// tool/entity lands on exactly the same building live as it does on replay.
function toolLocation(tool) {
  const d = TOOL_DISTRICT[tool] || DEFAULT_DISTRICT;
  return { buildingId: 'tool:' + tool, label: toolLabel(tool), district: d[0], districtName: d[1], tone: d[2], kind: 'tool' };
}
function entityLocation(entityType, entityId, name) {
  const dt = (entityType || 'concept').toLowerCase();
  return { buildingId: 'ent:' + entityId, label: name, district: 'kd:' + dt, districtName: cap(dt), tone: 'a', kind: DOC_TYPES.has(dt) ? 'doc' : 'concept' };
}

module.exports = { buildExecutionTrace, toolLocation, entityLocation, agentMeta };
