// Linked conversations: the id list the client sends, the prompt block the
// agent reads, and the ownership filter on load.
const test = require('node:test');
const assert = require('node:assert');
const {
  MAX_LINKED, SUMMARY_CHARS, normalizeContextIds, formatContextBlock, loadContextChats,
  getCompaction, compactChats, chunkLines
} = require('../services/chatContext');

// A fake chat_compactions table + model, recording what each was asked.
function fakeDeps({ stored = null, reply = 'Summary: user tracks gold; decided to wait for CPI.', fail = false } = {}) {
  const state = { row: stored, prompts: [], ingested: [], writes: 0 };
  return {
    state,
    query: async (sql, params) => {
      if (/^\s*SELECT summary, turn_count/.test(sql)) return { rows: state.row ? [state.row] : [] };
      if (/INSERT INTO chat_compactions/.test(sql)) {
        state.writes++;
        state.row = { summary: params[5], turn_count: params[4], ingested_at: null };
        return { rows: [] };
      }
      if (/UPDATE chat_compactions SET ingested_at/.test(sql)) { state.row.ingested_at = new Date(); return { rows: [] }; }
      throw new Error('unexpected sql: ' + sql);
    },
    runInference: async ({ messages, feature, userId }) => {
      state.prompts.push({ system: messages[0].content, user: messages[1].content, feature, userId });
      if (fail) throw new Error('all providers down');
      return { content: reply, model: 'test-model' };
    },
    ingest: async (args) => { state.ingested.push(args); return { learned: [{}], linked: [] }; }
  };
}
const chatOf = (n, extra = {}) => ({
  userId: 'u1', sessionId: 's1', title: 'Gold plan', persona: 'aurelius', personaName: 'Aurelius',
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg-${i}` })),
  ...extra
});
const tick = () => new Promise(r => setImmediate(r));
// The service logs (with emoji) from background ingests; on Windows that output
// can interleave with node:test's serialized stream and fail the FILE with
// "Unable to deserialize cloned data". The logs are not under test.
console.log = () => {};
console.warn = () => {};
// A fresh compaction schedules its graph ingest with setImmediate; let it land
// inside the test that caused it, or node:test flags it as leaked activity.
test.afterEach(async () => { for (let i = 0; i < 5; i++) await tick(); });

test('normalizeContextIds drops junk, duplicates and the current session, and caps the count', () => {
  const ids = normalizeContextIds(['a', ' a ', '', null, 42, 'cur', 'b', 'x'.repeat(200), 'c', 'd', 'e', 'f'], 'cur');
  assert.deepStrictEqual(ids, ['a', 'b', 'c', 'd', 'e'].slice(0, MAX_LINKED));
  assert.deepStrictEqual(normalizeContextIds('a', 'cur'), []);
  assert.deepStrictEqual(normalizeContextIds(undefined), []);
});

test('formatContextBlock is empty with nothing linked', () => {
  assert.strictEqual(formatContextBlock([]), '');
  assert.strictEqual(formatContextBlock(null), '');
});

test('formatContextBlock names each chat and strips the stored persona prefix', () => {
  const block = formatContextBlock([{
    title: 'Gold outlook', personaName: 'Aurelius',
    messages: [
      { role: 'user', content: 'Where is gold heading?' },
      { role: 'assistant', content: '[Aurelius] Up, on central-bank buying.' }
    ]
  }]);
  assert.match(block, /CONTEXT FROM THE USER'S OTHER CONVERSATIONS/);
  assert.match(block, /### "Gold outlook" \(with Aurelius\)/);
  assert.match(block, /User: Where is gold heading\?/);
  assert.match(block, /Aurelius: Up, on central-bank buying\./);
  assert.doesNotMatch(block, /\[Aurelius\]/);
});

test('formatContextBlock keeps the END of a long chat and says what it dropped', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn-${i} ` + 'x'.repeat(400)
  }));
  const block = formatContextBlock([{ title: 'Long', personaName: 'Plato', messages }]);
  assert.match(block, /turn-39 /);
  assert.doesNotMatch(block, /turn-0 /);
  assert.match(block, /\[\d+ earlier message\(s\) omitted\]/);
  assert.ok(block.length < 6000, `one chat stays inside its budget (${block.length})`);
});

test('formatContextBlock splits the total budget across linked chats', () => {
  const big = { role: 'user', content: 'y'.repeat(1400) };
  const chats = Array.from({ length: 5 }, (_, i) => ({
    title: `c${i}`, personaName: 'Nova', messages: Array(20).fill(big)
  }));
  assert.ok(formatContextBlock(chats).length < 14000);
});

