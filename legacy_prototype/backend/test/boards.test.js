// test/boards.test.js — the parts of Kanban boards that need no database:
// how tags get their colours, and how an agent's words find a board/column/card.
const { test } = require('node:test');
const assert = require('node:assert');
const Boards = require('../services/boards');
const { pick } = require('../tools/BoardsTool');

test('a tag keeps the colour the board already gave it, on every card', () => {
  const palette = [{ label: 'Core', color: '#6631d7' }];
  const tags = Boards.normTags(['core', 'Operations', { label: 'High', color: '#2b59c3' }], palette);
  assert.deepStrictEqual(tags[0], { label: 'core', color: '#6631d7' });
  assert.strictEqual(tags[2].color, '#2b59c3');
  // A new tag takes a colour nobody on the board is using yet.
  assert.notStrictEqual(tags[1].color, '#6631d7');
  assert.notStrictEqual(tags[1].color, '#2b59c3');
});

test('tags are deduplicated, trimmed, capped, and a bad colour is replaced', () => {
  const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
  assert.strictEqual(Boards.normTags(many).length, Boards.LIMITS.tags);
  const t = Boards.normTags(['  Sales   Channels ', 'sales channels', { label: 'X', color: 'red;background:url(x)' }]);
  assert.deepStrictEqual(t.map(x => x.label), ['Sales Channels', 'X']);
  assert.match(t[1].color, /^#[0-9a-f]{6}$/i);
  assert.strictEqual(Boards.normTags(undefined), undefined);
  assert.throws(() => Boards.normTags('Core'), /must be an array/);
});

test('isoDate formats a DATE column without shifting it a day', () => {
  assert.strictEqual(Boards.isoDate(new Date(2026, 9, 1)), '2026-10-01');
  assert.strictEqual(Boards.isoDate('2026-10-31T00:00:00.000Z'), '2026-10-31');
});

test('the agent finds a card by id, exact name, or the one name containing it', () => {
  const cards = [
    { card_id: 'c1', title: 'Inventory' }, { card_id: 'c2', title: 'Inventory sync' },
    { card_id: 'c3', title: 'Loyalty Points' }
  ];
  assert.strictEqual(pick(cards, 'c3', 'card_id', 'card').card_id, 'c3');
  assert.strictEqual(pick(cards, 'inventory', 'card_id', 'card').card_id, 'c1');   // exact beats partial
  assert.strictEqual(pick(cards, 'loyalty', 'card_id', 'card').card_id, 'c3');
  assert.throws(() => pick(cards, 'sync inv', 'card_id', 'card'), /No card called/);
  assert.throws(() => pick([...cards, { card_id: 'c4', title: 'Loyalty tiers' }], 'loyalty', 'card_id', 'card'),
    /More than one card matches/);
});

test('an AI plan is clamped to shape: bad dates, priorities and empty titles are dropped', () => {
  const plan = Boards.normalizePlan({
    title: '  POS   launch ',
    columns: [
      { title: 'To do', cards: [
        { title: 'Write spec', priority: 'HIGH', tags: ['Product', 'product', ''], startDate: '2026-10-05', endDate: '2026-10-01' },
        { title: '', summary: 'no title, dropped' },
        { title: 'Pick vendor', priority: 'urgent', startDate: 'next week', endDate: '2026-02-30' },
        'Plain string card'
      ] },
      { title: '', cards: [{ title: 'orphan column is dropped' }] },
      { title: 'Done', cards: [] }
    ]
  });
  assert.strictEqual(plan.title, 'POS launch');
  assert.deepStrictEqual(plan.columns.map(c => c.title), ['To do', 'Done']);   // empty Done column is kept
  const [spec, vendor, plain] = plan.columns[0].cards;
  assert.strictEqual(spec.priority, 'high');
  assert.strictEqual(spec.startDate, '2026-10-05');
  assert.strictEqual(spec.endDate, null);                // ended before it started
  assert.strictEqual(vendor.priority, null);
  assert.strictEqual(vendor.startDate, null);
  assert.strictEqual(vendor.endDate, null);              // Feb 30 is not a date
  assert.strictEqual(plain.title, 'Plain string card');
  assert.strictEqual(plan.cardCount, 3);
});

test('an AI plan never exceeds the card cap, and its tags share one palette', () => {
  const cards = Array.from({ length: 12 }, (_, i) => ({ title: `Task ${i}`, tags: ['Design', `Area ${i % 3}`] }));
  const plan = Boards.normalizePlan({ columns: Array.from({ length: 10 }, (_, i) => ({ title: `C${i}`, cards })) });
  assert.strictEqual(plan.columns.length, 8);
  assert.ok(plan.cardCount <= 80);
  const palette = Boards.planPalette(plan);
  assert.deepStrictEqual(palette.map(t => t.label), ['Design', 'Area 0', 'Area 1', 'Area 2']);
  assert.strictEqual(new Set(palette.map(t => t.color)).size, 4);
});

test('an AI board needs words or an image, and only a raster image', async () => {
  await assert.rejects(Boards.generateBoard('u1', '  '), /Describe what the board should plan, or add an image/);
  // SVG can carry script and is not something a vision model reads — refused before any model call.
  await assert.rejects(Boards.generateBoard('u1', '', { image: { buffer: Buffer.from('<svg/>'), mimetype: 'image/svg+xml' } }),
    /PNG, JPEG, WebP or GIF/);
  await assert.rejects(Boards.generateBoard('u1', '', { image: { buffer: Buffer.alloc(8 * 1024 * 1024 + 1), mimetype: 'image/png' } }),
    /over 8 MB/);
});

test('a board becomes a map: board → root, columns → branches, cards → leaves with their facts', () => {
  let n = 0;
  const rows = Boards.mapRowsFromBoard('mm_1',
    { title: 'Launch', description: 'Ship it' },
    [{ column_id: 'a', title: 'To do' }, { column_id: 'b', title: 'Done' }],
    [{ card_id: 'k1', column_id: 'a', title: 'Spec', summary: 's', detail: 'Steps', priority: 'high',
       start_date: '2026-10-01', end_date: null, tags: [{ label: 'Product', color: '#6631d7' }] }],
    () => `id${n++}`);
  assert.deepStrictEqual(rows.map(r => [r.label, r.node_type, r.parent_id]),
    [['Launch', 'root', null], ['To do', 'branch', 'id0'], ['Spec', 'leaf', 'id1'], ['Done', 'leaf', 'id0']]);
  assert.strictEqual(rows[2].cardId, 'k1');
  assert.match(rows[2].detail, /^Steps\n\nPriority: high · Dates: 2026-10-01 → … · Tags: Product$/);
  assert.strictEqual(rows[1].summary, '1 card');
});
