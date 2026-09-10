// services/Sayings.js — the line an agent opens with, and the ledger that
// stops it ever opening with that line twice.
//
// Two jobs:
//
//   pickSaying()   choose a line this user has not heard from this agent, mark
//                  it heard, hand it back. Relevance is optional: a greeting
//                  takes anything, a topical opener takes only a learned line
//                  whose keywords overlap the question.
//   learnFromRun() after an answer built on real sources, bank one sentence
//                  from that answer together with the URL behind it.
//
// Everything here is best-effort by design. A saying is decoration on top of a
// real answer, so every failure path returns null or silently gives up rather
// than costing the user their response. Nothing in this file is allowed to
// throw into the chat path.

const { query } = require('../database');

// Derived from the persona roster rather than hand-written. The hand-written
// version was correct for exactly as long as the roster it was copied from:
// adding an agent left it out silently, and a saying that is silently never
// picked looks like a feature nobody uses rather than a list nobody updated.
// This is the same trap server.js documents for the `users` identity rows.
const AGENTS = new Set(Object.keys(require('./personas').personas));

// Words too common to mean anything as a topic key. Matching on these would
// make every learned line "relevant" to every question, which is the same as
// having no relevance rule at all.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'will', 'would', 'could', 'should', 'about', 'into', 'over', 'after',
  'what', 'when', 'where', 'which', 'while', 'your', 'you', 'are', 'was',
  'were', 'been', 'its', 'their', 'there', 'they', 'them', 'than', 'then',
  'some', 'more', 'most', 'much', 'many', 'said', 'says', 'also', 'just',
  'like', 'because', 'between', 'against', 'through', 'during', 'before',
  'these', 'those', 'each', 'other', 'only', 'both', 'being', 'does', 'did',
  'how', 'why', 'who', 'can', 'may', 'might', 'new', 'now', 'day', 'today',
  'year', 'week', 'month', 'time', 'people', 'make', 'made', 'get', 'got'
]);

