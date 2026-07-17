const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const jwt = require(B + '/node_modules/jsonwebtoken');
const { query, getPool } = require(B + '/database');

const UID = '66092ed7-e536-4ed9-ad17-633a5072a65e';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

const api = async (path, opts = {}, token) => {
  const res = await fetch('http://localhost:3000/api/neural-map' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = { _parseError: true }; }
  return { status: res.status, ok: res.ok, body };
};

(async () => {
  const t = jwt.sign({ userId: UID }, process.env.JWT_SECRET, { expiresIn: '1h' });

  console.log('\n=== 1. GET /api/neural-map — derived graph ===');
  const g = await api('', {}, t);
  ok(g.ok, `200 OK (got ${g.status})`);
  const nodes = g.body.nodes || [], edges = g.body.edges || [];
  console.log(`     ${nodes.length} nodes, ${edges.length} edges, stats=${JSON.stringify(g.body.stats)}`);
  ok(nodes.length > 0, 'returns nodes');
  ok(edges.length > 0, 'returns edges');

  const types = {};
  nodes.forEach(n => types[n.type] = (types[n.type] || 0) + 1);
  console.log('     node types:', JSON.stringify(types));

  ok(nodes.some(n => n.key === 'agent:aurelius'), 'aurelius present (from agent_configs)');
  ok(nodes.some(n => n.key === 'agent:plato'), 'plato present');
  ok(nodes.some(n => n.key === 'user:me'), 'your own node present');
  ok(nodes.some(n => n.key === 'sys:proofchain'), 'proof chain node present');
  ok(nodes.some(n => n.key === 'sys:solana'), 'solana node present');

  // Real wiring, not the design's mock data
  const commodities = nodes.find(n => n.key === 'tool:commodities');
  ok(!!commodities, 'commodities tool node present (real Sprint-5 wiring)');
  const jobs = nodes.find(n => n.key === 'tool:jobs');
  ok(!!jobs, 'jobs tool node present');
  ok(edges.some(e => e.from === 'agent:aurelius' && e.to === 'tool:commodities'),
     'aurelius→commodities edge derived from real tool manifest');
  ok(edges.some(e => e.from === 'agent:rasha' && e.to === 'tool:jobs'),
     'rasha→jobs edge derived from real tool manifest');
  ok(!edges.some(e => e.from === 'agent:rasha' && e.to === 'tool:commodities'),
     'rasha NOT wired to commodities (manifest respected, not invented)');

  const ents = nodes.filter(n => n.type === 'entity');
  ok(ents.length > 0, `knowledge-graph entities present (${ents.length})`);
  console.log('     sample entities:', ents.slice(0, 5).map(e => e.label).join(', '));

  const chainNode = nodes.find(n => n.key === 'sys:proofchain');
  const height = chainNode.meta.find(m => m[0] === 'Height');
  ok(height && parseInt(height[1]) > 0, `chain height is live (${height && height[1]})`);

  // every edge must point at a node that exists
  const keys = new Set(nodes.map(n => n.key));
  ok(edges.every(e => keys.has(e.from) && keys.has(e.to)), 'no dangling edges');

  console.log('\n=== 2. Annotations persist ===');
  const note = 'test-note-' + Date.now();
  const put = await api('/nodes/agent%3Aaurelius', { method: 'PUT', body: JSON.stringify({ note, x: 123, y: -45 }) }, t);
  ok(put.ok, 'PUT note+position on a derived node');
  const g2 = await api('', {}, t);
  const au = (g2.body.nodes || []).find(n => n.key === 'agent:aurelius');
  ok(au && au.note === note, 'note survives a reload');
  ok(au && au.x === 123 && au.y === -45, 'pinned position survives a reload');

  console.log('\n=== 3. Custom node + edge ===');
  const cn = await api('/nodes', { method: 'POST', body: JSON.stringify({ label: 'My thesis', type: 'idea' }) }, t);
  ok(cn.ok && cn.body.key, `POST custom node (${cn.body.key})`);
  const ckey = cn.body.key;

  const ce = await api('/edges', { method: 'POST', body: JSON.stringify({ from: ckey, to: 'agent:aurelius' }) }, t);
  ok(ce.ok && ce.body.key, 'POST custom edge');
  const ekey = ce.body.key;

  const dup = await api('/edges', { method: 'POST', body: JSON.stringify({ from: ckey, to: 'agent:aurelius' }) }, t);
  ok(dup.status === 409, `duplicate edge rejected (got ${dup.status})`);

  const self = await api('/edges', { method: 'POST', body: JSON.stringify({ from: ckey, to: ckey }) }, t);
  ok(self.status === 400, `self-edge rejected (got ${self.status})`);

  await api('/edges/' + encodeURIComponent(ekey), { method: 'PUT', body: JSON.stringify({ note: 'why', flow: 'idea → agent' }) }, t);
  const g3 = await api('', {}, t);
  const mine = (g3.body.nodes || []).find(n => n.key === ckey);
  ok(mine && mine.label === 'My thesis', 'custom node survives reload');
  ok(mine && mine.derived === false, 'custom node flagged as yours (derived:false)');
  const myEdge = (g3.body.edges || []).find(e => e.key === ekey);
  ok(myEdge && myEdge.note === 'why' && myEdge.flow === 'idea → agent', 'edge annotation survives reload');

  console.log('\n=== 4. Derived items cannot be faked away ===');
  const delDerivedEdge = await api('/edges/' + encodeURIComponent(edges[0].key), { method: 'DELETE' }, t);
  ok(delDerivedEdge.status === 400, `derived edge refuses deletion (got ${delDerivedEdge.status})`);

  const hide = await api('/nodes/sys%3Aledger', { method: 'DELETE' }, t);
  ok(hide.ok && hide.body.mode === 'hidden', 'derived node hides rather than deletes');
  const g4 = await api('', {}, t);
  ok(!(g4.body.nodes || []).some(n => n.key === 'sys:ledger'), 'hidden node gone from the map');
  ok(!(g4.body.edges || []).some(e => e.from === 'sys:ledger' || e.to === 'sys:ledger'),
     'edges to a hidden node are pruned too');

  console.log('\n=== 5. Auth ===');
  const noAuth = await fetch('http://localhost:3000/api/neural-map');
  ok(noAuth.status === 401, `unauthenticated request rejected (got ${noAuth.status})`);

  // ── cleanup ──
  const delNode = await api('/nodes/' + encodeURIComponent(ckey), { method: 'DELETE' }, t);
  ok(delNode.ok && delNode.body.mode === 'deleted', 'custom node deletes for real');
  await query(`DELETE FROM neural_map_node_meta WHERE user_id = $1`, [UID]);
  await query(`DELETE FROM neural_map_edge_meta WHERE user_id = $1`, [UID]);
  const leftover = await query(`SELECT COUNT(*)::int c FROM neural_map_edges WHERE user_id = $1`, [UID]);
  ok(leftover.rows[0].c === 0, 'deleting a node cascades to its edges');

  console.log(`\n══════════════════════════════════\n  ${pass} passed, ${fail} failed\n══════════════════════════════════`);
  await getPool().end();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERR:', e); process.exit(1); });
