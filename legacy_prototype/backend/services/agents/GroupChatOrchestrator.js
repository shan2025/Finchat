// services/agents/GroupChatOrchestrator.js — multi-agent group chat (Sprint 8)
//
// A group chat is the user + N agents in one room. When the user posts:
//   1. Responders are chosen: every @mentioned member agent, otherwise the
//      member whose capabilities best match the message (fallback: first agent).
//   2. The primary responder answers through the FULL cognitive core (route()),
//      so replies are tool-grounded (live prices, news, web).
//   3. Up to one other member may add a short follow-up ("agents talking to
//      each other") via a lightweight inference call that sees the whole room.
//   4. "/task @agent <goal>" (or the explicit endpoint) assigns real work: the
//      agent runs the goal in the background and posts its result back into
//      the room, plus a bell notification deep-linking to the group.
//
// Every message is persisted in group_chat_messages and broadcast on the
// EventBus as 'group:message' — server.js relays it into the socket room.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../database');
const { eventBus } = require('../cognitive/EventBus');
const { route } = require('./PlatoOrchestrator');
const { runInference } = require('../inference');
const { getAgentConfig, scoreCapabilities } = require('./AgentRegistry');
const { createNotification } = require('../notifications');

const MAX_CONTEXT_MESSAGES = 15;
const MAX_FOLLOWUPS = 1; // how many other agents may chime in per user message

