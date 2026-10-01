// test/board-queues.test.js — queues (migration 061), the parts that need no
// database: a queue is a board kind, the AI sees each lane in work order with
// positions, and its pos/done changes are checked before anyone sees them.
const { test } = require('node:test');
const assert = require('node:assert');
const Boards = require('../services/boards');
const { snapshot, normalizeOps, systemPrompt } = require('../services/boardAssistant');

const board = { kind: 'queue' };
const columns = [
  { column_id: 'laneA', title: 'Asha', order_index: 0 },
  { column_id: 'laneR', title: 'Ravi', order_index: 1 }
];
// order_index is the slot number; Asha's finished task kept an old, low one.
const cards = [
  { card_id: 'send', column_id: 'laneA', title: 'Send the invoice', order_index: 3, tags: [] },
  { card_id: 'old', column_id: 'laneA', title: 'Book the venue', order_index: 0, tags: [], done_at: new Date('2026-09-30T10:00:00Z') },
  { card_id: 'call', column_id: 'laneA', title: 'Call the bank', order_index: 5, tags: [] },
  { card_id: 'menu', column_id: 'laneR', title: 'Print the menu', order_index: 0, tags: [] }
];

test('only kanban and queue are kinds of board — refused before anything is written', async () => {
  assert.deepStrictEqual([...Boards.KINDS], ['kanban', 'queue']);
  await assert.rejects(Boards.createBoard('u1', { title: 'x', kind: 'gantt' }), /kind must be kanban or queue/);
  await assert.rejects(Boards.generateBoard('u1', 'plan', { kind: 'gantt' }), /kind must be kanban or queue/);
});

test('an AI queue needs to know who does what', async () => {
  await assert.rejects(Boards.generateBoard('u1', ' ', { kind: 'queue' }), /Say who does what, or add a file or image/);
});

test('the model sees each lane front to back: pos 1 is now, finished tasks last', () => {
  const s = snapshot({ columns, cards, board });
  assert.strictEqual(s.queue, true);
  assert.deepStrictEqual(s.board.cards.map(c => [c.col, c.title, c.pos, c.done]), [
    ['k1', 'Send the invoice', 1, undefined],
    ['k1', 'Call the bank', 2, undefined],
    ['k1', 'Book the venue', undefined, true],     // done, despite its lower slot number
    ['k2', 'Print the menu', 1, undefined]
  ]);
  assert.strictEqual(s.posOf.get('call'), 2);
  assert.ok(!s.posOf.has('old'));
  // A Kanban board's snapshot is unchanged: no positions, no done.
  const k = snapshot({ columns, cards: cards.filter(c => !c.done_at) });
  assert.strictEqual(k.queue, false);
  assert.ok(k.board.cards.every(c => c.pos === undefined && c.done === undefined));
});

test('queue ops: pos and done are checked, worded, and no-ops dropped', () => {
  const s = snapshot({ columns, cards, board });
  const ctx = { colIds: s.colIds, cardIds: s.cardIds, cards, columns, queue: true, posOf: s.posOf };
  // c1 send (pos 1), c2 call (pos 2), c3 old (done), c4 menu (Ravi, pos 1)
  const { ops, dropped } = normalizeOps([
    { op: 'update_card', card: 'c2', pos: 1 },                    // Call the bank → front
    { op: 'update_card', card: 'c1', done: true },                // finish the front task
    { op: 'update_card', card: 'c3', done: false, pos: 4 },       // put back — pos ignored
    { op: 'update_card', card: 'c4', col: 'k1', pos: 2 },         // hand to Asha, as her next
    { op: 'update_card', card: 'c2', pos: 2 },                    // already second: nothing to do
    { op: 'update_card', card: 'c1', done: false },               // not done, so nothing to undo
    { op: 'update_card', card: 'c2', pos: 0 },                    // not a position
    { op: 'add_card', col: 'k2', title: 'Order napkins', pos: 1 }
  ], ctx);
  assert.strictEqual(dropped, 3);
  assert.deepStrictEqual(ops.map(o => o.line), [
    '“Call the bank”: move to the front',
    '“Send the invoice”: mark done',
    '“Book the venue”: put back at the front of the queue',
    '“Print the menu”: move to Asha\'s queue, as next',
    'Add “Order napkins” to Ravi\'s queue, at the front'
  ]);
  assert.strictEqual(ops[0].pos, 1);
  assert.strictEqual(ops[1].done, true);
  assert.strictEqual(ops[2].done, false);
  assert.strictEqual(ops[2].pos, undefined);
  assert.strictEqual(ops[3].columnId, 'laneA');
  assert.strictEqual(ops[4].pos, 1);
});

