// services/agents/DebateOrchestrator.js — Sprint 5 · Phase 5A
// Multi-Agent Debate & Inter-Agent Collaboration.
//
// Flow:
//   1. Sentinel pre-check (governance/fraud) — same gate as PlatoOrchestrator.route().
//   2. Peer delegation: Plato selects 2–3 specialists whose capabilities fit the goal.
//   3. Opening positions: each specialist runs its OWN scoped Cognitive Core (with its
//      tools) on the goal — so opening arguments are grounded in real tool data.
//   4. Conflict detection: Plato judges whether the positions genuinely disagree.
//   5. Debate rounds (only if conflict): up to `maxRounds` structured rebuttal rounds,
//      each agent reasoning over the running transcript (no fresh tool loops — the
//      evidence was already gathered in step 3).
//   6. Consensus: Plato synthesizes one executive decision from the full transcript.
//
// Persistence is best-effort — a debate still returns even if DB writes fail.

const { BaseAgent } = require('./BaseAgent');
const { SentinelAgent } = require('./SentinelAgent');
const { listActiveAgents, getAgentConfig, scoreCapabilities } = require('./AgentRegistry');
const { getPersona } = require('../personas');
const { runInference } = require('../inference');
const { eventBus } = require('../cognitive/EventBus');
const { query } = require('../../database');

const DEFAULT_PANEL = ['aurelius', 'nova', 'rasha'];
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 3;

/**
 * Resolve an agent's system prompt (persona roster first, then DB registry).
 */
async function getAgentPrompt(agentId) {
  const persona = getPersona(agentId);
  if (persona && persona.systemPrompt) return persona.systemPrompt;
  const cfg = await getAgentConfig(agentId);
  return cfg?.systemPrompt || `You are ${agentId}, a specialist agent at FinChat.`;
}

/**
 * Resolve a friendly display name for an agent.
 */
async function getAgentName(agentId) {
  const persona = getPersona(agentId);
  if (persona && persona.name) return persona.name;
  const cfg = await getAgentConfig(agentId);
  return cfg?.name || agentId;
}

/**
 * Safe JSON parse with code-fence stripping and object extraction — mirrors the
 * tolerance in ReasoningEngine.parseActionResponse but for arbitrary shapes.
 */
