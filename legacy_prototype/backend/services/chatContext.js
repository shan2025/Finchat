// Other conversations as context for this one.
//
// The composer lets the user pull earlier chats into the one they are in
// (Ctrl+K picker, or "Branch" on a Recent row). The agent then reads those
// chats before answering. The links live in ai_session_meta
// .context_sessions so every turn sees them, not just the first.
//
// What the agent reads is a COMPACTION of each linked chat: the model reads
// the whole conversation once and writes a dense summary (facts, numbers,
// decisions, open questions). That is cached in chat_compactions and reused on
// every turn; when the source chat grows, only its new turns are folded into
// the existing summary. Each new compaction is also fed to the knowledge graph
// (MemoryEngine.ingestChat), so what a linked chat established becomes
// long-term memory rather than something only this conversation can see.
//
// If compaction fails (every provider down), the old behaviour is the
// fallback: the END of the raw transcript, trimmed to a character budget.

const MAX_LINKED = 5;
const PER_CHAT_CHARS = 5000;     // raw-transcript fallback only
const TOTAL_CHARS = 12000;       // raw-transcript fallback only
const PER_TURN_CHARS = 1500;
const SUMMARY_CHARS = 2400;      // hard cap on a stored compaction
const SINGLE_PASS_CHARS = 40000; // above this, compact in chunks first
const CHUNK_CHARS = 30000;
const MAX_CHUNKS = 8;
const COMPACT_TIMEOUT_MS = 45000;

const PERSONA_PREFIX_RE = /^\[[^\]]{1,40}\]\s*/;

const COMPACT_PROMPT = `You compact a conversation between a user and an AI assistant so it can be carried into a NEW conversation as background.
Write a dense summary that lets someone who never saw the chat continue from it. Keep:
- what the user wanted and why (goals, constraints, preferences they stated)
- concrete facts, figures, names, tickers, dates, links and sources that were established
- decisions reached and conclusions drawn
- open questions and what was left unfinished
Drop greetings, filler, repetition and the assistant's hedging. Do not invent anything.
"The user" means the person in the conversation — never describe this summarising task itself.
Start directly with the substance. Plain text, short labelled sections or tight bullets, at most 300 words.`;

const MERGE_PROMPT = `You maintain a compact summary of an ongoing conversation between a user and an AI assistant.
You are given the EXISTING SUMMARY and the NEW MESSAGES since it was written. Produce one updated summary
that folds the new messages in: keep what still holds, update what changed, add new facts, decisions and open
questions, drop what was resolved. Same rules: dense, concrete, nothing invented, plain text, at most 300 words.`;

// Whatever the client sent → a clean, bounded list of session ids, never
// including the conversation being written to (it is already the history).
function normalizeContextIds(raw, currentSessionId) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!id || id.length > 128 || id === currentSessionId || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_LINKED) break;
  }
  return out;
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+\n/g, '\n').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function transcriptLines(chat, messages, perTurn = PER_TURN_CHARS) {
  return (messages || []).map(m => {
    const who = m.role === 'user' ? 'User' : (chat.personaName || 'Agent');
    return `${who}: ${clip(String(m.content || '').replace(PERSONA_PREFIX_RE, ''), perTurn)}`;
  });
}

// Split a transcript into chunks on message boundaries. Chunks past
// MAX_CHUNKS are dropped from the FRONT: the end of a chat is where it landed.
function chunkLines(lines, size = CHUNK_CHARS, maxChunks = MAX_CHUNKS) {
  const chunks = [];
  let cur = [], len = 0;
  for (const l of lines) {
    if (len + l.length > size && cur.length) { chunks.push(cur.join('\n\n')); cur = []; len = 0; }
    cur.push(l); len += l.length + 2;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return { chunks: chunks.slice(-maxChunks), dropped: Math.max(0, chunks.length - maxChunks) };
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })
  ]).finally(() => clearTimeout(t));
}

async function summarize(runInference, system, content, { userId, agentId }) {
  const res = await runInference({
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    temperature: 0.2,
    feature: 'compaction',
    userId,
    agentId
  });
  const text = String(res && res.content || '').trim();
  if (text.length < 20) throw new Error('compaction came back empty');
  return { text: clip(text, SUMMARY_CHARS), model: res.model || res.provider || null };
}