test('on a Kanban board, pos and done are not things the AI can do', () => {
  const live = cards.filter(c => !c.done_at);
  const s = snapshot({ columns, cards: live });
  const { ops, dropped } = normalizeOps([
    { op: 'update_card', card: 'c1', done: true },
    { op: 'update_card', card: 'c2', pos: 1 }
  ], { colIds: s.colIds, cardIds: s.cardIds, cards: live, columns });
  assert.strictEqual(ops.length, 0);
  assert.strictEqual(dropped, 2);
});

test('files sent to Ask AI go onto the tasks it names them for; unknown names are ignored', () => {
  const s = snapshot({ columns, cards, board });
  const ctx = { colIds: s.colIds, cardIds: s.cardIds, cards, columns, queue: true, posOf: s.posOf,
    fileNames: ['Screenshot 2026-10-01 14.32.05.png', 'invoice.pdf'] };
  const { ops } = normalizeOps([
    { op: 'add_card', col: 'k2', title: 'Fix the till crash', files: ['screenshot 2026-10-01 14.32.05.png', 'made-up.png'] },
    { op: 'update_card', card: 'c1', files: ['invoice.pdf'] },                  // only a file: still a change
    { op: 'add_card', col: 'k1', title: 'Order napkins' }
  ], ctx);
  assert.deepStrictEqual(ops.map(o => o.attach), [[0], [1], undefined]);
  assert.strictEqual(ops[0].line, 'Add “Fix the till crash” to Ravi\'s queue — with Screenshot 2026-10-01 14.32.05.png attached');
  assert.strictEqual(ops[1].line, '“Send the invoice”: attach invoice.pdf');
});

test('"make a task for this screenshot": one new task and no file named → the task gets the files', () => {
  const s = snapshot({ columns, cards, board });
  const base = { colIds: s.colIds, cardIds: s.cardIds, cards, columns, queue: true, posOf: s.posOf };
  let { ops } = normalizeOps([{ op: 'add_card', col: 'k2', title: 'Fix the till crash' }], { ...base, fileNames: ['image.png'] });
  assert.deepStrictEqual(ops[0].attach, [0]);
  assert.match(ops[0].line, /with image\.png attached$/);
  // Two new tasks: which one the file belongs to is not guessed.
  ({ ops } = normalizeOps([{ op: 'add_card', col: 'k1', title: 'A' }, { op: 'add_card', col: 'k2', title: 'B' }],
    { ...base, fileNames: ['image.png'] }));
  assert.ok(ops.every(o => !o.attach));
  // No files sent: nothing to attach, whatever the model says.
  ({ ops } = normalizeOps([{ op: 'add_card', col: 'k1', title: 'A', files: ['x.png'] }], base));
  assert.strictEqual(ops[0].attach, undefined);
});

test('the queue prompt explains lanes, positions and done; the board prompt does not', () => {
  assert.match(systemPrompt(true), /^You edit a WORK QUEUE/);
  assert.match(systemPrompt(true), /"done": true/);
  assert.match(systemPrompt(false), /^You edit a KANBAN BOARD/);
  assert.doesNotMatch(systemPrompt(false), /WORK QUEUE/);
});

test('a queue as a mind map notes when a task was finished', () => {
  let n = 0;
  const rows = Boards.mapRowsFromBoard('mm_1', { title: 'Café week' }, [columns[0]],
    [{ card_id: 'old', column_id: 'laneA', title: 'Book the venue', done_at: '2026-09-30T10:00:00.000Z', tags: [] }],
    () => `id${n++}`);
  assert.match(rows[2].detail, /Done: 2026-09-30/);
});