function keywords(text, limit = 12) {
  const seen = new Set();
  for (const raw of String(text || '').toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []) {
    const w = raw.replace(/['-]+$/, '');
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    seen.add(w);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/**
 * Format a saying for display. Learned lines carry their source so the user can
 * check them; seeds carry an author or stand on their own.
 */
function formatSaying(row) {
  if (!row) return '';
  const text = String(row.text || '').trim();
  if (!text) return '';
  const quoted = /^["“']/.test(text) ? text : `“${text}”`;
  if (row.origin === 'learned') {
    const where = row.source_title ? ` — ${row.source_title}` : '';
    return `${quoted}${where}`;
  }
  return row.attribution ? `${quoted} — ${row.attribution}` : quoted;
}

/**
 * Pick a saying this user has never been shown for this agent, and record that
 * they have now been shown it.
 *
 * @param {object}  opts
 * @param {string}  opts.agentId
 * @param {string}  opts.userId
 * @param {string} [opts.topic]     when given, ONLY learned lines whose keywords
 *                                  overlap it are eligible — this is what makes
 *                                  a topical opener feel earned rather than random.
 * @returns {Promise<object|null>}  the saying row, already marked as shown.
 */
async function pickSaying({ agentId, userId, topic = null } = {}) {
  const agent = String(agentId || '').toLowerCase();
  if (!AGENTS.has(agent) || !userId) return null;

  try {
    // A seed belongs to every user (user_id IS NULL); a learned line belongs
    // only to the user who earned it. NOT EXISTS against the ledger is the
    // never-repeat guarantee.
    const params = [agent, userId];
    let relevance = '';
    if (topic) {
      const keys = keywords(topic);
      if (!keys.length) return null;
      params.push(JSON.stringify(keys));
      // Topical mode is learned-only: seeds have no topics and would otherwise
      // match nothing, or worse, everything.
      relevance = `
        AND s.origin = 'learned'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(s.topics) t
          WHERE t IN (SELECT jsonb_array_elements_text($3::jsonb))
        )`;
    }

    const { rows } = await query(
      `SELECT s.saying_id, s.text, s.attribution, s.origin, s.source_url, s.source_title
         FROM agent_sayings s
        WHERE s.agent_id = $1
          AND (s.user_id IS NULL OR s.user_id = $2)
          AND NOT EXISTS (
            SELECT 1 FROM agent_saying_shown w
             WHERE w.saying_id = s.saying_id AND w.user_id = $2
          )
          ${relevance}
        ORDER BY (s.origin = 'learned') DESC, random()
        LIMIT 1`,
      params
    );

    const row = rows[0];
    if (!row) return null;

    await query(
      `INSERT INTO agent_saying_shown (saying_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.saying_id, userId]
    );
    return row;
  } catch (err) {
    // A missing table (migration not yet run) must not break chat.
    console.warn('Sayings.pickSaying skipped:', err.message);
    return null;
  }
}

/**
 * Pull the one sentence from an answer most worth remembering.
 *
 * Deliberately not a model call. The answer has already been written and paid
 * for; a second inference to admire it would add cost and latency to every
 * research run and could invent an attribution. So this is a filter, not a
 * writer: a self-contained declarative sentence of reasonable length that
 * carries something concrete (a number, a percentage, a proper noun) and does
 * not refer back to the conversation.
 */
function extractLine(response) {
  const text = String(response || '')
    .replace(/```[\s\S]*?```/g, ' ')      // code and study blocks are not quotable
    .replace(/[#*_>`|]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z“"])/);
  const candidates = [];

  for (const raw of sentences) {
    const s = raw.trim();
    if (s.length < 60 || s.length > 220) continue;
    if (/[?]$/.test(s)) continue;                       // questions aren't sayings
    if (/^(I|We|You|Let|Here|Would you|Want|Shall)\b/.test(s)) continue;
    if (/\b(I'll|I've|I'm|we'll|as requested|above|below|let me know)\b/i.test(s)) continue;
    const concrete = /\d/.test(s) || /\b[A-Z][a-z]{2,}\b/.test(s);
    if (!concrete) continue;
    candidates.push(s);
  }
  if (!candidates.length) return null;

  // Prefer the sentence carrying the most specific detail — figures beat names.
  candidates.sort((a, b) => {
    const score = (s) => (s.match(/\d/g) || []).length + (s.match(/%|\$|₹/g) || []).length * 3;
    return score(b) - score(a);
  });
  return candidates[0];
}

/**
 * Bank one line from a completed, source-backed run.
 *
 * Only fires when the agent actually consulted a verified source: a line with
 * no URL behind it is an assertion, and the whole point of a learned saying is
 * that it can be checked.
 *
 * @returns {Promise<object|null>} the stored row, or null when nothing qualified.
 */
async function learnFromRun({ agentId, userId, goal, response, sources } = {}) {
  const agent = String(agentId || '').toLowerCase();
  if (!AGENTS.has(agent) || !userId) return null;
  if (!Array.isArray(sources) || !sources.length) return null;

  const source = sources.find((s) => s && s.url && s.verified !== false) || null;
  if (!source) return null;

  const line = extractLine(response);
  if (!line) return null;

  // Topics come from both sides: what was asked and what was said. A line
  // learned while discussing "Fed rate policy" should surface again when rates
  // come up, not only when the same words are repeated.
  const topics = [...new Set([...keywords(goal, 8), ...keywords(line, 8)])];
  if (!topics.length) return null;

  const id = `learn_${agent}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { rows } = await query(
      `INSERT INTO agent_sayings
         (saying_id, agent_id, user_id, text, attribution, origin,
          source_url, source_title, topics)
       VALUES ($1, $2, $3, $4, NULL, 'learned', $5, $6, $7::jsonb)
       ON CONFLICT (agent_id, text) DO NOTHING
       RETURNING saying_id`,
      [id, agent, userId, line, source.url,
        String(source.title || '').slice(0, 200), JSON.stringify(topics)]
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('Sayings.learnFromRun skipped:', err.message);
    return null;
  }
}

module.exports = {
  pickSaying,
  learnFromRun,
  formatSaying,
  // exported for tests
  extractLine,
  keywords
};
