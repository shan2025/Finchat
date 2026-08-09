// Sprint Z · Track A — mind map data model + generator.
//   1. Shape enforcement (pure): branch/child caps, depth cap, dedupe, typing.
//   2. Flatten: depth-first order, parent links, node cap.
//   3. DB: insert, tree read order, cascade delete, cross-user isolation, RLS-safe ids.
//   4. Live generation (skipped with --no-llm): real hierarchy from a topic.
//
// Run: node scripts/test_mind_maps.js [--no-llm] [--model=llama-3.1-8b-instant]

const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const { query } = require(B + '/database');
const E = require(B + '/services/cognitive/MindMapEngine');

const SKIP_LLM = process.argv.includes('--no-llm');
const MODEL = (process.argv.find(a => a.startsWith('--model=')) || '').replace('--model=', '') || null;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

const created = [];   // map ids to clean up

(async () => {
  // ── 1. Shape enforcement ─────────────────────────────────────────
  console.log('\n=== 1. Shape enforcement ===');

  const fat = {
    title: 'Too Much',
    root: { label: 'Transformers', summary: 'Attention architecture.' },
    branches: Array.from({ length: 12 }, (_, i) => ({
      label: `Branch ${i}`, summary: 's',
      children: Array.from({ length: 11 }, (_, j) => ({ label: `Child ${i}-${j}`, summary: 's', detail: 'd' }))
    }))
  };
  const trimmed = E.normalizeTree(fat, 'Transformers');
  ok(trimmed.children.length === E.MAX_BRANCHES, `clamps 12 branches to ${E.MAX_BRANCHES} (got ${trimmed.children.length})`);
  ok(trimmed.children.every(b => b.children.length <= E.MAX_CHILDREN), `clamps children to ${E.MAX_CHILDREN} each`);
  ok(trimmed.nodeType === 'root', 'the root is typed root');

  const deep = {
    root: { label: 'A' },
    branches: [{ label: 'B', children: [{ label: 'C', children: [{ label: 'D', children: [{ label: 'E' }] }] }] }]
  };
  const capped = E.normalizeTree(deep, 'A');
  const depthOf = n => 1 + Math.max(0, ...n.children.map(depthOf));
  ok(depthOf(capped) <= E.MAX_DEPTH, `caps depth at ${E.MAX_DEPTH} (got ${depthOf(capped)})`);
  const labels = [];
  (function collect(n) { labels.push(n.label); n.children.forEach(collect); })(capped);
  ok(!labels.includes('E'), 'the too-deep node is dropped, not flattened up a level');

  const dupes = E.normalizeTree({
    root: { label: 'Root' },
    branches: [
      { label: 'Attention', children: [{ label: 'Softmax' }] },
      { label: 'attention', children: [{ label: 'Softmax' }] },
      { label: 'Embeddings' }, { label: 'Training' }
    ]
  }, 'Root');
  const flatLabels = [];
  (function collect(n) { flatLabels.push(n.label.toLowerCase()); n.children.forEach(collect); })(dupes);
  ok(new Set(flatLabels).size === flatLabels.length, 'case-insensitive duplicate labels are removed');

  const junk = E.normalizeTree({ root: {}, branches: [{ label: '' }, { label: '   ' }, null, 'Bare String'] }, 'Fallback');
  ok(junk.label === 'Fallback', 'a missing root label falls back to the topic');
  ok(junk.children.length === 1 && junk.children[0].label === 'Bare String', 'empty/null branches dropped, bare strings accepted');

  const typed = E.normalizeTree({ root: { label: 'R' }, branches: [{ label: 'Has kids', children: [{ label: 'Kid' }] }, { label: 'No kids' }] }, 'R');
  ok(typed.children[0].nodeType === 'branch' && typed.children[1].nodeType === 'leaf',
    'nodes with children type as branch, childless as leaf');

  ok(E.normalizeTree({ root: { label: 'X' } }, 'X').children.length === 0, 'missing branches array yields an empty root, not a throw');
  ok(E.normalizeTree(null, 'Only Topic').label === 'Only Topic', 'a null payload degrades to a topic-only root');

  // ── 2. Flatten ───────────────────────────────────────────────────
  console.log('\n=== 2. Flatten ===');
  const tree = E.normalizeTree({
    root: { label: 'Root', summary: 'r' },
    branches: [
      { label: 'One', children: [{ label: 'One-A' }, { label: 'One-B' }] },
      { label: 'Two', children: [{ label: 'Two-A' }] },
      { label: 'Three' }
    ]
  }, 'Root');
  const rows = E.flatten(tree, 'map_test');
  ok(rows.length === 7, `flattens to 7 rows (got ${rows.length})`);
  ok(rows[0].parent_id === null && rows[0].node_type === 'root', 'the root row comes first and has no parent');

  const byId = new Map(rows.map(r => [r.node_id, r]));
  const seenIds = new Set();
  let parentsFirst = true;
  for (const r of rows) {
    if (r.parent_id && !seenIds.has(r.parent_id)) parentsFirst = false;
    seenIds.add(r.node_id);
  }
  ok(parentsFirst, 'every parent appears before its children — required by the self-FK on one INSERT');
  ok(rows.every(r => !r.parent_id || byId.has(r.parent_id)), 'every parent_id references a row in the same batch');
  ok(new Set(rows.map(r => r.node_id)).size === rows.length, 'node ids are unique');
  ok(rows.filter(r => r.parent_id === rows[0].node_id).every((r, i) => r.order_index === i),
    'sibling order_index is sequential from 0');

  // ── 3. Database ──────────────────────────────────────────────────
  console.log('\n=== 3. Database ===');
  const users = await query('SELECT user_id FROM users ORDER BY created_at LIMIT 2');
  if (users.rows.length < 2) {
    console.log('  [SKIP] need two users for the isolation test');
  } else {
    const [u1, u2] = users.rows.map(r => r.user_id);

    const mapId = await E.createMap({ userId: u1, title: 'Test Map', topic: 'Testing', sourceType: 'topic' });
    created.push(mapId);
    const dbRows = E.flatten(tree, mapId);
    await E.insertNodes(dbRows);

    const full = await E.getMap(mapId, u1);
    ok(full && full.nodes.length === 7, `reads back all 7 nodes (got ${full ? full.nodes.length : 'null'})`);
    ok(full.nodes[0].parent_id === null, 'the tree read returns the root first');

    const seenDb = new Set();
    ok(full.nodes.every(n => { const okp = !n.parent_id || seenDb.has(n.parent_id); seenDb.add(n.node_id); return okp; }),
      'the recursive read orders parents before children');
    ok(full.nodes.map(n => n.label).join(',').includes('One,One-A,One-B'),
      'siblings come back in order_index order, depth-first');

    ok(await E.depthOf(full.nodes[0].node_id) === 1, 'depthOf() is 1 at the root');
    const leaf = full.nodes.find(n => n.label === 'One-A');
    ok(await E.depthOf(leaf.node_id) === 3, 'depthOf() is 3 two levels down');
    const chain = await E.ancestorChain(leaf.node_id);
    ok(chain.join(' > ') === 'Root > One > One-A', `ancestorChain is root-first (got ${chain.join(' > ')})`);

    // cross-user isolation
    ok(await E.getMap(mapId, u2) === null, "another user's map reads as null, not as data");
    const theirList = await E.listMaps(u2);
    ok(!theirList.some(m => m.map_id === mapId), 'the map does not appear in another user\'s list');

    // subtree cascade
    const branchOne = full.nodes.find(n => n.label === 'One');
    await query('DELETE FROM mind_map_nodes WHERE node_id = $1', [branchOne.node_id]);
    const afterSubtree = await E.getMap(mapId, u1);
    ok(afterSubtree.nodes.length === 4, `deleting a branch takes its subtree (7 -> ${afterSubtree.nodes.length})`);
    ok(!afterSubtree.nodes.some(n => n.label.startsWith('One')), 'no orphaned children survive the branch delete');

    // cross-link edge + node chat, then whole-map cascade
    const remaining = afterSubtree.nodes;
    await query(`INSERT INTO mind_map_edges (edge_id, map_id, from_node, to_node, label)
                 VALUES ($1,$2,$3,$4,$5)`,
      ['mme_test_' + Date.now(), mapId, remaining[1].node_id, remaining[2].node_id, 'see also']);
    await query(`INSERT INTO mind_map_chats (map_id, node_id, session_id) VALUES ($1,$2,$3)`,
      [mapId, remaining[1].node_id, 'sess_test_' + Date.now()]);
    const withEdges = await E.getMap(mapId, u1);
    ok(withEdges.edges.length === 1, 'cross-link edges read back with the map');

    await query('DELETE FROM mind_maps WHERE map_id = $1', [mapId]);
    created.pop();
    const orphanNodes = await query('SELECT COUNT(*)::int AS c FROM mind_map_nodes WHERE map_id = $1', [mapId]);
    const orphanEdges = await query('SELECT COUNT(*)::int AS c FROM mind_map_edges WHERE map_id = $1', [mapId]);
    const orphanChats = await query('SELECT COUNT(*)::int AS c FROM mind_map_chats WHERE map_id = $1', [mapId]);
    ok(orphanNodes.rows[0].c === 0 && orphanEdges.rows[0].c === 0 && orphanChats.rows[0].c === 0,
      'deleting a map cascades to nodes, edges and node chats');
  }

  // ── 4. Live generation ───────────────────────────────────────────
  console.log('\n=== 4. Live generation ===');
  if (SKIP_LLM) {
    console.log('  [SKIP] --no-llm passed');
  } else if (users.rows.length === 0) {
    console.log('  [SKIP] no user to own the map');
  } else {
    const uid = users.rows[0].user_id;
    try {
      const out = await E.generateFromTopic(uid, 'Transformer attention mechanisms', { model: MODEL });
      created.push(out.mapId);
      ok(out.nodeCount >= 8, `generated a real map, not a stub (${out.nodeCount} nodes)`);

      const full = await E.getMap(out.mapId, uid);
      const branches = full.nodes.filter(n => n.parent_id === full.nodes[0].node_id);
      ok(branches.length >= 3 && branches.length <= E.MAX_BRANCHES,
        `branch count within bounds (${branches.length})`);

      const depths = await Promise.all(full.nodes.slice(0, 12).map(n => E.depthOf(n.node_id)));
      ok(Math.max(...depths) <= E.MAX_DEPTH, `depth within bounds (max ${Math.max(...depths)})`);
      ok(full.nodes.every(n => n.label && n.label.length <= 120), 'every generated node has a short label');
      ok(full.nodes.some(n => n.summary), 'at least some nodes carry a summary');
      ok(new Set(full.nodes.map(n => n.label.toLowerCase())).size === full.nodes.length,
        'no duplicate labels survived into the map');

      // expandNode keeps the ancestor context
      const target = branches[0];
      const before = full.nodes.filter(n => n.parent_id === target.node_id).length;
      const grew = await E.expandNode(out.mapId, target.node_id, { model: MODEL });
      const after = await E.getMap(out.mapId, uid);
      const nowKids = after.nodes.filter(n => n.parent_id === target.node_id).length;
      ok(grew.added > 0 && nowKids > before, `expandNode grew "${target.label}" (${before} -> ${nowKids})`);
      ok(!after.nodes.filter(n => n.parent_id === target.node_id)
           .some(n => n.label.toLowerCase() === target.label.toLowerCase()),
        'an expanded branch does not restate its own parent');
    } catch (err) {
      ok(false, `live generation errored: ${err.message}`);
    }
  }

  // cleanup
  for (const id of created) {
    try { await query('DELETE FROM mind_maps WHERE map_id = $1', [id]); } catch (e) { /* leave it */ }
  }

  console.log(`\n──────────────\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