test('loadContextChats keeps link order, titles, and drops deleted or foreign chats', async () => {
  const calls = [];
  const fakeQuery = async (sql, params) => {
    calls.push(params);
    if (/FROM ai_conversations/.test(sql)) {
      return { rows: [
        { session_id: 's2', role: 'user', content: 'second chat question', persona: 'nova' },
        { session_id: 's1', role: 'user', content: 'first chat question', persona: 'plato' },
        { session_id: 's1', role: 'assistant', content: '[Plato] answer', persona: 'plato' },
        { session_id: 'gone', role: 'user', content: 'deleted', persona: 'plato' }
      ] };
    }
    return { rows: [
      { session_id: 's1', title: 'Renamed one', deleted: false },
      { session_id: 'gone', title: null, deleted: true }
    ] };
  };
  const chats = await loadContextChats(fakeQuery, 'u1', ['s1', 's2', 'gone', 'foreign'],
    (id) => ({ plato: { name: 'Plato' }, nova: { name: 'Nova' } }[id]));
  assert.deepStrictEqual(chats.map(c => c.sessionId), ['s1', 's2']);
  assert.strictEqual(chats[0].title, 'Renamed one');
  assert.strictEqual(chats[1].title, 'second chat question');
  assert.strictEqual(chats[1].personaName, 'Nova');
  assert.ok(calls.every(p => p[0] === 'u1'), 'every query is scoped to the user');
  assert.deepStrictEqual(await loadContextChats(fakeQuery, 'u1', []), []);
});

test('getCompaction summarises a new chat, stores it, and feeds the graph once', async () => {
  const deps = fakeDeps();
  const comp = await getCompaction(deps, chatOf(4));
  assert.strictEqual(comp.cached, false);
  assert.match(comp.summary, /decided to wait for CPI/);
  assert.strictEqual(deps.state.writes, 1);
  assert.strictEqual(deps.state.prompts.length, 1);
  assert.strictEqual(deps.state.prompts[0].feature, 'compaction');
  assert.strictEqual(deps.state.prompts[0].userId, 'u1', 'billed to the user (BYOK)');
  assert.match(deps.state.prompts[0].user, /msg-0[\s\S]*msg-3/);
  await tick(); await tick();
  assert.strictEqual(deps.state.ingested.length, 1);
  const ing = deps.state.ingested[0];
  assert.strictEqual(ing.userId, 'u1');
  assert.strictEqual(ing.sessionId, 's1');
  assert.strictEqual(ing.learnPreferences, false);
  assert.match(ing.userText, /Compacted conversation: "Gold plan"[\s\S]*CPI/);
  assert.ok(deps.state.row.ingested_at, 'marked as learned');
});

test('getCompaction reuses a summary that still covers every turn — no model call', async () => {
  const deps = fakeDeps({ stored: { summary: 'old summary', turn_count: 4, ingested_at: new Date() } });
  const comp = await getCompaction(deps, chatOf(4));
  assert.deepStrictEqual([comp.cached, comp.summary], [true, 'old summary']);
  assert.strictEqual(deps.state.prompts.length, 0);
  assert.strictEqual(deps.state.ingested.length, 0);
});

test('a grown chat folds ONLY its new turns into the previous summary', async () => {
  const deps = fakeDeps({ stored: { summary: 'PREVIOUS SUMMARY', turn_count: 4, ingested_at: new Date() } });
  const comp = await getCompaction(deps, chatOf(6));
  assert.strictEqual(comp.turnCount, 6);
  const p = deps.state.prompts[0];
  assert.match(p.system, /EXISTING SUMMARY/);
  assert.match(p.user, /PREVIOUS SUMMARY/);
  assert.match(p.user, /msg-4[\s\S]*msg-5/);
  assert.doesNotMatch(p.user, /msg-3\b/);
  assert.strictEqual(deps.state.row.turn_count, 6);
});

test('compaction failure falls back: stale summary if any, else null (raw transcript)', async () => {
  const stale = fakeDeps({ fail: true, stored: { summary: 'older', turn_count: 2 } });
  const a = await getCompaction(stale, chatOf(6));
  assert.deepStrictEqual([a.summary, a.stale], ['older', true]);
  const none = fakeDeps({ fail: true });
  assert.strictEqual(await getCompaction(none, chatOf(4)), null);
  assert.strictEqual(none.state.writes, 0);
});

test('a very long chat is compacted in chunks, then the notes are compacted', async () => {
  const deps = fakeDeps();
  const long = chatOf(60, {
    messages: Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `turn-${i} ` + 'z'.repeat(2000) }))
  });
  await getCompaction(deps, long);
  const n = deps.state.prompts.length;
  assert.ok(n >= 3, `chunk passes + a final pass (${n})`);
  assert.match(deps.state.prompts[n - 1].user, /summaries of consecutive parts/);
  assert.match(deps.state.prompts[n - 2].user, /turn-59 /, 'the last chunk holds the end of the chat');
});

test('chunkLines keeps the END when there are too many chunks', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i} ` + 'a'.repeat(90));
  const { chunks, dropped } = chunkLines(lines, 200, 3);
  assert.strictEqual(chunks.length, 3);
  assert.ok(dropped > 0);
  assert.match(chunks[2], /line-9 /);
});

test('the prompt block uses the summary instead of the raw transcript when there is one', async () => {
  const deps = fakeDeps({ reply: 'THE COMPACT SUMMARY' + ' x'.repeat(3000) });
  const chats = await compactChats(deps, [chatOf(8)]);
  const block = formatContextBlock(chats);
  assert.match(block, /"Gold plan" \(with Aurelius\) — compacted summary of 8 message\(s\)/);
  assert.match(block, /THE COMPACT SUMMARY/);
  assert.doesNotMatch(block, /msg-0/);
  assert.ok(chats[0].summary.length <= SUMMARY_CHARS, 'stored summary is capped');
});
