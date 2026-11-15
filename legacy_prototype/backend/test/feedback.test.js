// test/feedback.test.js — the thumbs on an answer, stored on its run.
//
// The only quality signal the Agent Map has that is not "did it finish". These
// tests run against a fake query function, never a database: they pin the
// input contract, owner scoping (rating another account's run must match
// nothing), and the message↔run link that lets a reopened chat show its thumbs.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseRating, setRating, linkMessage, lookupByMessages } = require('../services/feedback');

const fakeQuery = (rows = [], rowCount = rows.length) => {
  const calls = [];
  const q = async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount }; };
  q.calls = calls;
  return q;
};

describe('parseRating', () => {
  test('up and down in any reasonable spelling', () => {
    for (const v of ['up', 1, '1']) assert.equal(parseRating(v), 1);
    for (const v of ['down', -1, '-1']) assert.equal(parseRating(v), -1);
  });
  test('null-ish clears', () => {
    for (const v of [null, 0, '0', 'none', 'clear']) assert.equal(parseRating(v), null);
  });
  test('anything else is rejected, not guessed', () => {
    for (const v of [undefined, 'great', 5, 2, {}, [], true]) assert.equal(parseRating(v), undefined);
  });
});

describe('setRating', () => {
  test('writes the rating into metrics, scoped to the owner', async () => {
    const q = fakeQuery([{ execution_id: 'e1' }]);
    const out = await setRating({ query: q, executionId: 'e1', userId: 'u1', rating: -1 });
    assert.deepEqual(out, { found: true, rating: -1 });
    const { sql, params } = q.calls[0];
    assert.match(sql, /WHERE execution_id = \$1 AND user_id = \$2/, 'must be owner-scoped');
    assert.match(sql, /'feedback'/);
    assert.match(sql, /metrics = COALESCE\(metrics, '\{\}'::jsonb\)\s*\|\|/, 'merges, never overwrites metrics');
    assert.deepEqual(params, ['e1', 'u1', -1]);
  });

  test('clearing removes the key instead of storing a zero', async () => {
    const q = fakeQuery([{ execution_id: 'e1' }]);
    await setRating({ query: q, executionId: 'e1', userId: 'u1', rating: null });
    assert.match(q.calls[0].sql, /- 'feedback'/);
    assert.deepEqual(q.calls[0].params, ['e1', 'u1']);
  });

  test("someone else's run (or no run) is reported as not found", async () => {
    const out = await setRating({ query: fakeQuery([], 0), executionId: 'e9', userId: 'u1', rating: 1 });
    assert.deepEqual(out, { found: false });
  });
});

describe('message ↔ run link', () => {
  test('linkMessage stamps messageId, owner-scoped, and is a no-op without ids', async () => {
    const q = fakeQuery();
    await linkMessage({ query: q, executionId: 'e1', userId: 'u1', messageId: 'm1' });
    assert.match(q.calls[0].sql, /'messageId'/);
    assert.match(q.calls[0].sql, /AND user_id = \$2/);
    await linkMessage({ query: q, executionId: null, userId: 'u1', messageId: 'm1' });
    await linkMessage({ query: q, executionId: 'e1', userId: 'u1', messageId: null });
    assert.equal(q.calls.length, 1);
  });

  test('lookupByMessages maps each message to its run and rating', async () => {
    const q = fakeQuery([
      { execution_id: 'e1', message_id: 'm1', rating: '1' },
      { execution_id: 'e2', message_id: 'm2', rating: '-1' },
      { execution_id: 'e3', message_id: 'm3', rating: null }
    ]);
    const map = await lookupByMessages({ query: q, userId: 'u1', messageIds: ['m1', 'm2', 'm3', null] });
    assert.deepEqual(map.get('m1'), { executionId: 'e1', rating: 1 });
    assert.deepEqual(map.get('m2'), { executionId: 'e2', rating: -1 });
    assert.deepEqual(map.get('m3'), { executionId: 'e3', rating: null });
    assert.match(q.calls[0].sql, /WHERE user_id = \$1/);
    assert.deepEqual(q.calls[0].params, ['u1', ['m1', 'm2', 'm3']]);
  });

  test('no ids → no query', async () => {
    const q = fakeQuery();
    assert.equal((await lookupByMessages({ query: q, userId: 'u1', messageIds: [] })).size, 0);
    assert.equal(q.calls.length, 0);
  });
});

describe('wiring', () => {
  const BACKEND = path.join(__dirname, '..');
  const read = (...p) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8');

  test('the feedback route requires auth and goes through the service', () => {
    const src = read('routes', 'executions.js');
    assert.match(src, /router\.post\('\/:id\/feedback', requireAuth,/);
    assert.match(src, /setRating\(\{ query, executionId: req\.params\.id, userId: req\.user\.id/);
  });

  test('chat links each answer to its run and returns the run id', () => {
    const src = read('routes', 'aiChat.js');
    assert.match(src, /linkMessage\(\{ query, executionId: result\.executionId, userId, messageId: botMsgId \}\)/);
    assert.match(src, /executionId: result\.executionId \|\| null/);
    assert.match(src, /lookupByMessages\(/);
  });

  test('every scorer reads the rating from the same place', () => {
    for (const f of [['services', 'AgentLeaderboard.js'], ['services', 'cognitive', 'RouteOptimizer.js']]) {
      assert.match(read(...f), /metrics->'feedback'->>'rating'/, f.join('/'));
    }
  });

  test('the chat page sends thumbs to the feedback route', () => {
    const html = fs.readFileSync(path.join(BACKEND, '..', 'frontend', 'finchat_chat.html'), 'utf8');
    assert.match(html, /\/api\/executions\/\$\{encodeURIComponent\(rb\.dataset\.exec\)\}\/feedback/);
    assert.match(html, /function rateButtons\(executionId, rating\)/);
  });
});
