// Sprint 6 — UI-state persistence: node colours, edge line styles, and the
// server-computed legend counts (stats.typeCounts) that keep the legend honest.
//
// Requires the server running on :3000 (same harness pattern as
// test_neural_maps.js). Asserts persisted state and structure, never latency.

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
  const OTHER = jwt.sign({ userId: 'test_memory_user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const createdMapIds = [];

  // ── fixtures: two fresh knowledge maps ──────────────────────
  const mk = async (name) => {
    const r = await api('/maps', { method: 'POST', body: JSON.stringify({ name, kind: 'knowledge' }) }, t);
    createdMapIds.push(r.body.mapId);
    return r.body.mapId;
  };
  const mapA = await mk('Sprint6 A');
  const mapB = await mk('Sprint6 B');

  console.log('\n=== 1. Node colour CRUD ===');
  const cn = await api('/nodes?mapId=' + mapA, { method: 'POST', body: JSON.stringify({ label: 'Coloured idea', type: 'idea' }) }, t);
  ok(cn.ok && cn.body.key, `custom node created (${cn.body.key})`);
  const ckey = cn.body.key;

  const setCol = await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: '#7c3aed' }) }, t);
  ok(setCol.ok, 'PUT color accepted');

  let g = await api('/?mapId=' + mapA, {}, t);
  let node = g.body.nodes.find(n => n.key === ckey);
  ok(node && node.color === '#7c3aed', `color survives reload (got ${node && node.color})`);

  const badCol = await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: 'purple' }) }, t);
  ok(badCol.status === 400, `non-hex color rejected (got ${badCol.status})`);
  const badCol2 = await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: '#12345' }) }, t);
  ok(badCol2.status === 400, `short hex rejected (got ${badCol2.status})`);

  // color update must not clobber the other annotation fields
  await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ note: 'keep me' }) }, t);
  await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: '#0ea5e9' }) }, t);
  g = await api('/?mapId=' + mapA, {}, t);
  node = g.body.nodes.find(n => n.key === ckey);
  ok(node && node.color === '#0ea5e9', 'color can be changed');
  ok(node && node.note === 'keep me', 'changing color leaves the note untouched');

  const clearCol = await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: '' }) }, t);
  ok(clearCol.ok, 'empty string resets the color');
  g = await api('/?mapId=' + mapA, {}, t);
  node = g.body.nodes.find(n => n.key === ckey);
  ok(node && node.color === undefined, 'reset node falls back to the type palette (no color field)');
  ok(node && node.note === 'keep me', 'reset leaves the note untouched');

  console.log('\n=== 2. Colour works on DERIVED nodes too (system map) ===');
  const setDerived = await api('/nodes/agent%3Aaurelius', { method: 'PUT', body: JSON.stringify({ color: '#ec4899' }) }, t);
  ok(setDerived.ok, 'PUT color on a derived node accepted');
  const gsys = await api('/', {}, t);
  const au = gsys.body.nodes.find(n => n.key === 'agent:aurelius');
  ok(au && au.color === '#ec4899', 'derived node color survives reload');
  await api('/nodes/agent%3Aaurelius', { method: 'PUT', body: JSON.stringify({ color: '' }) }, t);

  console.log('\n=== 3. Cross-map + cross-user isolation ===');
  // Same derived-node color set in map A must not appear in map B or system.
  await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: '#64748b' }) }, t);
  const gB = await api('/?mapId=' + mapB, {}, t);
  ok(!gB.body.nodes.some(n => n.color === '#64748b'), 'map B does not see map A\'s color');
  const stealPut = await api('/nodes/' + encodeURIComponent(ckey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ color: '#000000' }) }, OTHER);
  ok(stealPut.status === 404, `another user cannot color your map's node (got ${stealPut.status})`);
  g = await api('/?mapId=' + mapA, {}, t);
  node = g.body.nodes.find(n => n.key === ckey);
  ok(node && node.color === '#64748b', 'the intrusion attempt changed nothing');

  console.log('\n=== 4. Edge line style ===');
  const cn2 = await api('/nodes?mapId=' + mapA, { method: 'POST', body: JSON.stringify({ label: 'Other end', type: 'doc' }) }, t);
  const ce = await api('/edges?mapId=' + mapA, { method: 'POST', body: JSON.stringify({ from: ckey, to: cn2.body.key }) }, t);
  ok(ce.ok && ce.body.key, 'custom edge created');
  const ekey = ce.body.key;

  g = await api('/?mapId=' + mapA, {}, t);
  let edge = g.body.edges.find(e => e.key === ekey);
  ok(edge && edge.style === undefined, 'new edge has no style → renders solid by default');

  const setDash = await api('/edges/' + encodeURIComponent(ekey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ style: 'dashed' }) }, t);
  ok(setDash.ok, 'PUT style:dashed accepted');
  g = await api('/?mapId=' + mapA, {}, t);
  edge = g.body.edges.find(e => e.key === ekey);
  ok(edge && edge.style === 'dashed', 'dashed style survives reload');

  const badStyle = await api('/edges/' + encodeURIComponent(ekey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ style: 'wavy' }) }, t);
  ok(badStyle.status === 400, `unknown style rejected (got ${badStyle.status})`);

  await api('/edges/' + encodeURIComponent(ekey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ note: 'style note' }) }, t);
  g = await api('/?mapId=' + mapA, {}, t);
  edge = g.body.edges.find(e => e.key === ekey);
  ok(edge && edge.style === 'dashed', 'annotating the edge does not clobber its style');
  ok(edge && edge.note === 'style note', 'and the note landed');

  const resetStyle = await api('/edges/' + encodeURIComponent(ekey) + '?mapId=' + mapA,
    { method: 'PUT', body: JSON.stringify({ style: '' }) }, t);
  ok(resetStyle.ok, 'empty string resets the style');
  g = await api('/?mapId=' + mapA, {}, t);
  edge = g.body.edges.find(e => e.key === ekey);
  ok(edge && edge.style === undefined, 'reset edge is solid again (no style field)');

  console.log('\n=== 5. Legend counts: stats.typeCounts is computed server-side ===');
  // Map A currently holds: 1 idea + 1 doc.
  g = await api('/?mapId=' + mapA, {}, t);
  ok(g.body.stats && typeof g.body.stats.typeCounts === 'object', 'stats.typeCounts present');
  ok(g.body.stats.typeCounts.idea === 1 && g.body.stats.typeCounts.doc === 1,
     `counts match seeded content (got ${JSON.stringify(g.body.stats.typeCounts)})`);
  ok(!('agent' in g.body.stats.typeCounts), 'absent types are absent, not zero-padded');
  ok(g.body.stats.nodes === g.body.nodes.length, 'stats.nodes equals the returned node count');
  ok(g.body.stats.edges === g.body.edges.length, 'stats.edges equals the returned edge count');

  const sumSys = Object.values(gsys.body.stats.typeCounts || {}).reduce((a, b) => a + b, 0);
  ok(sumSys === gsys.body.nodes.length,
     `system map typeCounts sum to its node count (${sumSys}/${gsys.body.nodes.length})`);

  // Hiding a node must be reflected in the counts (legend can't drift).
  await api('/nodes/' + encodeURIComponent(cn2.body.key) + '?mapId=' + mapA, { method: 'DELETE' }, t);
  g = await api('/?mapId=' + mapA, {}, t);
  ok(!('doc' in (g.body.stats.typeCounts || {})), 'deleting the only doc removes doc from typeCounts');

  // ── cleanup ─────────────────────────────────────────────────
  console.log('\n=== Cleanup ===');
  for (const id of createdMapIds) {
    const d = await api('/maps/' + encodeURIComponent(id), { method: 'DELETE' }, t);
    ok(d.ok, `deleted ${id}`);
  }
  await query(`DELETE FROM neural_map_node_meta WHERE user_id = $1 AND map_id = 'system' AND node_key = 'agent:aurelius' AND color IS NOT NULL`, [UID]);

  console.log(`\n══════════════════════════════════\n  ${pass} passed, ${fail} failed\n══════════════════════════════════`);
  await getPool().end();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERR:', e); process.exit(1); });
