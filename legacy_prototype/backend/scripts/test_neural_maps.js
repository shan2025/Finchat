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
  let createdMapIds = [];

  console.log('\n=== Map listing includes the built-in System Map ===');
  let list = await api('/maps', {}, t);
  ok(list.ok, `200 OK (got ${list.status})`);
  ok(list.body.maps[0].mapId === 'system' && list.body.maps[0].builtIn === true, 'System Map is first and marked builtIn');
  const baselineCount = list.body.maps.length;

  console.log('\n=== Create a knowledge map (like starting a new chat) ===');
  const km = await api('/maps', { method: 'POST', body: JSON.stringify({ name: 'My Career Web', kind: 'knowledge' }) }, t);
  ok(km.ok && km.body.mapId, `created (${km.body.mapId})`);
  createdMapIds.push(km.body.mapId);
  list = await api('/maps', {}, t);
  ok(list.body.maps.length === baselineCount + 1, 'appears in the list');
  ok(list.body.maps.find(m => m.mapId === km.body.mapId).name === 'My Career Web', 'name persisted');

  console.log('\n=== A new knowledge map starts blank, not full of the system graph ===');
  const g = await api('/?mapId=' + km.body.mapId, {}, t);
  ok(g.ok, `200 OK (got ${g.status})`);
  ok(g.body.nodes.length === 0, `starts with 0 nodes (got ${g.body.nodes.length})`);
  ok(g.body.map.builtIn === false, 'map metadata reports builtIn:false');

  console.log('\n=== Nodes/edges in one knowledge map do not leak into another ===');
  const km2 = await api('/maps', { method: 'POST', body: JSON.stringify({ name: 'Second Map', kind: 'knowledge' }) }, t);
  createdMapIds.push(km2.body.mapId);
  const n1 = await api('/nodes?mapId=' + km.body.mapId, { method: 'POST', body: JSON.stringify({ label: 'Only in map 1', type: 'idea' }) }, t);
  ok(n1.ok, 'node created in map 1');
  const g1 = await api('/?mapId=' + km.body.mapId, {}, t);
  const g2 = await api('/?mapId=' + km2.body.mapId, {}, t);
  const gsys = await api('/', {}, t);
  ok(g1.body.nodes.length === 1, 'map 1 has its node');
  ok(g2.body.nodes.length === 0, 'map 2 does not see map 1\'s node');
  ok(!gsys.body.nodes.some(n => n.label === 'Only in map 1'), 'System Map does not see it either');
  ok(gsys.body.nodes.length > 30, `System Map is unaffected — still has its derived nodes (${gsys.body.nodes.length})`);

  console.log('\n=== Cannot touch a map you do not own ===');
  // A JWT for a user_id that doesn't exist gets 401 at the auth layer (stronger
  // than a 404 — the request never even reaches the route). To test the
  // route's own ownership check, impersonate a real second user instead.
  const OTHER = jwt.sign({ userId: 'test_memory_user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const steal = await api('/nodes?mapId=' + km.body.mapId, { method: 'POST', body: JSON.stringify({ label: 'intruder' }) }, OTHER);
  ok(steal.status === 404, `a different real user gets 404 on your map (got ${steal.status})`);
  const stealGet = await api('/?mapId=' + km.body.mapId, {}, OTHER);
  ok(stealGet.status === 404, `and cannot read it either (got ${stealGet.status})`);
  const g1check = await api('/?mapId=' + km.body.mapId, {}, t);
  ok(g1check.body.nodes.length === 1, 'the impersonation attempt left map 1 untouched');

  console.log('\n=== System Map cannot be renamed or deleted ===');
  const renameSys = await api('/maps/system', { method: 'PATCH', body: JSON.stringify({ name: 'Hacked' }) }, t);
  ok(renameSys.status === 400, `rename rejected (got ${renameSys.status})`);
  const delSys = await api('/maps/system', { method: 'DELETE' }, t);
  ok(delSys.status === 400, `delete rejected (got ${delSys.status})`);

  console.log('\n=== Rename and delete a real map ===');
  const ren = await api('/maps/' + km2.body.mapId, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed Map' }) }, t);
  ok(ren.ok && ren.body.name === 'Renamed Map', 'renamed');
  const del = await api('/maps/' + km2.body.mapId, { method: 'DELETE' }, t);
  ok(del.ok && del.body.deleted === km2.body.mapId, 'deleted');
  const afterDel = await api('/?mapId=' + km2.body.mapId, {}, t);
  ok(afterDel.status === 404, 'deleted map is gone (404 on access)');
  createdMapIds = createdMapIds.filter(id => id !== km2.body.mapId);

  console.log('\n=== Neural network map: create, config, evaluate ===');
  const nm = await api('/maps', { method: 'POST', body: JSON.stringify({
    name: 'Sine Regressor', kind: 'network', config: { hidden: 1, width: 8, lr: 0.3, target: 'sine', seed: 42 }
  }) }, t);
  ok(nm.ok && nm.body.kind === 'network', `network map created (${nm.body.mapId})`);
  createdMapIds.push(nm.body.mapId);

  const net1 = await api('/maps/' + nm.body.mapId + '/network', {}, t);
  ok(net1.ok, `GET network config (${net1.status})`);
  ok(JSON.stringify(net1.body.layers) === '[1,8,1]', `layers reflect config (got ${JSON.stringify(net1.body.layers)})`);
  ok(net1.body.weights === null, 'no weights yet — untrained');

  console.log('\n=== A knowledge-map endpoint refuses a network map, and vice versa ===');
  const wrongWay = await api('/?mapId=' + nm.body.mapId, {}, t);
  ok(wrongWay.status === 400, `GET / on a network map is rejected (got ${wrongWay.status})`);
  const wrongWay2 = await api('/nodes?mapId=' + nm.body.mapId, { method: 'POST', body: JSON.stringify({ label: 'x' }) }, t);
  ok(wrongWay2.status === 400, `POST /nodes on a network map is rejected (got ${wrongWay2.status})`);
  const wrongWay3 = await api('/maps/' + km.body.mapId + '/network', {}, t);
  ok(wrongWay3.status === 400, `GET network on a knowledge map is rejected (got ${wrongWay3.status})`);

  console.log('\n=== Train server-side and get real evaluation metrics ===');
  const ev = await api('/maps/' + nm.body.mapId + '/evaluate', { method: 'POST', body: JSON.stringify({ epochs: 3000 }) }, t);
  ok(ev.ok, `evaluate 200 (got ${ev.status})`);
  const m = ev.body.metrics;
  console.log(`     epoch=${m.epoch} trainMSE=${m.train.mse.toFixed(4)} testMSE=${m.test.mse.toFixed(4)} R2=${m.train.r2.toFixed(4)} verdict="${m.verdict}"`);
  ok(m.epoch === 3000, 'epoch count is real');
  ok(m.train.mse < 0.1, `train error dropped meaningfully (${m.train.mse.toFixed(4)})`);
  ok(typeof m.test.mse === 'number' && m.test.n === 40, 'test metrics computed on held-out data');
  ok(['Good fit — balanced', 'Underfitting — high bias', 'Overfitting — high variance'].includes(m.verdict), `verdict is one of the real categories (got ${JSON.stringify(m.verdict)})`);
  ok(m.paramCount === (1 * 8 + 8) + (8 * 1 + 1), `param count matches architecture (${m.paramCount})`);

  console.log('\n=== Trained weights persist across reload ===');
  const net2 = await api('/maps/' + nm.body.mapId + '/network', {}, t);
  ok(net2.body.weights && Array.isArray(net2.body.weights.W), 'weights are now saved');
  ok(net2.body.metrics.epoch === 3000, 'saved metrics match what evaluate returned');

  const ev2 = await api('/maps/' + nm.body.mapId + '/evaluate', { method: 'POST', body: JSON.stringify({ epochs: 500 }) }, t);
  ok(ev2.body.metrics.epoch === 3500, `continues training from where it left off (3000+500=${ev2.body.metrics.epoch})`);

  console.log('\n=== Evaluate guards ===');
  const tooMany = await api('/maps/' + nm.body.mapId + '/evaluate', { method: 'POST', body: JSON.stringify({ epochs: 999999 }) }, t);
  ok(tooMany.ok && tooMany.body.metrics.epoch <= 3500 + 20000, 'epoch count is clamped, does not run unbounded');
  const zeroEpochs = await api('/maps/' + nm.body.mapId + '/evaluate', { method: 'POST', body: JSON.stringify({}) }, t);
  ok(zeroEpochs.ok, 'evaluate with no epochs still returns metrics (pure evaluation, no training)');

  console.log('\n=== Changing architecture via PUT resets weights appropriately ===');
  const put = await api('/maps/' + nm.body.mapId + '/network', { method: 'PUT', body: JSON.stringify({ config: { width: 4 } }) }, t);
  ok(put.ok, 'PUT network config');
  const ev3 = await api('/maps/' + nm.body.mapId + '/evaluate', { method: 'POST', body: JSON.stringify({ epochs: 100 }) }, t);
  ok(JSON.stringify(ev3.body.metrics.layers) === '[1,4,1]', `re-evaluates with new width (${JSON.stringify(ev3.body.metrics.layers)})`);

  console.log('\n=== Guards ===');
  const noAuth = await fetch('http://localhost:3000/api/neural-map/maps');
  ok(noAuth.status === 401, `unauthenticated maps list rejected (got ${noAuth.status})`);
  const badKind = await api('/maps', { method: 'POST', body: JSON.stringify({ name: 'x', kind: 'nonsense' }) }, t);
  ok(badKind.ok && badKind.body.kind === 'knowledge', 'unknown kind falls back to knowledge, does not error');
  createdMapIds.push(badKind.body.mapId);

  // ── cleanup ──
  console.log('\n=== Cleanup ===');
  for (const id of createdMapIds) {
    const r = await api('/maps/' + id, { method: 'DELETE' }, t);
    ok(r.ok, `deleted ${id}`);
  }
  const finalList = await api('/maps', {}, t);
  ok(finalList.body.maps.length === baselineCount, 'map list back to baseline');

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await getPool().end();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERR:', e); process.exit(1); });
