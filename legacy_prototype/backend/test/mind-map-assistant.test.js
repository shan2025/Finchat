// test/mind-map-assistant.test.js — the map AI's ops are checked before the
// user sees them: short ids map back, the root is untouchable, a node can never
// move inside its own branch, and made-up ids are dropped.
const { test } = require('node:test');
const assert = require('node:assert');
const { snapshot, normalizeOps } = require('../services/cognitive/mindMapAssistant');

const nodes = [
  { node_id: 'R', parent_id: null, label: 'Duxbe AI launch', order_index: 0 },
  { node_id: 'B1', parent_id: 'R', label: 'Beta', summary: 'By 3 October', order_index: 0 },
  { node_id: 'B2', parent_id: 'R', label: 'GCC markets', order_index: 1 },
  { node_id: 'L1', parent_id: 'B1', label: 'Recruit businesses', order_index: 0 },
  { node_id: 'L2', parent_id: 'B1', label: 'Website', order_index: 1 }
];

test('the model sees the tree in order with short ids, never real ones', () => {
  const s = snapshot(nodes);
  assert.deepStrictEqual(s.nodes.map(n => [n.id, n.parent, n.label]), [
    ['n1', null, 'Duxbe AI launch'], ['n2', 'n1', 'Beta'], ['n3', 'n2', 'Recruit businesses'],
    ['n4', 'n2', 'Website'], ['n5', 'n1', 'GCC markets']
  ]);
  assert.ok(!JSON.stringify(s.nodes).includes('"B1"'));
});

test('ops are validated: root protected, no moving into your own branch, unknown ids dropped', () => {
  const s = snapshot(nodes);
  const { ops, dropped } = normalizeOps([
    { op: 'add_node', parent: 'n5', label: 'Arabic support', ref: 'a1' },
    { op: 'add_node', parent: 'a1', label: 'RTL layout' },            // under the node added just above
    { op: 'move_node', node: 'n2', parent: 'n3' },                    // Beta into its own child → refused
    { op: 'move_node', node: 'n4', parent: 'n5' },
    { op: 'update_node', node: 'n1', label: 'Renamed root' },         // root → refused
    { op: 'delete_node', node: 'n1' },                                // root → refused
    { op: 'delete_node', node: 'n2' },
    { op: 'update_node', node: 'n9', label: 'Ghost' },                // no such node
    { op: 'update_node', node: 'n3', label: 'Recruit businesses' }    // no actual change
  ], { nodeIds: s.nodeIds, nodes });

  assert.strictEqual(dropped, 5);
  assert.deepStrictEqual(ops.map(o => o.op), ['add_node', 'add_node', 'move_node', 'delete_node']);
  assert.strictEqual(ops[0].parentId, 'B2');
  assert.strictEqual(ops[1].parentRef, 'a1');
  assert.strictEqual(ops[1].line, 'Add “RTL layout” under “Arabic support”');
  assert.strictEqual(ops[2].line, 'Move “Website” under “GCC markets”');
  assert.strictEqual(ops[3].line, 'Delete “Beta” and the 2 nodes under it');
  assert.strictEqual(ops[3].danger, true);
});
