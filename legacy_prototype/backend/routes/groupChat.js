// routes/groupChat.js — agent/user group chats (Sprint 8)
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { getAgentConfig, getAllAgentConfigs, listActiveAgents } = require('../services/agents/AgentRegistry');
const { handleUserMessage, assignTask, saveMessage } = require('../services/agents/GroupChatOrchestrator');

async function loadGroup(groupId, userId) {
  const g = await query('SELECT * FROM group_chats WHERE group_id = $1 AND owner_id = $2', [groupId, userId]);
  return g.rows[0] || null;
}

async function membersOf(groupId) {
  const res = await query(
    'SELECT member_type, member_id, added_at FROM group_chat_members WHERE group_id = $1 ORDER BY added_at ASC',
    [groupId]);
  // Read the registry once rather than per agent member — getAgentConfig()
  // pulls the entire registry on each call, so a six-agent group meant six
  // round trips to answer from one cached object.
  const hasAgents = res.rows.some(r => r.member_type === 'agent');
  const configById = hasAgents
    ? new Map((await getAllAgentConfigs()).map(c => [c.agentId, c]))
    : new Map();

  return res.rows.map(r => {
    if (r.member_type !== 'agent') return { ...r, name: 'You' };
    const cfg = configById.get(r.member_id);
    return { ...r, name: cfg?.name || r.member_id, capabilities: cfg?.capabilities || [] };
  });
}

// ── GET /api/group-chat/agents ── which agents can be added ──
router.get('/agents', requireAuth, async (req, res) => {
  try {
    const agents = await listActiveAgents({ includeMiddleware: false });
    res.json({
      agents: agents
        .filter(a => a.type !== 'middleware')
        .map(a => ({ agentId: a.agentId, name: a.name, type: a.type, capabilities: a.capabilities || [] }))
    });
  } catch (err) {
    console.error('List agents error:', err);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// ── GET /api/group-chat ── my groups ──
router.get('/', requireAuth, async (req, res) => {
  try {
    const groups = await query(`
      SELECT g.*,
        (SELECT COUNT(*) FROM group_chat_members m WHERE m.group_id = g.group_id AND m.member_type = 'agent') AS agent_count,
        (SELECT content FROM group_chat_messages msg WHERE msg.group_id = g.group_id ORDER BY created_at DESC LIMIT 1) AS last_message
      FROM group_chats g WHERE g.owner_id = $1
      ORDER BY g.updated_at DESC
    `, [req.user.id]);
    res.json({ groups: groups.rows });
  } catch (err) {
    console.error('List groups error:', err);
    res.status(500).json({ error: 'Failed to list group chats' });
  }
});

// ── POST /api/group-chat ── create a group with chosen agents ──
router.post('/', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const agents = Array.isArray(req.body.agents) ? [...new Set(req.body.agents.map(a => String(a).toLowerCase()))] : [];
    if (!name) return res.status(400).json({ error: 'Group name required' });
    if (!agents.length) return res.status(400).json({ error: 'Pick at least one agent' });
    if (agents.length > 6) return res.status(400).json({ error: 'Maximum 6 agents per group' });

    // One registry read, then look up in memory. getAgentConfig() fetches the
    // whole registry on every call, so the two loops here cost up to a dozen
    // Redis round trips to answer questions about six agents.
    const configs = await getAllAgentConfigs();
    const configById = new Map(configs.map(c => [c.agentId, c]));

    const valid = agents.filter(id => {
      const cfg = configById.get(id);
      return cfg && cfg.type !== 'middleware';
    });
    if (!valid.length) return res.status(400).json({ error: 'No valid agents in selection' });

    const groupId = `grp_${uuidv4()}`;
    await query('INSERT INTO group_chats (group_id, owner_id, name) VALUES ($1, $2, $3)', [groupId, req.user.id, name]);

    // Owner + every agent in one statement instead of one per member.
    await query(`
      INSERT INTO group_chat_members (group_id, member_type, member_id)
      SELECT $1, m.member_type, m.member_id
      FROM UNNEST($2::text[], $3::text[]) AS m(member_type, member_id)
      ON CONFLICT DO NOTHING
    `, [
      groupId,
      ['user', ...valid.map(() => 'agent')],
      [req.user.id, ...valid]
    ]);

    const names = valid.map(id => configById.get(id)?.name || id);
    await saveMessage(groupId, 'system', 'system',
      `👥 Group "${name}" created with ${names.join(', ')}. Ask anything, @mention an agent to address them directly, or type "/task @agent <goal>" to assign real work.`);

    res.status(201).json({ groupId, name, agents: valid, members: await membersOf(groupId) });
  } catch (err) {
    console.error('Create group error:', err);
    res.status(500).json({ error: 'Failed to create group chat' });
  }
});

// ── GET /api/group-chat/:id ── group + members ──
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const group = await loadGroup(req.params.id, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json({ group, members: await membersOf(group.group_id) });
  } catch (err) {
    console.error('Get group error:', err);
    res.status(500).json({ error: 'Failed to load group' });
  }
});

