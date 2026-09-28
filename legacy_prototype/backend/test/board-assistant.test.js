// test/board-assistant.test.js — the board AI's ops are checked before anyone
// sees them: short ids map back to real ones, made-up ids are dropped, and every
// kept op carries the plain-English line the Apply preview shows.
const { test } = require('node:test');
const assert = require('node:assert');
const { snapshot, normalizeOps } = require('../services/boardAssistant');

const columns = [
  { column_id: 'colA', title: 'To do', order_index: 0 },
  { column_id: 'colB', title: 'Done', order_index: 1 }
];
const cards = [
  { card_id: 'cardX', column_id: 'colA', title: 'UC-06 Domain purchase', summary: 'Owner buys a domain', order_index: 0,
    tags: [{ label: 'Domain', color: '#fb8c00' }], priority: 'high', start_date: '2026-10-01', end_date: '2026-10-02' },
  { card_id: 'cardY', column_id: 'colB', title: 'UC-01 Sign up', summary: '', order_index: 0, tags: [], priority: null }
];

test('the model sees short ids and trimmed cards, never real ids', () => {
  const s = snapshot({ columns, cards });
  assert.deepStrictEqual(s.board.columns, [{ id: 'k1', title: 'To do' }, { id: 'k2', title: 'Done' }]);
  assert.strictEqual(s.board.cards[0].id, 'c1');
  assert.strictEqual(s.board.cards[0].col, 'k1');
  assert.deepStrictEqual(s.board.cards[0].tags, ['Domain']);
  assert.ok(!JSON.stringify(s.board).includes('cardX'));
  assert.strictEqual(s.cardIds.get('c2'), 'cardY');
});

test('ops map back to real ids; unknown ids and junk are dropped, not guessed', () => {
  const s = snapshot({ columns, cards });
  const { ops, dropped } = normalizeOps([
    { op: 'add_column', title: 'Blocked', ref: 'n1' },
    { op: 'update_card', card: 'c1', col: 'n1', priority: 'MEDIUM' },
    { op: 'update_card', card: 'c99', priority: 'low' },          // no such card
    { op: 'delete_card', card: 'c2' },
    { op: 'add_card', col: 'k2', title: 'UC-19 Voice login', tags: ['Onboarding'], end: '2026-10-05' },
    { op: 'rename_column', col: 'k7', title: 'x' },                // no such column
    { op: 'update_card', card: 'c1', start: '2026-10-09', end: '2026-10-03' },   // ends before it starts
    { op: 'launch_rockets' }
  ], { colIds: s.colIds, cardIds: s.cardIds, cards, columns });

  assert.strictEqual(dropped, 4);
  assert.deepStrictEqual(ops.map(o => o.op), ['add_column', 'update_card', 'delete_card', 'add_card']);
  assert.strictEqual(ops[1].cardId, 'cardX');
  assert.strictEqual(ops[1].ref, 'n1');                            // moves into the column added above
  assert.strictEqual(ops[1].fields.priority, 'medium');
  assert.strictEqual(ops[1].line, '“UC-06 Domain purchase”: move to Blocked, priority medium');
  assert.strictEqual(ops[2].cardId, 'cardY');
  assert.strictEqual(ops[2].danger, true);
  assert.strictEqual(ops[3].columnId, 'colB');
  // The preview line shows what the new card will carry, not just its title.
  assert.strictEqual(ops[3].line, 'Add “UC-19 Voice login” to Done (… → 2026-10-05, tags: Onboarding)');
});

test('a change that changes nothing is not offered', () => {
  const s = snapshot({ columns, cards });
  const { ops, dropped } = normalizeOps([{ op: 'update_card', card: 'c1', col: 'k1' }],
    { colIds: s.colIds, cardIds: s.cardIds, cards, columns });
  assert.strictEqual(ops.length, 0);
  assert.strictEqual(dropped, 1);
});
