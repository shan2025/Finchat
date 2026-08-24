// services/cognitive/ReportEngine.js — Sprint Y · Reports
//
// Turns the live memory vitals into periodic, shareable narratives. Each report
// is: (1) gather the numbers for a period, (2) one LLM pass to write a plain-
// English summary, (3) persist to report_snapshots. Generation is best-effort —
// if the LLM is unavailable the report still saves with a deterministic summary
// so Reports never hard-fails.

const { randomUUID } = require('crypto');
const { query } = require('../../database');
const { runInference } = require('../inference');

const KINDS = ['growth', 'agent_learning', 'dream_digest', 'gaps', 'user_profile'];

const TITLES = {
  growth: 'Memory Growth',
  agent_learning: 'Agent Learning',
  dream_digest: 'Dream-Cycle Digest',
  gaps: 'Gaps & Contradictions',
  user_profile: 'User-Interest Profile'
};

// ── gather the numbers for one report kind ─────────────────
async function gather(kind, { userId, days }) {
  const span = `${days} days`;
  if (kind === 'growth') {
    // Every source table is per-user; scope to userId so a growth report reflects
    // only the caller's own memory, not a pool of everyone's activity.
    const [created, activated, edges, top] = await Promise.all([
      query(`SELECT COUNT(*)::int n FROM node_events WHERE event_type='created' AND user_id=$2 AND created_at > now() - ($1||' days')::interval`, [String(days), userId]),
      query(`SELECT COUNT(*)::int n FROM node_events WHERE event_type='activated' AND user_id=$2 AND created_at > now() - ($1||' days')::interval`, [String(days), userId]),
      query(`SELECT COUNT(*)::int n FROM entity_edges WHERE user_id=$2 AND created_at > now() - ($1||' days')::interval`, [String(days), userId]),
      query(`SELECT canonical_name, activation_count FROM entities WHERE status='active' AND user_id=$1 ORDER BY activation_count DESC LIMIT 5`, [userId])
    ]);
    return { conceptsLearned: created.rows[0].n, activations: activated.rows[0].n,
      newLinks: edges.rows[0].n, mostActive: top.rows };
  }
  if (kind === 'agent_learning') {
    const q = await query(`
      SELECT owner_agent AS agent, COUNT(*)::int nodes,
             COALESCE(SUM(activation_count),0)::int activations
      FROM entities WHERE status='active' AND owner_agent IS NOT NULL AND user_id=$1
      GROUP BY owner_agent ORDER BY nodes DESC LIMIT 10`, [userId]);
    return { agents: q.rows };
  }
  if (kind === 'dream_digest') {
    const q = await query(`
      SELECT title, detail, payload, created_at FROM graph_insights
      WHERE kind='dream_report' AND (user_id IS NULL OR user_id=$2)
        AND created_at > now() - ($1||' days')::interval
      ORDER BY created_at DESC LIMIT 10`, [String(days), userId || null]);
    return { dreams: q.rows };
  }
  if (kind === 'gaps') {
    const q = await query(`
      SELECT kind, title, detail, status, created_at FROM graph_insights
      WHERE kind IN ('gap','contradiction') AND (user_id IS NULL OR user_id=$1)
        AND created_at > now() - ($2||' days')::interval
      ORDER BY created_at DESC LIMIT 20`, [userId || null, String(days)]);
    return { insights: q.rows };
  }
  if (kind === 'user_profile') {
    const q = await query(`
      SELECT t.canonical_name AS topic, t.entity_type AS type, e.strength, e.reason
      FROM entity_edges e
      JOIN entities t ON t.entity_id = e.to_entity_id
      WHERE e.edge_type='prefers' AND e.user_id=$1 AND t.status='active'
      ORDER BY e.strength DESC LIMIT 15`, [userId || null]);
    return { preferences: q.rows };
  }
  return {};
}

// Deterministic one-liner used as the summary when the LLM is unavailable.
function fallbackSummary(kind, payload) {
  switch (kind) {
    case 'growth':
      return `Learned ${payload.conceptsLearned || 0} new concept(s) and formed ${payload.newLinks || 0} new link(s), with ${payload.activations || 0} recall activation(s) in the period.`;
    case 'agent_learning':
      return `${(payload.agents || []).length} agent(s) hold owned knowledge; ${(payload.agents || [])[0]?.agent || 'no agent'} leads with ${(payload.agents || [])[0]?.nodes || 0} concept(s).`;
    case 'dream_digest':
      return `${(payload.dreams || []).length} consolidation cycle(s) ran in the period.`;
    case 'gaps':
      return `${(payload.insights || []).length} open gap(s)/contradiction(s) recorded.`;
    case 'user_profile':
      return `${(payload.preferences || []).length} learned preference(s) about what you care about.`;
    default:
      return 'Report generated.';
  }
}

const NARRATE_PROMPT = `You write short, factual internal reports about an AI system's memory.
Given a report kind and its JSON metrics, write 2-4 plain-English sentences summarizing
what the numbers show. Be concrete, cite the numbers, no fluff, no markdown, no bullet points.`;

async function narrate(kind, payload, userId) {
  try {
    const res = await runInference({
      messages: [
        { role: 'system', content: NARRATE_PROMPT },
        { role: 'user', content: `KIND: ${kind}\n\nMETRICS:\n${JSON.stringify(payload).slice(0, 4000)}` }
      ],
      temperature: 0.3,
      feature: 'report',
      userId: userId || null
    });
    const text = (res.content || '').trim();
    return text.length > 10 ? text : fallbackSummary(kind, payload);
  } catch (err) {
    console.warn(`⚠️ ReportEngine.narrate failed: ${err.message}`);
    return fallbackSummary(kind, payload);
  }
}

/**
 * Generate and persist one report. Returns the saved snapshot row.
 */
async function generate({ kind, userId = null, days = 7 }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - days * 86400000);

  const payload = await gather(kind, { userId, days });
  const summary = await narrate(kind, payload, userId);
  const reportId = `rep_${kind}_${randomUUID().slice(0, 10)}`;

  await query(`
    INSERT INTO report_snapshots (report_id, kind, title, user_id, period_start, period_end, summary, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [reportId, kind, TITLES[kind] || kind, userId,
    periodStart.toISOString(), periodEnd.toISOString(), summary, JSON.stringify(payload)]);

  return { report_id: reportId, kind, title: TITLES[kind] || kind, user_id: userId,
    period_start: periodStart.toISOString(), period_end: periodEnd.toISOString(),
    summary, payload, created_at: new Date().toISOString() };
}

module.exports = { generate, gather, KINDS, TITLES };