function safeJsonParse(raw) {
  let cleaned = (raw || '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

/**
 * Peer delegation: pick the specialists best suited to the goal.
 * Excludes the orchestrator (Plato) and middleware (Sentinel). Always returns at
 * least MIN_PARTICIPANTS by topping up from the default panel so a debate can happen.
 *
 * @param {string} goal
 * @param {string[]|null} requested - explicit participant ids (overrides scoring)
 * @returns {Promise<string[]>}
 */
async function selectParticipants(goal, requested = null) {
  const specialists = (await listActiveAgents({ includeMiddleware: false }))
    .filter(a => a.type === 'specialist');
  const validIds = new Set(specialists.map(a => a.agentId));

  // Explicit request wins (filtered to real specialists)
  if (Array.isArray(requested) && requested.length > 0) {
    const chosen = requested.map(id => id.toLowerCase()).filter(id => validIds.has(id));
    if (chosen.length >= MIN_PARTICIPANTS) return chosen.slice(0, MAX_PARTICIPANTS);
    // fall through to top up below, seeded with whatever was valid
    return topUp(chosen, validIds);
  }

  // Capability scoring
  const scored = specialists
    .map(a => ({ id: a.agentId, score: scoreCapabilities(a, goal) }))
    .sort((x, y) => y.score - x.score);

  const matched = scored.filter(s => s.score > 0).map(s => s.id);
  if (matched.length >= MIN_PARTICIPANTS) return matched.slice(0, MAX_PARTICIPANTS);

  return topUp(matched, validIds);
}

/**
 * Ensure at least MIN_PARTICIPANTS by appending default-panel agents.
 */
function topUp(seed, validIds) {
  const out = [...seed];
  for (const id of DEFAULT_PANEL) {
    if (out.length >= MIN_PARTICIPANTS) break;
    if (validIds.has(id) && !out.includes(id)) out.push(id);
  }
  // Last resort: if registry is sparse, still return the seed (may be < 2)
  return out.slice(0, MAX_PARTICIPANTS);
}

/**
 * Gather each participant's grounded opening position by running its own
 * Cognitive Core (which uses the specialist's assigned tools).
 */
async function gatherOpeningPositions({ goal, participants, userId, conversationId }) {
  const positions = [];
  for (const agentId of participants) {
    const name = await getAgentName(agentId);
    let position = '';
    let executionId = null;
    try {
      const agent = await BaseAgent.fromRegistry(agentId);
      if (!agent) throw new Error(`Agent "${agentId}" not found in registry`);

      const framedGoal =
        `${goal}\n\n(Respond with your expert ${name} perspective. ` +
        `Use your tools to ground your view in real data where relevant, then state a clear position.)`;

      const result = await agent.execute({ goal: framedGoal, userId, conversationId });
      position = (result.cleanResponse || result.response || '').trim();
      executionId = result.executionId || null;
    } catch (err) {
      console.warn(`⚠️ DebateOrchestrator: opening position for "${agentId}" failed: ${err.message}`);
      position = `(${name} was unable to produce a position: ${err.message})`;
    }
    positions.push({ agentId, name, position, executionId });
  }
  return positions;
}

/**
 * Plato judges whether the opening positions genuinely conflict.
 * @returns {Promise<{ conflict: boolean, summary: string, axes: string[] }>}
 */
async function detectConflict({ goal, positions }) {
  const platoPrompt = await getAgentPrompt('plato');
  const transcript = positions
    .map(p => `### ${p.name} (${p.agentId})\n${p.position}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        `${platoPrompt}\n\nYou are moderating an internal expert panel. Judge — impartially — ` +
        `whether the experts genuinely DISAGREE on a decision-relevant point, versus merely ` +
        `covering different angles that already fit together.\n` +
        `Respond ONLY with JSON: {"conflict": boolean, "summary": string, "axes": string[]}. ` +
        `"summary" is one sentence. "axes" lists the specific points of disagreement (empty if none).`
    },
    {
      role: 'user',
      content: `Decision under debate:\n${goal}\n\nExpert opening positions:\n\n${transcript}`
    }
  ];

  try {
    const res = await runInference({ messages, temperature: 0.2, jsonMode: true });
    const parsed = safeJsonParse(res.content);
    if (parsed && typeof parsed.conflict === 'boolean') {
      return {
        conflict: parsed.conflict,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        axes: Array.isArray(parsed.axes) ? parsed.axes : []
      };
    }
  } catch (err) {
    console.warn(`⚠️ DebateOrchestrator: conflict detection failed: ${err.message}`);
  }
  // Conservative default: no conflict → skip debate rounds, go straight to synthesis
  return { conflict: false, summary: '', axes: [] };
}

/**
 * Render the full running transcript (opening + any rebuttal rounds) as text.
 */
function renderTranscript(transcript) {
  const byRound = {};
  for (const a of transcript) {
    (byRound[a.round] = byRound[a.round] || []).push(a);
  }
  return Object.keys(byRound)
    .map(Number)
    .sort((a, b) => a - b)
    .map(round => {
      const label = round === 0 ? 'Opening Positions' : `Debate Round ${round}`;
      const body = byRound[round].map(a => `### ${a.name} (${a.agentId})\n${a.position}`).join('\n\n');
      return `## ${label}\n\n${body}`;
    })
    .join('\n\n');
}

/**
 * Run one structured rebuttal round. Each agent reasons over the running transcript.
 * Uses direct inference (no tool loop) — the evidence was gathered in the opening round.
 */
async function runDebateRound({ goal, participants, transcript, roundNumber, conflict }) {
  const roundArgs = [];
  const transcriptText = renderTranscript(transcript);

  for (const agentId of participants) {
    const name = await getAgentName(agentId);
    const prompt = await getAgentPrompt(agentId);

    const messages = [
      {
        role: 'system',
        content:
          `${prompt}\n\nYou are in a structured expert debate moderated by Plato. ` +
          `Points of contention: ${conflict.axes.length ? conflict.axes.join('; ') : conflict.summary || 'the core recommendation'}.\n` +
          `Defend or REFINE your position in light of your peers' arguments. Concede points that are ` +
          `genuinely valid; sharpen genuine disagreements with evidence and reasoning. ` +
          `Be concise (under 180 words). Do NOT restate your whole opening — advance the debate.`
      },
      {
        role: 'user',
        content:
          `Decision under debate:\n${goal}\n\nDebate so far:\n\n${transcriptText}\n\n` +
          `It is Debate Round ${roundNumber}. Give ${name}'s updated position.`
      }
    ];

    let position = '';
    try {
      const res = await runInference({ messages, temperature: 0.6 });
      position = (res.content || '').trim();
    } catch (err) {
      console.warn(`⚠️ DebateOrchestrator: round ${roundNumber} rebuttal for "${agentId}" failed: ${err.message}`);
      position = `(${name} did not respond this round.)`;
    }
    roundArgs.push({ agentId, name, position, round: roundNumber });
  }

  eventBus.emit('debate:round', {
    roundNumber,
    participants,
    timestamp: new Date().toISOString()
  });

  return roundArgs;
}

/**
 * Plato synthesizes the full transcript into a single executive decision.
 */
async function synthesizeConsensus({ goal, transcript, conflict }) {
  const platoPrompt = await getAgentPrompt('plato');
  const transcriptText = renderTranscript(transcript);

  const messages = [
    {
      role: 'system',
      content:
        `${platoPrompt}\n\nYou chaired an expert debate. Synthesize it into ONE executive decision. ` +
        (conflict.conflict
          ? `Acknowledge the disagreement (${conflict.summary}), weigh each side's evidence, and take a clear position.`
          : `The experts broadly aligned — integrate their angles into one coherent recommendation.`) +
        `\nStructure: a 1–2 sentence verdict, the key reasoning, and a short "Confidence" note. Be decisive.`
    },
    {
      role: 'user',
      content: `Decision:\n${goal}\n\nFull expert debate:\n\n${transcriptText}\n\nProvide the final executive decision.`
    }
  ];

  const res = await runInference({ messages, temperature: 0.4 });
  return (res.content || '').trim();
}

// ── Persistence (best-effort) ─────────────────────────────────────────────

async function persistDebateStart(debate) {
  try {
    await query(
      `INSERT INTO debates (debate_id, user_id, conversation_id, goal, orchestrator_agent, participants, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
      [debate.debateId, debate.userId, debate.conversationId, debate.goal, 'plato',
        JSON.stringify(debate.participants)]
    );
  } catch (err) {
    console.warn(`⚠️ DebateOrchestrator: failed to persist debate start: ${err.message}`);
  }
}

async function persistArguments(debateId, args) {
  for (const a of args) {
    try {
      await query(
        `INSERT INTO debate_arguments (debate_id, round_number, agent_id, position, execution_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [debateId, a.round, a.agentId, a.position, a.executionId || null]
      );
    } catch (err) {
      console.warn(`⚠️ DebateOrchestrator: failed to persist argument (${a.agentId} r${a.round}): ${err.message}`);
    }
  }
}

async function persistDebateEnd(debate) {
  try {
    await query(
      `UPDATE debates
       SET conflict_detected = $2, conflict_summary = $3, rounds_run = $4,
           final_consensus = $5, status = $6, updated_at = now()
       WHERE debate_id = $1`,
      [debate.debateId, debate.conflictDetected, debate.conflictSummary,
        debate.roundsRun, debate.consensus, debate.status]
    );
  } catch (err) {
    console.warn(`⚠️ DebateOrchestrator: failed to persist debate end: ${err.message}`);
  }
}

/**
 * Run a full multi-agent debate.
 *
 * @param {object} opts
 * @param {string} opts.goal
 * @param {string} [opts.userId='system']
 * @param {string} [opts.conversationId=null]
 * @param {string[]} [opts.participants] - explicit participant ids (else auto-selected)
 * @param {number} [opts.maxRounds=2] - max rebuttal rounds when a conflict is found
 * @returns {Promise<object>} debate result including full transcript and consensus
 */
async function runDebate({ goal, userId = 'system', conversationId = null, participants = null, maxRounds = 2 } = {}) {
  if (!goal || !goal.trim()) throw new Error('runDebate requires a non-empty goal');

  // 1. Sentinel governance gate
  const preCheck = await SentinelAgent.preCheck(goal, { userId });
  if (!preCheck.allowed) {
    return {
      debateId: `blocked_${Date.now()}`,
      goal,
      blocked: true,
      status: 'blocked',
      conflictDetected: false,
      participants: [],
      transcript: [],
      consensus: preCheck.reason,
      response: preCheck.reason,
      fraudDetected: Boolean(preCheck.fraudDetected)
    };
  }

  const debateId = `debate_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const chosen = await selectParticipants(goal, participants);

  eventBus.emit('debate:started', {
    debateId, goal, participants: chosen, userId, timestamp: new Date().toISOString()
  });

  await persistDebateStart({ debateId, userId, conversationId, goal, participants: chosen });

  // 2. Opening positions (grounded, tool-using)
  const opening = await gatherOpeningPositions({ goal, participants: chosen, userId, conversationId });
  const transcript = opening.map(p => ({ ...p, round: 0 }));
  await persistArguments(debateId, transcript);

  eventBus.emit('debate:positions_gathered', {
    debateId, participants: chosen, timestamp: new Date().toISOString()
  });

  // 3. Conflict detection
  const conflict = await detectConflict({ goal, positions: opening });
  eventBus.emit('debate:conflict', {
    debateId, conflict: conflict.conflict, summary: conflict.summary, timestamp: new Date().toISOString()
  });

  // 4. Debate rounds (only if there's a real conflict to resolve)
  let roundsRun = 0;
  if (conflict.conflict) {
    for (let r = 1; r <= maxRounds; r++) {
      const roundArgs = await runDebateRound({
        goal, participants: chosen, transcript, roundNumber: r, conflict
      });
      transcript.push(...roundArgs);
      await persistArguments(debateId, roundArgs);
      roundsRun = r;
    }
  }

  // 5. Consensus synthesis
  const consensus = await synthesizeConsensus({ goal, transcript, conflict });

  const result = {
    debateId,
    goal,
    participants: opening.map(p => ({ agentId: p.agentId, name: p.name })),
    conflictDetected: conflict.conflict,
    conflictSummary: conflict.summary,
    conflictAxes: conflict.axes,
    roundsRun,
    transcript: transcript.map(t => ({ round: t.round, agentId: t.agentId, name: t.name, position: t.position })),
    consensus,
    response: consensus, // alias for API/chat consistency
    status: 'completed'
  };

  await persistDebateEnd(result);

  if (userId && userId !== 'system') {
    const { createNotification } = require('../notifications');
    const names = result.participants.map(p => p.name).join(' & ');
    await createNotification({
      userId,
      type: 'debate',
      title: '🏛️ Council debate concluded',
      content: `${names} debated "${goal.slice(0, 80)}${goal.length > 80 ? '…' : ''}". ` +
        (conflict.conflict ? `Resolved over ${roundsRun} round(s).` : 'Consensus reached without conflict.')
    });
  }

  eventBus.emit('debate:completed', {
    debateId,
    conflictDetected: conflict.conflict,
    roundsRun,
    participantCount: chosen.length,
    timestamp: new Date().toISOString()
  });

  return result;
}

module.exports = {
  runDebate,
  selectParticipants,
  detectConflict,
  synthesizeConsensus,
  DEFAULT_PANEL
};