// One chat → its summary text. `previous` = { summary, turn_count } when the
// chat was compacted before and has grown since; only new turns are read then.
async function compactTranscript(runInference, chat, previous) {
  const ids = { userId: chat.userId, agentId: chat.persona || null };
  const header = `Conversation: "${chat.title || 'Untitled'}"${chat.personaName ? ` (with ${chat.personaName})` : ''}`;

  if (previous && previous.summary && previous.turn_count > 0 && previous.turn_count < chat.messages.length) {
    const fresh = transcriptLines(chat, chat.messages.slice(previous.turn_count), 4000);
    const { chunks } = chunkLines(fresh, SINGLE_PASS_CHARS, 1);
    return summarize(runInference, MERGE_PROMPT,
      `${header}\n\nEXISTING SUMMARY:\n${previous.summary}\n\nNEW MESSAGES:\n${chunks[0] || ''}`, ids);
  }

  const lines = transcriptLines(chat, chat.messages, 4000);
  const whole = lines.join('\n\n');
  if (whole.length <= SINGLE_PASS_CHARS) {
    return summarize(runInference, COMPACT_PROMPT, `${header}\n\n${whole}`, ids);
  }
  // Too long for one pass: summarise each chunk, then compact the notes.
  const { chunks, dropped } = chunkLines(lines);
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = await summarize(runInference, COMPACT_PROMPT,
      `${header}, part ${i + 1} of ${chunks.length}\n\n${chunks[i]}`, ids);
    notes.push(`Part ${i + 1}:\n${part.text}`);
  }
  return summarize(runInference, COMPACT_PROMPT,
    `${header}\n${dropped ? `(The ${dropped} earliest part(s) were too old to include.)\n` : ''}` +
    `These are summaries of consecutive parts of one conversation. Compact them into one.\n\n${notes.join('\n\n')}`, ids);
}

/**
 * The compaction for one linked chat: cached if it still covers every turn,
 * otherwise (re)computed, stored, and handed to the knowledge graph.
 * Returns { summary, turnCount, cached, fresh } or null when compaction failed
 * (the caller then falls back to the raw transcript).
 */
async function getCompaction(deps, chat) {
  const { query, runInference, ingest } = deps;
  const turnCount = chat.messages.length;
  const prev = (await query(
    'SELECT summary, turn_count, ingested_at FROM chat_compactions WHERE user_id = $1 AND session_id = $2',
    [chat.userId, chat.sessionId])).rows[0];
  if (prev && prev.turn_count === turnCount) {
    return { summary: prev.summary, turnCount, cached: true };
  }
  let result;
  try {
    result = await withTimeout(compactTranscript(runInference, chat, prev), COMPACT_TIMEOUT_MS, 'compaction');
  } catch (err) {
    console.warn(`⚠️ chat compaction failed for ${String(chat.sessionId).slice(0, 12)}: ${err.message}`);
    // An out-of-date summary still beats none: it covers everything but the newest turns.
    return prev ? { summary: prev.summary, turnCount: prev.turn_count, cached: true, stale: true } : null;
  }
  await query(`
    INSERT INTO chat_compactions (user_id, session_id, title, persona, turn_count, summary, model, ingested_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NOW())
    ON CONFLICT (user_id, session_id) DO UPDATE
      SET title = $3, persona = $4, turn_count = $5, summary = $6, model = $7, ingested_at = NULL, updated_at = NOW()
  `, [chat.userId, chat.sessionId, chat.title || null, chat.persona || null, turnCount, result.text, result.model]);

  // Learn it. Runs after the caller has its summary; failures only mean the
  // graph misses this version (ingested_at stays NULL).
  if (ingest) {
    setImmediate(async () => {
      try {
        const report = await ingest({
          userId: chat.userId,
          sessionId: chat.sessionId,
          agentId: chat.persona || null,
          userText: `[Compacted conversation: "${chat.title || 'Untitled'}"]\n\n${result.text}`,
          aiText: '',
          sourceLabel: `Compacted chat: ${clip(chat.title || 'Untitled', 60)}`,
          sourceType: 'chat',
          // The summary is the model's words about the user, not the user's own —
          // preferences are learned from what they actually typed.
          learnPreferences: false
        });
        await query(
          'UPDATE chat_compactions SET ingested_at = NOW() WHERE user_id = $1 AND session_id = $2 AND turn_count = $3',
          [chat.userId, chat.sessionId, turnCount]);
        if (report && report.learned && report.learned.length) {
          console.log(`🧠 Compaction of ${String(chat.sessionId).slice(0, 12)} → graph: ${report.learned.length} node(s), ${report.linked.length} link(s)`);
        }
      } catch (err) {
        console.warn(`⚠️ compaction graph ingest failed: ${err.message}`);
      }
    });
  }
  return { summary: result.text, turnCount, cached: false, fresh: true };
}

