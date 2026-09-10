// tools/SystemStatusTool.js — what the system is ACTUALLY doing right now.
//
// Written because the supervisor was asked "is atlas working?" and answered
// "Yes, Atlas is fully operational. It continuously monitors your holdings…" —
// a fluent recital of the roster paragraph in its own system prompt. Atlas was
// at that moment failing every single message: his answers were being written
// as sender 'ATLAS', there was no such row in users, and the foreign key threw
// after the user's question had already been committed. The chat showed a
// question with no reply, and the supervisor could not tell, because nothing in
// the system let it look.
//
// So this tool reads the ground truth an agent cannot infer from its prompt:
//
//   - is the agent configured, addressable, and does it hold any tools?
//   - can it DELIVER? (the users row its messages are stored against — the exact
//     thing missing for Atlas. An agent can execute perfectly and still be
//     unable to say anything.)
//   - what happened on its last runs, and how many of them completed naturally
//     rather than erroring, hitting a budget, or stalling?
//   - when did it last actually reach this user in chat?
//   - what standing work does it own, and is that work failing?
//
// Read-only, and scoped to the signed-in user for anything user-owned. The
// agent roster and its health are system-wide by nature — they say nothing
// about any other user's data.
const { query } = require('../database');
const { personas } = require('../services/personas');

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  // Plain-string convenience: "atlas" | "agents" | "agent atlas"
  const m = s.match(/^(?:agents?\s+)?([a-z_]+)/i);
  if (m && personas[m[1].toLowerCase()]) return { agent: m[1].toLowerCase() };
  return {};
}

/** Completion reasons that mean the run produced a real answer. */
const HEALTHY_REASONS = new Set(['natural']);

/**
 * Health verdict for one agent, from the evidence gathered below.
 *
 * "broken" is reserved for defects that make the agent unable to answer AT ALL,
 * because that is the case that must never be reported as fine. Everything
 * softer is "degraded" — the supervisor should say what is wrong rather than
 * pronouncing it dead.
 */
function verdictFor(a) {
  const problems = [];
  if (!a.configured) problems.push('no agent_configs row — it has no tools, budget or runtime settings');
  if (!a.canDeliver) {
    problems.push(
      `no identity row in users for sender "${a.agentId.toUpperCase()}" — every reply it writes is rejected ` +
      'by the messages foreign key AFTER the run succeeds, so the user sees their question and no answer'
    );
  }
  if (a.configured && !a.isDirectAddressable) problems.push('not directly addressable — it can only be reached by delegation');
  if (a.runs.total > 0 && a.runs.healthy === 0) problems.push(`none of its last ${a.runs.total} run(s) completed naturally`);
  if (a.failingMissions > 0) problems.push(`${a.failingMissions} standing task(s) failing repeatedly`);
  if (a.deliveryGap) {
    problems.push(
      'its last completed run never reached the chat — the answer was produced and then lost on the way to ' +
      'the conversation. If the cause has just been fixed this clears itself the next time the agent answers, ' +
      'so say when the lost run was rather than declaring it fine'
    );
  }

  const broken = !a.configured || !a.canDeliver || (a.runs.total > 0 && a.runs.healthy === 0);
  if (broken) return { status: 'broken', problems };
  if (problems.length) return { status: 'degraded', problems };
  if (a.runs.total === 0) {
    return {
      status: 'untested',
      problems: [],
      note: 'Configured and able to deliver, but it has not run for this user yet — say that plainly rather than calling it proven.'
    };
  }
  return { status: 'healthy', problems: [] };
}

