// test/board-guests.test.js — edit links without an account, and undo
// (migration 065): the parts that need no database. What a guest may reach,
// how they are named, and what a drag records for undo.
const { test } = require('node:test');
const assert = require('node:assert');
const Boards = require('../services/boards');
const { guestMayUse } = require('../routes/sharedBoards');

const withDocs = { include_docs: true };
const noDocs = { include_docs: false };

test('a guest can work on cards, lanes and files', () => {
  for (const [m, p] of [
    ['GET', '/'], ['GET', '/stamp'], ['GET', '/activity'],
    ['POST', '/cards'], ['PATCH', '/cards/bcd_1'], ['DELETE', '/cards/bcd_1'], ['POST', '/cards/order'],
    ['POST', '/columns'], ['PATCH', '/columns/bcl_1'], ['DELETE', '/columns/bcl_1'], ['POST', '/columns/order'],
    ['POST', '/attachments'], ['POST', '/attachments/text'], ['POST', '/attachments/links'],
    ['GET', '/attachments/bat_1'], ['GET', '/attachments/bat_1/file'], ['DELETE', '/attachments/bat_1']
  ]) assert.ok(guestMayUse(m, p, withDocs), `${m} ${p}`);
});

test('a guest cannot touch the board itself, sharing, people, Ask AI, mind maps or undo', () => {
  for (const [m, p] of [
    ['PATCH', '/'], ['DELETE', '/'], ['GET', '/shares'], ['POST', '/shares'], ['DELETE', '/shares/bsh_1'],
    ['GET', '/members'], ['POST', '/members'], ['DELETE', '/members/u1'],
    ['POST', '/assistant'], ['POST', '/assistant/apply'], ['POST', '/mind-map'],
    ['GET', '/guests'], ['POST', '/guests/bgu_1/undo'], ['POST', '/activity/bac_1/undo'],
    ['PUT', '/cards/bcd_1'], ['GET', '/cards/../shares']
  ]) assert.ok(!guestMayUse(m, p, withDocs), `${m} ${p}`);
});

test('a link without files gives a guest no file routes', () => {
  for (const [m, p] of [['POST', '/attachments'], ['GET', '/attachments/bat_1/file'], ['DELETE', '/attachments/bat_1']]) {
    assert.ok(!guestMayUse(m, p, noDocs), `${m} ${p}`);
  }
  assert.ok(guestMayUse('POST', '/cards', noDocs));
});

test('guests are numbered, with their name when they give one', () => {
  assert.strictEqual(Boards.guestLabel(2, ''), 'Guest 2');
  assert.strictEqual(Boards.guestLabel(2, 'Ravi'), 'Guest 2 · Ravi');
});

test('an actor is a user id or a guest', () => {
  assert.deepStrictEqual(Boards.actorOf('u1'), { userId: 'u1', guestId: null });
  assert.deepStrictEqual(Boards.actorOf({ guestId: 'bgu_1' }), { userId: null, guestId: 'bgu_1' });
  assert.deepStrictEqual(Boards.actorOf(null), { userId: null, guestId: null });
});

test('a guest is refused anything owner-only before the database is asked', async () => {
  await assert.rejects(Boards.requireBoard('brd_1', { guestId: 'bgu_1' }, 'owner'), /Only the board owner/);
  await assert.rejects(Boards.deleteBoard('brd_1', { guestId: 'bgu_1' }), /Only the board owner/);
});

test('a drag records only the cards that moved, before and after, keyed by card', () => {
  const before = [
    { card_id: 'a', column_id: 'c1', order_index: 0 },
    { card_id: 'b', column_id: 'c1', order_index: 1 },
    { card_id: 'c', column_id: 'c2', order_index: 0 }
  ];
  const after = [
    { card_id: 'a', column_id: 'c1', order_index: 0 },   // did not move
    { card_id: 'c', column_id: 'c1', order_index: 1 },   // handed over
    { card_id: 'b', column_id: 'c1', order_index: 2 }    // pushed back
  ];
  assert.deepStrictEqual(Boards.positionsUndo(before, after), {
    type: 'positions',
    before: { c: { column_id: 'c2', order_index: 0 }, b: { column_id: 'c1', order_index: 1 } },
    after: { c: { column_id: 'c1', order_index: 1 }, b: { column_id: 'c1', order_index: 2 } }
  });
  assert.strictEqual(Boards.positionsUndo(before, before), null, 'nothing moved → nothing to undo');
});

test('undo compares values the way they are stored', () => {
  assert.strictEqual(Boards.cardValue('end_date', '2026-10-10T00:00:00Z'), '2026-10-10');
  assert.strictEqual(Boards.cardValue('done_at', '2026-10-01T10:00:00Z'), '2026-10-01T10:00:00.000Z');
  assert.strictEqual(Boards.cardValue('order_index', '3'), 3);
  assert.strictEqual(Boards.cardValue('priority', undefined), null);
});