// Compact every linked chat (in parallel) and attach `summary` to each.
async function compactChats(deps, chats) {
  await Promise.all(chats.map(async (c) => {
    try {
      const comp = await getCompaction(deps, c);
      if (comp) { c.summary = comp.summary; c.summaryTurns = comp.turnCount; }
    } catch (err) {
      console.warn(`⚠️ compaction lookup failed: ${err.message}`);
    }
  }));
  return chats;
}

// Raw fallback for one chat: walk back from the end until the budget is spent.
function rawSection(chat, perChat) {
  const lines = transcriptLines(chat, chat.messages);
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 2 > perChat && kept.length) break;
    kept.unshift(lines[i]);
    used += lines[i].length + 2;
  }
  const dropped = lines.length - kept.length;
  return [
    dropped > 0 ? `[${dropped} earlier message(s) omitted]` : null,
    kept.join('\n\n') || '[no messages]'
  ].filter(Boolean).join('\n');
}

// chats: [{ title, personaName, messages, summary? }] → prompt text.
// Pure, so the budget arithmetic is testable without a database.
function formatContextBlock(chats) {
  if (!Array.isArray(chats) || !chats.length) return '';
  const perChat = Math.min(PER_CHAT_CHARS, Math.floor(TOTAL_CHARS / chats.length));
  const sections = chats.map(chat => {
    const head = `### "${clip(chat.title || 'Untitled conversation', 80)}"` +
      (chat.personaName ? ` (with ${chat.personaName})` : '');
    if (chat.summary) {
      const n = chat.summaryTurns || (chat.messages || []).length;
      return `${head} — compacted summary of ${n} message(s)\n${chat.summary}`;
    }
    return `${head}\n${rawSection(chat, perChat)}`;
  });
  return '\n\n--- CONTEXT FROM THE USER\'S OTHER CONVERSATIONS ---\n' +
    'The user linked these earlier chats so you can build on them. Treat them as background: ' +
    'use what is relevant, refer to them by title when you do, and do not re-answer them.\n\n' +
    sections.join('\n\n') +
    '\n--- END OF LINKED CONVERSATIONS ---';
}

// Load the linked chats the user actually owns, in the order they were linked.
// Ids that match nothing (deleted, someone else's) silently drop out.
async function loadContextChats(query, userId, ids, getPersona) {
  if (!ids.length) return [];
  const [turns, meta] = await Promise.all([
    query(`
      SELECT session_id, role, content, persona
      FROM ai_conversations
      WHERE user_id = $1 AND session_id = ANY($2::text[]) AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
    `, [userId, ids]),
    query(`
      SELECT session_id, title, deleted FROM ai_session_meta
      WHERE user_id = $1 AND session_id = ANY($2::text[])
    `, [userId, ids])
  ]);
  const metaById = new Map(meta.rows.map(r => [r.session_id, r]));
  const bySession = new Map();
  for (const r of turns.rows) {
    if (metaById.get(r.session_id)?.deleted) continue;
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  return ids.filter(id => bySession.has(id)).map(id => {
    const rows = bySession.get(id);
    const firstUser = rows.find(r => r.role === 'user');
    const persona = getPersona ? getPersona(rows[0].persona) : null;
    return {
      userId,
      sessionId: id,
      title: metaById.get(id)?.title ||
        clip((firstUser?.content || 'Untitled conversation').replace(/\s+/g, ' '), 60),
      persona: rows[0].persona,
      personaName: persona?.name || rows[0].persona,
      messages: rows.map(r => ({ role: r.role, content: r.content }))
    };
  });
}

module.exports = {
  MAX_LINKED,
  SUMMARY_CHARS,
  normalizeContextIds,
  formatContextBlock,
  loadContextChats,
  compactChats,
  getCompaction,
  chunkLines
};