async function execute(input, context = {}) {
  const { agent } = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') {
    throw new Error('System status requires a signed-in user context');
  }

  const roster = Object.keys(personas);
  const wanted = agent && roster.includes(agent) ? [agent] : roster;
  if (agent && !roster.includes(agent)) {
    return {
      requested: agent,
      error: `There is no agent called "${agent}". The roster is: ${roster.join(', ')}. Do not invent one.`,
      agents: []
    };
  }

  // One round trip per fact rather than per agent: the database is ~126ms away,
  // and this tool runs inside a chat turn the user is waiting on.
  const [configs, identities, runs, lastRuns, lastChatRuns, chats, missions] = await Promise.all([
    query('SELECT agent_id, is_direct_addressable, tools FROM agent_configs WHERE agent_id = ANY($1)', [wanted]),

    // The delivery check. sender_id on messages is a foreign key into users, and
    // routes/aiChat.js stores agent replies under the UPPERCASED persona id.
    query('SELECT user_id FROM users WHERE user_id = ANY($1)',
      [wanted.map(a => a.toUpperCase())]),

    query(`
      SELECT assigned_agent, completion_reason, COUNT(*)::int AS count
      FROM executions
      WHERE assigned_agent = ANY($1) AND user_id = $2
        AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY assigned_agent, completion_reason
    `, [wanted, userId]),

    query(`
      SELECT DISTINCT ON (assigned_agent)
             assigned_agent, completion_reason, current_state, created_at,
             LEFT(COALESCE(result, ''), 200) AS result_preview
      FROM executions
      WHERE assigned_agent = ANY($1) AND user_id = $2
      ORDER BY assigned_agent, created_at DESC
    `, [wanted, userId]),

    // The symptom side of the delivery check above, per chat run: did the reply
    // this run produced ever land in the conversation it belongs to?
    //
    // Restricted to CHAT executions. A mission or briefing run delivers through
    // notifications and writes no assistant turn, and a group-chat run writes to
    // the group — counting those as lost answers flags every healthy agent that
    // happens to have run a scheduled task most recently. The origin is encoded
    // in conversation_id: mission_*, briefing_* and group_* are not chat.
    query(`
      SELECT DISTINCT ON (e.assigned_agent)
             e.assigned_agent, e.conversation_id, e.completion_reason, e.created_at,
             (SELECT MAX(c.created_at) FROM ai_conversations c
               WHERE c.session_id = e.conversation_id AND c.user_id = e.user_id
                 AND c.persona = e.assigned_agent AND c.role = 'assistant') AS reply_at
      FROM executions e
      WHERE e.assigned_agent = ANY($1) AND e.user_id = $2
        AND e.conversation_id IS NOT NULL
        AND e.conversation_id NOT LIKE 'mission_%'
        AND e.conversation_id NOT LIKE 'briefing_%'
        AND e.conversation_id NOT LIKE 'group_%'
      ORDER BY e.assigned_agent, e.created_at DESC
    `, [wanted, userId]),

    // Did an answer from this agent ever actually land in the user's chat?
    query(`
      SELECT persona,
             MAX(created_at) FILTER (WHERE role = 'assistant') AS last_reply_at,
             COUNT(*) FILTER (WHERE role = 'assistant')::int  AS replies,
             COUNT(*) FILTER (WHERE role = 'user')::int       AS questions
      FROM ai_conversations
      WHERE persona = ANY($1) AND user_id = $2
      GROUP BY persona
    `, [wanted, userId]),

    query(`
      SELECT agent_id,
             COUNT(*) FILTER (WHERE enabled)::int                              AS enabled,
             COUNT(*) FILTER (WHERE enabled AND consecutive_failures >= 3)::int AS failing,
             MIN(next_run_at) FILTER (WHERE enabled)                            AS next_run_at
      FROM agent_missions
      WHERE agent_id = ANY($1) AND user_id = $2
      GROUP BY agent_id
    `, [wanted, userId])
  ]);

  const configBy = new Map(configs.rows.map(r => [r.agent_id, r]));
  const identitySet = new Set(identities.rows.map(r => String(r.user_id).toLowerCase()));
  const lastRunBy = new Map(lastRuns.rows.map(r => [r.assigned_agent, r]));
  const lastChatRunBy = new Map(lastChatRuns.rows.map(r => [r.assigned_agent, r]));
  const chatBy = new Map(chats.rows.map(r => [r.persona, r]));
  const missionBy = new Map(missions.rows.map(r => [r.agent_id, r]));

  const runsBy = new Map();
  for (const r of runs.rows) {
    const entry = runsBy.get(r.assigned_agent) || { total: 0, healthy: 0, byReason: {} };
    entry.total += r.count;
    if (HEALTHY_REASONS.has(r.completion_reason)) entry.healthy += r.count;
    entry.byReason[r.completion_reason || 'unknown'] = r.count;
    runsBy.set(r.assigned_agent, entry);
  }

  const agents = wanted.map(agentId => {
    const persona = personas[agentId];
    const cfg = configBy.get(agentId);
    const chat = chatBy.get(agentId);
    const mission = missionBy.get(agentId);
    const lastRun = lastRunBy.get(agentId);
    const runStats = runsBy.get(agentId) || { total: 0, healthy: 0, byReason: {} };

    const a = {
      agentId,
      name: persona.name,
      role: persona.roleTitle,
      configured: !!cfg,
      canDeliver: identitySet.has(agentId),
      isDirectAddressable: cfg ? cfg.is_direct_addressable === 1 : false,
      tools: cfg && Array.isArray(cfg.tools) ? cfg.tools : [],
      runs: {
        total: runStats.total,
        healthy: runStats.healthy,
        byCompletionReason: runStats.byReason,
        window: 'last 30 days, this user only'
      },
      lastRun: lastRun ? {
        at: lastRun.created_at,
        state: lastRun.current_state,
        completionReason: lastRun.completion_reason,
        resultPreview: lastRun.result_preview || null
      } : null,
      chat: {
        questionsAsked: chat ? chat.questions : 0,
        repliesDelivered: chat ? chat.replies : 0,
        lastReplyAt: chat ? chat.last_reply_at : null
      },
      standingTasks: {
        enabled: mission ? mission.enabled : 0,
        failing: mission ? mission.failing : 0,
        nextRunAt: mission ? mission.next_run_at : null
      }
    };
    a.failingMissions = a.standingTasks.failing;

    // An answered run with no delivered reply is the fingerprint of a write that
    // failed after the agent had already done the work. Call it out by name —
    // it looks like "the agent is broken" from the outside and like "the agent
    // is fine" from the execution log, and neither reading leads to the fix.
    //
    // Measured against the LAST CHAT run rather than a lifetime count, so it
    // clears itself once the agent answers again. A lifetime count would keep
    // accusing a repaired agent of a fault it no longer has.
    const lastChat = lastChatRunBy.get(agentId);
    if (lastChat && HEALTHY_REASONS.has(lastChat.completion_reason)
      && (!lastChat.reply_at || new Date(lastChat.reply_at) < new Date(lastChat.created_at))) {
      a.deliveryGap = {
        lastCompletedRunAt: lastChat.created_at,
        session: lastChat.conversation_id,
        detail: 'This chat run completed and produced an answer, but no reply from this agent was stored in that conversation — the answer was lost between the agent and the chat, not failed in the making.'
      };
    }

    Object.assign(a, verdictFor(a));
    delete a.failingMissions;
    return a;
  });

  const broken = agents.filter(a => a.status === 'broken');
  const degraded = agents.filter(a => a.status === 'degraded');

  return {
    checkedAt: new Date().toISOString(),
    scope: 'Agent configuration and delivery are system-wide; run, chat and task counts are for the signed-in user only.',
    agents,
    summary: {
      total: agents.length,
      broken: broken.map(a => a.agentId),
      degraded: degraded.map(a => a.agentId),
      healthy: agents.filter(a => a.status === 'healthy').map(a => a.agentId),
      untested: agents.filter(a => a.status === 'untested').map(a => a.agentId)
    },
    note: broken.length
      ? `REPORT THIS HONESTLY: ${broken.map(a => `${a.name} is broken (${a.problems.join('; ')})`).join(' | ')}. Do not describe a broken agent by what it is designed to do.`
      : undefined
  };
}

module.exports = { execute, verdictFor };
