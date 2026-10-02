// Public Telegram subscribers: the bot's command handling and the general edition's send loop.
const test = require('node:test');
const assert = require('node:assert');
// Emoji logs can corrupt node:test's stream on Windows; they are not under test.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const bot = require('../services/telegramBot');
const pub = require('../services/newsletter/public');
const { caption } = require('../services/newsletter');

const ISSUE = `# FinChat Daily — 2 Oct 2026

Oil set the tone.

## Executive Summary
- **Oil up** — Brent +1.6% [1].

## Markets
### Brent jumps on Hormuz
#### Proposal rejected
Brent rose 1.59% to $93.88 ([Bloomberg][1]).

**Why it matters** — inflation risk.
*In short: oil sets the tone*

## 🎯 Key Takeaway
Energy drove everything.

[1]: https://www.bloomberg.com/x "Bloomberg oil"
`;

// A fake pg `query`: each handler is [regex, fn(params) -> rows]; every call is recorded.
function fakeDb(handlers) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return { rows: (await fn(params)) || [] };
    return { rows: [] };
  };
  return { query, calls, ran: (re) => calls.filter(c => re.test(c.sql)) };
}

test('parseCommand handles payloads and @BotName suffixes', () => {
  assert.deepStrictEqual(bot.parseCommand('/start'), { cmd: 'start', arg: '' });
  assert.deepStrictEqual(bot.parseCommand('/start@FinChatBot fcab12cd34'), { cmd: 'start', arg: 'fcab12cd34' });
  assert.deepStrictEqual(bot.parseCommand(' /STOP '), { cmd: 'stop', arg: '' });
  assert.strictEqual(bot.parseCommand('hello'), null);
});

test('/start subscribes and welcomes; a repeat says "already"', async () => {
  let wasActive = null;
  const db = fakeDb([[/INSERT INTO telegram_subscribers/, () => [{ was_active: wasActive }]]]);
  const said = [];
  const send = async (chatId, text) => { said.push([chatId, text]); };
  const u = { update_id: 1, message: { text: '/start', chat: { id: 42, type: 'private', first_name: 'A' } } };

  assert.strictEqual(await bot.handleUpdate(u, { query: db.query, send }), 'subscribed');
  assert.deepStrictEqual(db.calls[0].params, ['42', 'private', null, 'A']);
  assert.match(said[0][1], /Welcome/);

  wasActive = true;
  assert.strictEqual(await bot.handleUpdate(u, { query: db.query, send }), 'already');
  assert.match(said[1][1], /already subscribed/);

  wasActive = false; // came back after /stop
  assert.strictEqual(await bot.handleUpdate(u, { query: db.query, send }), 'subscribed');
  assert.match(said[2][1], /Welcome/);
});

test('/start <link code> is filed for Settings, not subscribed', async () => {
  const db = fakeDb([]);
  const what = await bot.handleUpdate({ update_id: 2, message: { text: '/start fcab12cd34', chat: { id: 7 } } },
    { query: db.query, send: async () => {} });
  assert.strictEqual(what, 'link');
  assert.strictEqual(db.ran(/telegram_link_starts/).length, 1);
  assert.deepStrictEqual(db.calls[0].params, ['fcab12cd34', '7']);
  assert.strictEqual(db.ran(/telegram_subscribers/).length, 0);
});

test('/stop unsubscribes; a failed reply never fails the update', async () => {
  const db = fakeDb([]);
  const what = await bot.handleUpdate({ update_id: 3, message: { text: '/stop', chat: { id: 9 } } },
    { query: db.query, send: async () => { throw new Error('Forbidden: bot was blocked'); } });
  assert.strictEqual(what, 'unsubscribed');
  assert.strictEqual(db.ran(/SET active = false/).length, 1);
});

test('pollOnce confirms handled updates and retries a failing one before skipping it', async () => {
  bot._resetForTests();
  const offsets = [];
  let failNext = 2;
  const updates = [
    { update_id: 10, message: { text: '/help', chat: { id: 1 } } },
    { update_id: 11, message: { text: '/stop', chat: { id: 2 } } }
  ];
  const deps = {
    getUpdates: async (off) => { offsets.push(off); return updates.filter(u => off == null || u.update_id >= off); },
    send: async () => {},
    query: async (sql) => { if (/active = false/.test(sql) && failNext-- > 0) throw new Error('db down'); return { rows: [] }; }
  };
  await bot.pollOnce(deps);      // 10 ok, 11 fails (1/3) → stop, offset 11
  await bot.pollOnce(deps);      // 11 fails (2/3)
  const third = await bot.pollOnce(deps);  // 11 succeeds
  await bot.pollOnce(deps);
  assert.deepStrictEqual(offsets, [null, 11, 11, 12]);
  assert.strictEqual(third.unsubscribed, 1);
});

test('caption footer survives the 1024-char cap', () => {
  const c = caption({ title: 'T', date: 'D', stories: Array(6).fill('x'.repeat(300)), footer: '<i>Send /stop to unsubscribe.</i>' });
  assert.ok(c.length <= 1024);
  assert.ok(c.endsWith('<i>Send /stop to unsubscribe.</i>'));
});