// ── PATCH /api/group-chat/:id ── rename a group ──
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'name required' });
    const upd = await query(
      'UPDATE group_chats SET name = $1, updated_at = NOW() WHERE group_id = $2 AND owner_id = $3',
      [name, req.params.id, req.user.id]);
    if (!upd.rowCount) return res.status(404).json({ error: 'Group not found' });
    await saveMessage(req.params.id, 'system', 'system', `✏️ Group renamed to "${name}".`);
    res.json({ status: 'ok', name });
  } catch (err) {
    console.error('Rename group error:', err);
    res.status(500).json({ error: 'Failed to rename group' });
  }
});

// ── DELETE /api/group-chat/:id ── delete a group ──
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const del = await query('DELETE FROM group_chats WHERE group_id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Group not found' });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Delete group error:', err);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// ── POST /api/group-chat/:id/members ── add an agent ──
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const group = await loadGroup(req.params.id, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const agentId = String(req.body.agentId || '').toLowerCase();
    const cfg = await getAgentConfig(agentId);
    if (!cfg || cfg.type === 'middleware') return res.status(400).json({ error: `Unknown agent: ${agentId}` });
    await query(`
      INSERT INTO group_chat_members (group_id, member_type, member_id)
      VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING
    `, [group.group_id, agentId]);
    await saveMessage(group.group_id, 'system', 'system', `➕ ${cfg.name} joined the group.`);
    res.json({ status: 'ok', members: await membersOf(group.group_id) });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Failed to add agent' });
  }
});

// ── DELETE /api/group-chat/:id/members/:agentId ── remove an agent ──
router.delete('/:id/members/:agentId', requireAuth, async (req, res) => {
  try {
    const group = await loadGroup(req.params.id, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const agentId = String(req.params.agentId).toLowerCase();
    const del = await query(`
      DELETE FROM group_chat_members WHERE group_id = $1 AND member_type = 'agent' AND member_id = $2
    `, [group.group_id, agentId]);
    if (!del.rowCount) return res.status(404).json({ error: 'Agent is not in this group' });
    const cfg = await getAgentConfig(agentId);
    await saveMessage(group.group_id, 'system', 'system', `➖ ${cfg?.name || agentId} left the group.`);
    res.json({ status: 'ok', members: await membersOf(group.group_id) });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Failed to remove agent' });
  }
});

// ── GET /api/group-chat/:id/messages ── history ──
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    const group = await loadGroup(req.params.id, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 300);
    const msgs = await query(`
      SELECT message_id, sender_type, sender_id, content, meta, created_at
      FROM group_chat_messages WHERE group_id = $1
      ORDER BY created_at ASC LIMIT $2
    `, [group.group_id, limit]);
    res.json({ messages: msgs.rows });
  } catch (err) {
    console.error('Group messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ── POST /api/group-chat/:id/messages ── user posts; agents reply async ──
router.post('/:id/messages', requireAuth, async (req, res) => {
  try {
    const group = await loadGroup(req.params.id, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Message required' });
    const msg = await handleUserMessage({ groupId: group.group_id, userId: req.user.id, content });
    res.status(202).json({ status: 'ok', message: msg });
  } catch (err) {
    console.error('Group send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── POST /api/group-chat/:id/tasks ── explicit task assignment ──
router.post('/:id/tasks', requireAuth, async (req, res) => {
  try {
    const group = await loadGroup(req.params.id, req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const agentId = String(req.body.agentId || '').toLowerCase();
    const goal = String(req.body.goal || '').trim();
    if (!agentId || !goal) return res.status(400).json({ error: 'agentId and goal required' });
    const memberCheck = await query(`
      SELECT 1 FROM group_chat_members WHERE group_id = $1 AND member_type = 'agent' AND member_id = $2
    `, [group.group_id, agentId]);
    if (!memberCheck.rows.length) return res.status(400).json({ error: `${agentId} is not in this group` });

    assignTask({ groupId: group.group_id, userId: req.user.id, agentId, goal })
      .catch(e => console.warn(`⚠️ Group task failed: ${e.message}`));
    res.status(202).json({ status: 'task_assigned', agentId, goal });
  } catch (err) {
    console.error('Group task error:', err);
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

module.exports = router;
