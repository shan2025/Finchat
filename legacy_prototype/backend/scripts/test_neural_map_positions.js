const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const jwt = require(B + '/node_modules/jsonwebtoken');
const { query, getPool } = require(B + '/database');

const UID = '66092ed7-e536-4ed9-ad17-633a5072a65e';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

const api = async (path, opts = {}, token) => {
  const res = await fetch('http://localhost:3000/api/neural-map' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = {}; }
  return { status: res.status, ok: res.ok, body };
};

(async () => {
  const t = jwt.sign({ userId: UID }, process.env.JWT_SECRET, { expiresIn: '1h' });

  console.log('\n=== Bulk position pin/unpin (select-all + move) ===');
  const batch = [
    { key: 'agent:plato', x: 10, y: 20 },
    { key: 'agent:nova', x: -30, y: 40 },
    { key: 'tool:search', x: 55, y: -65 }
  ];
  const r = await api('/positions', { method: 'POST', body: JSON.stringify({ positions: batch }) }, t);
  ok(r.ok && r.body.pinned === 3, `pinned 3 in one round-trip (got ${JSON.stringify(r.body)})`);

  let g = await api('', {}, t);
  const find = k => (g.body.nodes || []).find(n => n.key === k);
  ok(find('agent:plato').x === 10 && find('agent:plato').y === 20, 'plato position persisted');
  ok(find('agent:nova').x === -30 && find('agent:nova').y === 40, 'nova position persisted');
  ok(find('tool:search').x === 55 && find('tool:search').y === -65, 'search tool position persisted');

  console.log('\n=== Re-pin overwrites ===');
  await api('/positions', { method: 'POST', body: JSON.stringify({ positions: [{ key: 'agent:plato', x: 999, y: 888 }] }) }, t);
  g = await api('', {}, t);
  ok(find('agent:plato').x === 999, 'moving a pinned node again overwrites its position');

  console.log('\n=== Unpin (let them float) ===');
  const u = await api('/positions', { method: 'POST', body: JSON.stringify({ unpin: ['agent:plato', 'agent:nova'] }) }, t);
  ok(u.ok && u.body.unpinned === 2, `unpinned 2 (got ${JSON.stringify(u.body)})`);
  g = await api('', {}, t);
  ok(find('agent:plato').x === undefined, 'unpinned node no longer carries a position (rejoins layout)');
  ok(find('agent:nova').x === undefined, 'second unpinned node released too');
  ok(find('tool:search').x === 55, 'untouched node stays pinned');

  console.log('\n=== A note survives unpinning ===');
  await api('/nodes/tool%3Asearch', { method: 'PUT', body: JSON.stringify({ note: 'keepme' }) }, t);
  await api('/positions', { method: 'POST', body: JSON.stringify({ unpin: ['tool:search'] }) }, t);
  g = await api('', {}, t);
  ok(find('tool:search').note === 'keepme', 'unpinning clears position but keeps the note');

  console.log('\n=== Whole-graph batch (the select-all + drag case) ===');
  g = await api('', {}, t);
  const all = g.body.nodes.map((n, i) => ({ key: n.key, x: (i % 9) * 40 - 160, y: Math.floor(i / 9) * 40 - 160 }));
  const t0 = Date.now();
  const big = await api('/positions', { method: 'POST', body: JSON.stringify({ positions: all }) }, t);
  const ms = Date.now() - t0;
  ok(big.ok && big.body.pinned === all.length,
     `all ${all.length} nodes pinned in one request (got ${big.body.pinned}) in ${ms}ms`);
  // Not asserting on absolute ms here — Supabase round-trip latency varies with
  // cloud conditions and isn't something this suite controls. The route itself
  // is a single INSERT ... unnest statement (see routes/neuralMap.js), so
  // "one round trip, not N" is a structural property, not a timing one; the
  // persistence check below is what actually proves nothing was dropped.
  console.log(`     (${all.length} nodes in one request took ${ms}ms — informational, not asserted)`);
  g = await api('', {}, t);
  const persisted = g.body.nodes.filter(n => Number.isFinite(n.x)).length;
  ok(persisted === all.length, `every position survived a reload (${persisted}/${all.length})`);

  console.log('\n=== Duplicate keys in one batch ===');
  const dupes = await api('/positions', { method: 'POST', body: JSON.stringify({
    positions: [{ key: 'agent:plato', x: 1, y: 1 }, { key: 'agent:plato', x: 77, y: 88 }]
  }) }, t);
  ok(dupes.ok, `repeated key does not abort the batch (status ${dupes.status})`);
  g = await api('', {}, t);
  ok(find('agent:plato').x === 77 && find('agent:plato').y === 88, 'last value wins on a duplicate key');

  const unpinAll = await api('/positions', { method: 'POST', body: JSON.stringify({ unpin: all.map(a => a.key) }) }, t);
  ok(unpinAll.ok && unpinAll.body.unpinned === all.length, `"let them float" releases all ${all.length}`);
  g = await api('', {}, t);
  ok(g.body.nodes.every(n => n.x === undefined), 'nothing left pinned after release-all');

  console.log('\n=== Guards ===');
  const bad = await api('/positions', { method: 'POST', body: JSON.stringify({ positions: [{ key: 'agent:plato', x: 'NaN', y: null }] }) }, t);
  ok(bad.ok && bad.body.pinned === 0 && bad.body.skipped === 1
     && (await api('', {}, t)).body.nodes.find(n => n.key === 'agent:plato').x === undefined,
     `non-numeric coords are skipped, not written, and reported honestly (${JSON.stringify(bad.body)})`);
  const huge = await api('/positions', { method: 'POST', body: JSON.stringify({ positions: new Array(501).fill({ key: 'x', x: 1, y: 1 }) }) }, t);
  ok(huge.status === 400, `oversized batch rejected (got ${huge.status})`);
  const noAuth = await fetch('http://localhost:3000/api/neural-map/positions', { method: 'POST' });
  ok(noAuth.status === 401, `unauthenticated bulk write rejected (got ${noAuth.status})`);

  for (const tbl of ['neural_map_node_meta', 'neural_map_edge_meta', 'neural_map_edges', 'neural_map_nodes']) {
    await query(`DELETE FROM ${tbl} WHERE user_id = $1`, [UID]);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await getPool().end();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERR:', e); process.exit(1); });