// Messages addressed to the whole room — every member agent answers.
const BROADCAST_RX = /\b(everyone|everybody|you guys|you all|y'all|all agents|all of you|whole group|the group|team|anyone|hi all|hello all|guys)\b/i;

/** Replace "@aurelius" style mentions with the agent's display name so the
 *  goal stays a complete sentence (stripping them made questions read as
 *  "hey where is ?" and agents answered "your question got cut off"). */
async function mentionsToNames(content) {
  const rx = /@([a-zA-Z0-9_-]+)/g;
  let out = content, m;
  const seen = {};
  while ((m = rx.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (seen[id]) continue;
    seen[id] = true;
    const cfg = await getAgentConfig(id);
    if (cfg) out = out.split('@' + m[1]).join(cfg.name || id);
  }
  return out;
}

// ── Persistence helpers ──────────────────────────────────────
async function saveMessage(groupId, senderType, senderId, content, meta = {}) {
  const messageId = uuidv4();
  await query(`
    INSERT INTO group_chat_messages (message_id, group_id, sender_type, sender_id, content, meta)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [messageId, groupId, senderType, senderId, content, JSON.stringify(meta)]);
  await query('UPDATE group_chats SET updated_at = NOW() WHERE group_id = $1', [groupId]);
  const row = {
    message_id: messageId, group_id: groupId, sender_type: senderType,
    sender_id: senderId, content, meta, created_at: new Date().toISOString()
  };
  eventBus.emit('group:message', row);
  return row;
}

async function getAgentMembers(groupId) {
  const res = await query(
    `SELECT member_id FROM group_chat_members WHERE group_id = $1 AND member_type = 'agent' ORDER BY added_at ASC`,
    [groupId]);
  return res.rows.map(r => r.member_id);
}

async function getRecentMessages(groupId, limit = MAX_CONTEXT_MESSAGES) {
  const res = await query(`
    SELECT sender_type, sender_id, content, created_at FROM group_chat_messages
    WHERE group_id = $1 ORDER BY created_at DESC LIMIT $2
  `, [groupId, limit]);
  return res.rows.reverse();
}

function transcriptFor(messages) {
  return messages.map(m => {
    const who = m.sender_type === 'user' ? 'User' : m.sender_type === 'system' ? 'System' : m.sender_id.toUpperCase();
    return `${who}: ${m.content}`;
  }).join('\n');
}

// ── Responder selection ──────────────────────────────────────
async function pickResponders(groupId, content) {
  const agentIds = await getAgentMembers(groupId);
  if (!agentIds.length) return { primary: null, others: [] };

  // @mentions win — in mention order
  const mentioned = [];
  const mentionRx = /@([a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = mentionRx.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (agentIds.includes(id) && !mentioned.includes(id)) mentioned.push(id);
  }
  if (mentioned.length) {
    return { primary: mentioned[0], others: mentioned.slice(1) };
  }

  // Otherwise capability-score the member agents against the message
  let best = null, bestScore = -1;
  for (const id of agentIds) {
    const cfg = await getAgentConfig(id);
    const score = cfg ? scoreCapabilities(cfg, content) : 0;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return { primary: best || agentIds[0], others: [] };
}

// ── Follow-up (agent reacting to another agent) ──────────────
async function maybeFollowUp(groupId, primaryId, userId) {
  const agentIds = (await getAgentMembers(groupId)).filter(id => id !== primaryId);
  if (!agentIds.length) return;
  const candidateId = agentIds[0];
  const cfg = await getAgentConfig(candidateId);
  if (!cfg) return;

  const history = await getRecentMessages(groupId);
  const messages = [
    {
      role: 'system',
      content: `You are ${cfg.name}, a specialist agent (${(cfg.capabilities || []).join(', ')}) in a FinChat group discussion with the user and other agents. ` +
        `Read the transcript. If you have a genuinely useful, DIFFERENT angle to add to the last agent's answer, reply in 1-3 short sentences addressed to the room. ` +
        `If you have nothing new to add, reply with exactly: PASS`
    },
    { role: 'user', content: transcriptFor(history) }
  ];

  try {
    eventBus.emit('group:typing', { group_id: groupId, agent_id: candidateId });
    const res = await runInference({ messages, temperature: 0.6 });
    const text = (res.content || '').trim();
    if (!text || /^PASS\b/i.test(text)) return;
    await saveMessage(groupId, 'agent', candidateId, text, {
      kind: 'followup',
      provider: res.provider,
      model: res.model,
      fallback: res.provider === 'ollama'
    });
  } catch (e) {
    console.warn(`⚠️ Group follow-up by ${candidateId} failed: ${e.message}`);
  }
}

// ── Main entry: user posted a message ────────────────────────
/**
 * Handle a user message in a group: persist it, generate agent replies.
 * Returns the saved user message immediately; agent replies stream in via
 * the EventBus / socket room (and are persisted for reloads).
 */
async function handleUserMessage({ groupId, userId, content }) {
  const userMsg = await saveMessage(groupId, 'user', userId, content);

  // "/task @agent goal" → assign real background work instead of chatting
  const taskMatch = content.match(/^\/task\s+@([a-zA-Z0-9_-]+)\s+(.+)/s);
  if (taskMatch) {
    const agentId = taskMatch[1].toLowerCase();
    const goal = taskMatch[2].trim();
    const agentIds = await getAgentMembers(groupId);
    if (!agentIds.includes(agentId)) {
      await saveMessage(groupId, 'system', 'system', `Cannot assign task: "${agentId}" is not a member of this group.`);
      return userMsg;
    }
    assignTask({ groupId, userId, agentId, goal }).catch(e =>
      console.warn(`⚠️ Group task assignment failed: ${e.message}`));
    return userMsg;
  }

  // Normal discussion — respond asynchronously so the HTTP call returns fast
  setImmediate(async () => {
    try {
      const { primary, others } = await pickResponders(groupId, content);
      if (!primary) {
        await saveMessage(groupId, 'system', 'system', 'No agents in this group yet — add one to start the discussion.');
        return;
      }
      const allAgents = await getAgentMembers(groupId);
      const hasMentions = /@[a-zA-Z0-9_-]+/.test(content);
      const isBroadcast = !hasMentions && BROADCAST_RX.test(content);
      const goalText = await mentionsToNames(content);

      // Primary reply through the full cognitive core (tool-grounded)
      eventBus.emit('group:typing', { group_id: groupId, agent_id: primary });
      const history = await getRecentMessages(groupId);
      const roomContext = history.length > 1
        ? `\n\n[Group discussion transcript so far:]\n${transcriptFor(history.slice(0, -1))}`
        : '';
      const result = await route({
        goal: goalText + roomContext,
        userId,
        conversationId: `group_${groupId}`,
        conversationHistory: [],
        targetAgentId: primary
      });
      const reply = (result.cleanResponse || result.response || '').replace('[FRAUD_DETECTED]', '').trim()
        || 'I could not produce an answer this time.';
      await saveMessage(groupId, 'agent', primary, reply, {
        kind: 'reply',
        executionId: result.executionId,
        provider: result.provider || null,
        model: result.model || null,
        fallback: result.provider === 'ollama'
      });

      if (isBroadcast) {
        // Room-wide question ("hi everyone, how are your tasks going?") —
        // every member agent answers, one after another.
        for (const other of allAgents.filter(id => id !== primary)) {
          await maybeFollowUpDirect(groupId, other, content);
        }
      } else if (others.length) {
        // Explicitly mentioned co-responders answer too (lightweight)
        for (const other of others.slice(0, 3)) {
          await maybeFollowUpDirect(groupId, other, content);
        }
      } else if (MAX_FOLLOWUPS > 0) {
        // Otherwise, one member may voluntarily chime in
        await maybeFollowUp(groupId, primary, userId);
      }

      // Agents talking to each other: if any agent's reply @mentioned another
      // member (e.g. Aurelius asked "@Nova introduce yourself"), that agent
      // responds. One round only — their replies don't recurse.
      const answered = new Set([primary, ...others]);
      const latest = await getRecentMessages(groupId, 6);
      for (const msg of latest.filter(m => m.sender_type === 'agent')) {
        const rx = /@([a-zA-Z0-9_-]+)/g;
        let mm;
        while ((mm = rx.exec(msg.content)) !== null) {
          const id = mm[1].toLowerCase();
          if (allAgents.includes(id) && !answered.has(id)) {
            answered.add(id);
            await maybeFollowUpDirect(groupId, id,
              `${msg.sender_id.toUpperCase()} addressed you in the group: "${msg.content.slice(0, 300)}" — respond to them.`);
          }
        }
      }
    } catch (err) {
      console.error('⚠️ Group discussion error:', err.message);
      await saveMessage(groupId, 'system', 'system', `The agents hit an error answering: ${err.message}`).catch(() => {});
    }
  });

  return userMsg;
}

// An addressed agent must answer (not optional like maybeFollowUp) — used for
// @mentioned co-responders, broadcast questions, and agent-to-agent mentions.
async function maybeFollowUpDirect(groupId, agentId, userContent) {
  const cfg = await getAgentConfig(agentId);
  if (!cfg) return;
  const history = await getRecentMessages(groupId);
  const messages = [
    {
      role: 'system',
      content: `You are ${cfg.name}, a specialist agent (${(cfg.capabilities || []).join(', ')}) in a FinChat group discussion with the user and other agents. ` +
        `You were addressed directly. Answer from YOUR specialty's perspective in a short, direct reply (max 5 sentences). ` +
        `Don't repeat what other agents already said in the transcript — add your own angle.`
    },
    { role: 'user', content: `${transcriptFor(history)}\n\nRespond to: "${userContent}"` }
  ];
  try {
    eventBus.emit('group:typing', { group_id: groupId, agent_id: agentId });
    const res = await runInference({ messages, temperature: 0.6 });
    const text = (res.content || '').trim();
    if (!text) return;
    await saveMessage(groupId, 'agent', agentId, text, {
      kind: 'reply',
      provider: res.provider,
      model: res.model,
      fallback: res.provider === 'ollama'
    });
  } catch (e) {
    console.warn(`⚠️ Group reply by ${agentId} failed: ${e.message}`);
  }
}

// ── Task assignment ──────────────────────────────────────────
/**
 * Give an agent real work from the group chat. Runs in the background through
 * the full cognitive core; the result is posted back into the room and the
 * user gets a bell notification linking to the group.
 */
async function assignTask({ groupId, userId, agentId, goal }) {
  const cfg = await getAgentConfig(agentId);
  const name = cfg?.name || agentId;
  await saveMessage(groupId, 'system', 'system',
    `📋 Task assigned to ${name}: "${goal}" — working on it…`, { kind: 'task_assigned', agentId, goal });

  try {
    eventBus.emit('group:typing', { group_id: groupId, agent_id: agentId });
    const result = await route({
      goal,
      userId,
      conversationId: `group_${groupId}`,
      conversationHistory: [],
      targetAgentId: agentId
    });
    const reply = (result.cleanResponse || result.response || '').replace('[FRAUD_DETECTED]', '').trim()
      || 'Task finished but produced no output.';
    await saveMessage(groupId, 'agent', agentId, `✅ Task done.\n\n${reply}`, {
      kind: 'task_result',
      executionId: result.executionId,
      provider: result.provider || null,
      model: result.model || null,
      fallback: result.provider === 'ollama'
    });
    await createNotification({
      userId,
      type: 'group_chat',
      title: `✅ ${name} finished your group task`,
      content: `"${goal.slice(0, 100)}" — the result is in the group chat.`,
      link: `finchat_groupchat.html?group=${groupId}`
    });
  } catch (err) {
    await saveMessage(groupId, 'system', 'system', `❌ ${name} failed the task: ${err.message}`,
      { kind: 'task_failed', agentId });
    await createNotification({
      userId,
      type: 'group_chat',
      title: `❌ ${name} could not finish your task`,
      content: err.message,
      link: `finchat_groupchat.html?group=${groupId}`
    });
  }
}

module.exports = {
  handleUserMessage,
  assignTask,
  saveMessage,
  getRecentMessages,
  getAgentMembers
};
