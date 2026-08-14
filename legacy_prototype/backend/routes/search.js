// routes/search.js — "Search system knowledge" (header search box)
// Searches the user's own conversations, neural-map nodes, memories, and the
// shared entity graph. Returns unified results with deep links.
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { getPersona } = require('../services/personas');

// Build a short snippet around the first match of q (case-insensitive).
function makeSnippet(text, q, radius = 60) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const idx = clean.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return clean.slice(0, radius * 2) + (clean.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(clean.length, idx + q.length + radius);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}

router.get('/', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, results: [] });

  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const userId = req.user.id;
  const results = [];

  try {
    // 1. Conversations — latest matching message per session
    const chats = await query(`
      SELECT DISTINCT ON (session_id) session_id, persona, content, created_at
      FROM ai_conversations
      WHERE user_id = $1 AND content ILIKE $2 AND role IN ('user','assistant')
      ORDER BY session_id, created_at DESC
      LIMIT 8
    `, [userId, like]);
    for (const row of chats.rows) {
      const p = getPersona(row.persona);
      results.push({
        type: 'chat',
        title: `Chat with ${p?.name || row.persona}`,
        snippet: makeSnippet(row.content, q),
        href: `finchat_chat.html?session=${encodeURIComponent(row.session_id)}`,
        ts: row.created_at
      });
    }

    // 2. Neural-map nodes the user created/annotated
    const nodes = await query(`
      SELECT node_key, map_id, label, note, created_at
      FROM neural_map_nodes
      WHERE user_id = $1 AND (label ILIKE $2 OR note ILIKE $2)
      ORDER BY created_at DESC
      LIMIT 6
    `, [userId, like]);
    for (const row of nodes.rows) {
      results.push({
        type: 'node',
        title: `Map node: ${row.label}`,
        snippet: makeSnippet(row.note || row.label, q),
        href: 'finchat_neuralmap.html',
        ts: row.created_at
      });
    }

    // 3. Agent memories about this user
    const mems = await query(`
      SELECT content, memory_type, created_at
      FROM memories
      WHERE user_id = $1 AND content ILIKE $2
      ORDER BY created_at DESC
      LIMIT 5
    `, [userId, like]);
    for (const row of mems.rows) {
      results.push({
        type: 'memory',
        title: `Agent memory (${row.memory_type})`,
        snippet: makeSnippet(row.content, q),
        href: 'finchat_dashboard.html',
        ts: row.created_at
      });
    }

    // 4. Knowledge-graph entities — THIS USER'S only. The graph used to be shared
    // and this was assumed to be harmless metadata; it is not. Entity names come
    // out of chat content, so an unscoped search here let one user discover what
    // other people had been talking about.
    const ents = await query(`
      SELECT canonical_name, entity_type, mention_count, last_seen_at
      FROM entities
      WHERE canonical_name ILIKE $1 AND user_id = $2
      ORDER BY mention_count DESC
      LIMIT 5
    `, [like, req.user.id]);
    for (const row of ents.rows) {
      results.push({
        type: 'entity',
        title: `Concept: ${row.canonical_name}`,
        snippet: `${row.entity_type} — mentioned ${row.mention_count}× across conversations`,
        href: 'finchat_neuralmap.html',
        ts: row.last_seen_at
      });
    }

    res.json({ query: q, results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

module.exports = router;