test('public sources: briefings only, distinct, oldest first, capped', async () => {
  const t = (h) => new Date(Date.UTC(2026, 9, 2, h));
  const db = fakeDb([[/FROM notifications/, () => [
    { title: 'E', content: 'evening '.repeat(60), created_at: t(14) },
    { title: 'E copy', content: 'evening '.repeat(60), created_at: t(13) },
    { title: 'M', content: 'midday '.repeat(60), created_at: t(8) }
  ]]]);
  const rows = await pub.gatherPublicSources(t(0), db.query);
  assert.deepStrictEqual(rows.map(r => r.title), ['M', 'E']);
  assert.match(db.calls[0].sql, /type = 'briefing'/);
  assert.doesNotMatch(db.calls[0].sql, /mission/);
});

test('the public editor brief strips personal material', () => {
  assert.match(pub.PUBLIC_PROMPT, /portfolio, holdings, watchlist, job search/);
  assert.match(pub.PUBLIC_PROMPT, /Never recommend buying or selling/);
});

test('send loop: uploads once then reuses file_id, drops blocked chats, defers on 429', async () => {
  pub._resetForTests();
  const batches = [['a', 'b', 'c', 'd', 'e']];
  const db = fakeDb([[/SET last_sent_day = \$1/, () => (batches.shift() || []).map(chat_id => ({ chat_id }))]]);
  const sentWith = [];
  const sendDocument = async (chatId, doc) => {
    sentWith.push([chatId, Buffer.isBuffer(doc) ? 'upload' : doc]);
    if (chatId === 'b') throw Object.assign(new Error('x'), { response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } } });
    if (chatId === 'c') throw Object.assign(new Error('x'), { response: { status: 400, data: { description: 'Bad Request: something odd' } } });
    if (chatId === 'd') throw Object.assign(new Error('x'), { response: { status: 429, data: { description: 'Too Many Requests: retry after 5' } } });
    return { status: 'sent', fileId: 'FILE123' };
  };
  const issue = { day: '2026-10-02', date: '2 Oct 2026', markdown: ISSUE, status: 'ready', file_id: null };
  const tally = await pub.sendToSubscribers(issue, { query: db.query, sendDocument, paceMs: 0 });

  assert.deepStrictEqual(tally, { sent: 1, failed: 1, removed: 1, deferred: 2 });
  assert.deepStrictEqual(sentWith, [['a', 'upload'], ['b', 'FILE123'], ['c', 'FILE123'], ['d', 'FILE123']]);
  assert.deepStrictEqual(db.ran(/SET file_id/)[0].params, ['2026-10-02', 'FILE123']);
  assert.deepStrictEqual(db.ran(/SET active = false/)[0].params[0], 'b');
  assert.deepStrictEqual(db.ran(/last_sent_day = NULL/)[0].params, [['d', 'e']]);
  assert.deepStrictEqual(db.ran(/sent_count = sent_count/)[0].params, ['2026-10-02', 1, 1]);
});

test('runPublicNewsletter waits for 09:00 IST and skips the build when nobody is due', async () => {
  pub._resetForTests();
  const sendDocument = async () => ({ status: 'sent' });
  const early = await pub.runPublicNewsletter({ now: new Date('2026-10-02T02:00:00Z'), deps: { sendDocument } });
  assert.match(early.skipped, /before 9:00 IST/);

  const db = fakeDb([[/count\(\*\)::int AS n/, () => [{ n: 0 }]]]);
  const r = await pub.runPublicNewsletter({ now: new Date('2026-10-02T05:00:00Z'), deps: { query: db.query, sendDocument } });
  assert.deepStrictEqual(r, { day: '2026-10-02', due: 0 });
  assert.strictEqual(db.ran(/public_newsletters/).length, 0, 'no issue built for an empty list');
});

test('ensureIssue records an empty day without calling the editor', async () => {
  const db = fakeDb([
    [/INSERT INTO public_newsletters/, () => [{ day: '2026-10-02' }]],
    [/FROM notifications/, () => []]
  ]);
  let asked = false;
  const r = await pub.ensureIssue('2026-10-02', new Date('2026-10-02T05:00:00Z'),
    { query: db.query, runInference: async () => { asked = true; } });
  assert.strictEqual(r.status, 'empty');
  assert.strictEqual(asked, false);
  assert.match(db.ran(/UPDATE public_newsletters/)[0].params[1], /empty/);
});

test('ensureIssue builds a ready issue from briefings with the public brief', async () => {
  pub._resetForTests();
  const db = fakeDb([
    [/INSERT INTO public_newsletters/, () => [{ day: '2026-10-02' }]],
    [/FROM notifications/, () => [{ type: 'briefing', title: 'B', content: 'z'.repeat(400), created_at: new Date() }]]
  ]);
  let prompt;
  const r = await pub.ensureIssue('2026-10-02', new Date('2026-10-02T05:00:00Z'), {
    query: db.query,
    runInference: async ({ messages }) => { prompt = messages[0].content; return { content: ISSUE }; }
  });
  assert.strictEqual(r.status, 'ready');
  assert.match(prompt, /free public market newsletter/);
  const fin = db.ran(/UPDATE public_newsletters SET status/)[0].params;
  assert.strictEqual(fin[1], 'ready');
  assert.strictEqual(fin[4], ISSUE.trim());
});
