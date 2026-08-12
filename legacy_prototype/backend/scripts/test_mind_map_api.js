// Sprint Z · Track A — /api/mind-maps over HTTP.
// Exercises the real Express stack: auth, ownership guards, validation, cycle
// rejection, cascade, bulk layout, export. Generation is skipped by default so
// the suite stays fast and quota-free; pass --llm to include it.
//
// Requires the server running on PORT (default 3000):  npm start
// Run: node scripts/test_mind_map_api.js [--llm] [--port=3000]

const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const axios = require(B + '/node_modules/axios');
const jwt = require(B + '/node_modules/jsonwebtoken');
const { query } = require(B + '/database');

const PORT = (process.argv.find(a => a.startsWith('--port=')) || '').replace('--port=', '') || process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}/api/mind-maps`;
const WITH_LLM = process.argv.includes('--llm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

const H = t => ({ headers: { Authorization: `Bearer ${t}` }, validateStatus: () => true });

(async () => {
  const users = await query('SELECT user_id FROM users ORDER BY created_at LIMIT 2');
  if (users.rows.length < 2) { console.log('Need two users. Aborting.'); process.exit(1); }
  const [u1, u2] = users.rows.map(r => r.user_id);

  const secret = process.env.JWT_SECRET;
  if (!secret) { console.log('JWT_SECRET missing from .env. Aborting.'); process.exit(1); }
  const tok = id => jwt.sign({ id, userId: id }, secret, { expiresIn: '1h' });
  const t1 = tok(u1), t2 = tok(u2);

  // Reachability + auth
  console.log('\n=== 1. Auth ===');
  const anon = await axios.get(BASE, { validateStatus: () => true });
  ok(anon.status === 401 || anon.status === 403, `unauthenticated list is rejected (${anon.status})`);
  const listed = await axios.get(BASE, H(t1));
  if (listed.status !== 200) { console.log(`  server not reachable or auth shape differs (${listed.status}). Is it running on ${PORT}?`); process.exit(1); }
  ok(Array.isArray(listed.data.maps), 'GET / returns a maps array');

  // Seed a map directly so route tests do not depend on the LLM.
  console.log('\n=== 2. Structure ===');
  const Engine = require(B + '/services/cognitive/MindMapEngine');
  const mapId = await Engine.createMap({ userId: u1, title: 'API Test', topic: 'testing', sourceType: 'topic' });
  const tree = Engine.normalizeTree({
    root: { label: 'Root', summary: 'r' },
    branches: [{ label: 'Alpha', children: [{ label: 'Alpha-1' }] }, { label: 'Beta' }, { label: 'Gamma' }]
  }, 'Root');
  const rows = Engine.flatten(tree, mapId);
  await Engine.insertNodes(rows);
  const rootId = rows[0].node_id;
  const alphaId = rows.find(r => r.label === 'Alpha').node_id;
  const alpha1Id = rows.find(r => r.label === 'Alpha-1').node_id;
  const betaId = rows.find(r => r.label === 'Beta').node_id;

  const got = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(got.status === 200 && got.data.nodes.length === 5, `GET /:mapId returns the tree (${got.data?.nodes?.length} nodes)`);

  // Ownership
  console.log('\n=== 3. Ownership ===');
  const foreign = await axios.get(`${BASE}/${mapId}`, H(t2));
  ok(foreign.status === 404, `another user gets 404, not 401 — the id is not confirmed (${foreign.status})`);
  const foreignPatch = await axios.patch(`${BASE}/${mapId}`, { title: 'hijacked' }, H(t2));
  ok(foreignPatch.status === 404, `another user cannot rename the map (${foreignPatch.status})`);
  const foreignDelete = await axios.delete(`${BASE}/${mapId}/nodes/${alphaId}`, H(t2));
  ok(foreignDelete.status === 404, `another user cannot delete a node (${foreignDelete.status})`);
  const stillThere = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(stillThere.data.nodes.length === 5, 'the map is untouched after the foreign attempts');

  // Validation
  console.log('\n=== 4. Validation ===');
  const noLabel = await axios.post(`${BASE}/${mapId}/nodes`, { parentId: rootId }, H(t1));
  ok(noLabel.status === 400, `a node with no label is rejected (${noLabel.status})`);
  const badColor = await axios.post(`${BASE}/${mapId}/nodes`, { label: 'X', color: 'red' }, H(t1));
  ok(badColor.status === 400, `a non-hex color is rejected (${badColor.status})`);
  const badType = await axios.post(`${BASE}/${mapId}/nodes`, { label: 'X', nodeType: 'hologram' }, H(t1));
  ok(badType.status === 400, `an unknown nodeType is rejected (${badType.status})`);

  // A parent in someone else's map must not graft trees together.
  const otherMap = await Engine.createMap({ userId: u2, title: 'Theirs', topic: 't', sourceType: 'topic' });
  const otherRows = Engine.flatten(Engine.normalizeTree({ root: { label: 'TheirRoot' }, branches: [{ label: 'X' }] }, 'TheirRoot'), otherMap);
  await Engine.insertNodes(otherRows);
  const graft = await axios.post(`${BASE}/${mapId}/nodes`, { label: 'Grafted', parentId: otherRows[0].node_id }, H(t1));
  ok(graft.status === 400, `a parentId from another map is rejected (${graft.status})`);

  const badLayout = await axios.patch(`${BASE}/${mapId}`, { layout: 'spiral' }, H(t1));
  ok(badLayout.status === 400, `an unknown layout is rejected (${badLayout.status})`);
  const badSource = await axios.post(`${BASE}/generate`, { sourceType: 'telepathy' }, H(t1));
  ok(badSource.status === 400, `an unknown sourceType is rejected (${badSource.status})`);
  const noDocs = await axios.post(`${BASE}/generate`, { sourceType: 'document' }, H(t1));
  ok(noDocs.status === 400, `generating from documents without any is rejected (${noDocs.status})`);
  const notYet = await axios.post(`${BASE}/generate`, { sourceType: 'graph' }, H(t1));
  ok(notYet.status === 501, `an unimplemented sourceType says 501, not a wrong map (${notYet.status})`);

  // Cycles
  console.log('\n=== 5. Cycle safety ===');
  const selfParent = await axios.patch(`${BASE}/${mapId}/nodes/${alphaId}`, { parentId: alphaId }, H(t1));
  ok(selfParent.status === 400, `a node cannot become its own parent (${selfParent.status})`);
  const cycle = await axios.patch(`${BASE}/${mapId}/nodes/${alphaId}`, { parentId: alpha1Id }, H(t1));
  ok(cycle.status === 400, `a node cannot move under its own descendant (${cycle.status})`);
  const legalMove = await axios.patch(`${BASE}/${mapId}/nodes/${alpha1Id}`, { parentId: betaId }, H(t1));
  ok(legalMove.status === 200, `a legal reparent is allowed (${legalMove.status})`);
  const moved = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(moved.data.nodes.find(n => n.node_id === alpha1Id).parent_id === betaId, 'the reparent actually took effect');
  ok(moved.data.nodes.length === 5, 'the reparent did not lose or duplicate nodes');

  // Edges
  console.log('\n=== 6. Cross-links ===');
  const selfEdge = await axios.post(`${BASE}/${mapId}/edges`, { fromNode: alphaId, toNode: alphaId }, H(t1));
  ok(selfEdge.status === 400, `a self-referencing cross-link is rejected (${selfEdge.status})`);
  const crossMapEdge = await axios.post(`${BASE}/${mapId}/edges`, { fromNode: alphaId, toNode: otherRows[0].node_id }, H(t1));
  ok(crossMapEdge.status === 400, `a cross-link into another map is rejected (${crossMapEdge.status})`);
  const edge = await axios.post(`${BASE}/${mapId}/edges`, { fromNode: alphaId, toNode: betaId, label: 'see also' }, H(t1));
  ok(edge.status === 201, `a valid cross-link is created (${edge.status})`);
  const withEdge = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(withEdge.data.edges.length === 1, 'the cross-link reads back with the map');
  const dupEdge = await axios.post(`${BASE}/${mapId}/edges`, { fromNode: alphaId, toNode: betaId, label: 'updated' }, H(t1));
  const afterDup = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(dupEdge.status === 201 && afterDup.data.edges.length === 1, 'a repeat cross-link updates rather than duplicating');

  // Layout
  console.log('\n=== 7. Bulk layout ===');
  const layout = await axios.post(`${BASE}/${mapId}/layout`, {
    positions: [
      { nodeId: alphaId, x: 12.5, y: -30 },
      { nodeId: betaId, x: 40, y: 8 },
      { nodeId: alphaId, x: 99, y: 99 },       // duplicate — last wins
      { nodeId: betaId, x: 'NaN', y: 1 },      // invalid — skipped
      { nodeId: 'mmn_does_not_exist', x: 1, y: 1 }
    ]
  }, H(t1));
  ok(layout.status === 200 && layout.data.saved === 3, `dedupes and validates positions (saved ${layout.data.saved}, skipped ${layout.data.skipped})`);
  const positioned = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(positioned.data.nodes.find(n => n.node_id === alphaId).x === 99, 'the last duplicate position wins');
  ok(positioned.data.nodes.find(n => n.node_id === betaId).x === 40, 'an unrelated node keeps its saved position');

  // Export
  console.log('\n=== 8. Export ===');
  const md = await axios.get(`${BASE}/${mapId}/export?format=markdown`, H(t1));
  ok(md.status === 200 && md.data.includes('# API Test'), 'markdown export carries the title');
  ok(md.data.includes('**Alpha**') && md.data.includes('**Beta**'), 'markdown export lists the branches');
  const opml = await axios.get(`${BASE}/${mapId}/export?format=opml`, H(t1));
  ok(opml.status === 200 && opml.data.includes('<opml version="2.0">'), 'opml export is well-formed at the root');
  ok(opml.data.includes('text="Alpha"'), 'opml export carries node labels');
  const png = await axios.get(`${BASE}/${mapId}/export?format=png`, H(t1));
  ok(png.status === 501, `png export declines server-side and says why (${png.status})`);
  const foreignExport = await axios.get(`${BASE}/${mapId}/export?format=markdown`, H(t2));
  ok(foreignExport.status === 404, `another user cannot export the map (${foreignExport.status})`);

  // XML injection through a label must not break the OPML document.
  await axios.post(`${BASE}/${mapId}/nodes`, { label: '</outline><evil a="', parentId: rootId }, H(t1));
  const opml2 = await axios.get(`${BASE}/${mapId}/export?format=opml`, H(t1));
  ok(!opml2.data.includes('<evil'), 'a label containing XML is escaped in the opml export');

  // Node chat binding
  console.log('\n=== 9. Node chat ===');
  const chat1 = await axios.post(`${BASE}/${mapId}/nodes/${alphaId}/chat`, {}, H(t1));
  ok(chat1.status === 200 && chat1.data.sessionId, 'opening a node chat returns a session id');
  ok(chat1.data.seedPrompt.includes('Alpha'), 'the seed prompt names the node');
  ok(chat1.data.seedPrompt.includes('Root'), 'the seed prompt carries the ancestor path');
  const chat2 = await axios.post(`${BASE}/${mapId}/nodes/${alphaId}/chat`, {}, H(t1));
  ok(chat2.data.sessionId === chat1.data.sessionId && chat2.data.resumed === true,
    'reopening the same node resumes its conversation rather than starting a new one');

  // Documents
  console.log('\n=== 9b. Documents ===');
  const FormData = require(B + '/node_modules/form-data');
  const postDocs = async (token, fields, files) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append('files', Buffer.from(f.body), { filename: f.name, contentType: 'text/plain' });
    return axios.post(`${BASE}/docs`, fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
  };

  const noFiles = await axios.post(`${BASE}/docs`, {}, H(t1));
  ok(noFiles.status === 400, `an upload with no files is rejected (${noFiles.status})`);

  const nodeUp = await postDocs(t1, { mapId, nodeId: alphaId },
    [{ name: 'alpha-notes.txt', body: 'Alpha is measured in basis points and rebalanced quarterly.' }]);
  ok(nodeUp.status === 201 && nodeUp.data.docs.length === 1, `a document uploads to a node (${nodeUp.status})`);
  const docId = nodeUp.data?.docs?.[0]?.docId;
  ok(nodeUp.data?.docs?.[0]?.chars > 20, `the text is extracted at upload time (${nodeUp.data?.docs?.[0]?.chars} chars)`);
  ok(!!nodeUp.data?.docs?.[0]?.url, 'the original file is addressable');

  const orphanNode = await postDocs(t1, { nodeId: alphaId }, [{ name: 'x.txt', body: 'hello there' }]);
  ok(orphanNode.status === 400, `a nodeId without a mapId is rejected (${orphanNode.status})`);
  const foreignUp = await postDocs(t2, { mapId, nodeId: alphaId }, [{ name: 'x.txt', body: 'hello there' }]);
  ok(foreignUp.status === 404, `uploading into another user's map is refused (${foreignUp.status})`);

  const withDocs = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(withDocs.data.docs.length === 1, 'the map read carries its documents');
  ok(withDocs.data.sources.some(s => s.type === 'document' && s.label === 'alpha-notes.txt'),
    'the document shows up in the map source list');

  const readDoc = await axios.get(`${BASE}/docs/${docId}`, H(t1));
  ok(readDoc.status === 200 && readDoc.data.doc.text.includes('basis points'),
    'a document reads back with its extracted text');
  const foreignDoc = await axios.get(`${BASE}/docs/${docId}`, H(t2));
  ok(foreignDoc.status === 404, `another user cannot read the document (${foreignDoc.status})`);

  // Documents are inherited down the branch: alpha1 sits under beta now, so it
  // must NOT see alpha's document, while alpha itself must.
  const alphaChat = await axios.post(`${BASE}/${mapId}/nodes/${alphaId}/chat`, {}, H(t1));
  ok(alphaChat.data.docs.length === 1 && alphaChat.data.docs[0].scope === 'node',
    'the node chat is handed the document attached to that node');
  const rootChat = await axios.post(`${BASE}/${mapId}/nodes/${rootId}/chat`, {}, H(t1));
  ok(rootChat.data.docs.length === 0, 'a document on a child does not leak up to the root');

  const mapUp = await postDocs(t1, { mapId }, [{
    name: 'map-level.txt',
    body: 'A map-wide reference document that every node in this map may draw on when answering.'
  }]);
  ok(mapUp.status === 201, `a map-level document uploads (${mapUp.status})`);
  const rootChat2 = await axios.post(`${BASE}/${mapId}/nodes/${rootId}/chat`, {}, H(t1));
  ok(rootChat2.data.docs.length === 1, 'a map-level document is in scope for every node');
  ok(rootChat2.data.docs[0].scope === 'map', 'a map-level document is labelled as such');
  const alphaChat2 = await axios.post(`${BASE}/${mapId}/nodes/${alphaId}/chat`, {}, H(t1));
  ok(alphaChat2.data.docs.length === 2 && alphaChat2.data.docs[0].scope === 'node',
    'a node sees its own document first, then the map-level one');

  // Too short to be a source. Silently feeding "hi" to the model as evidence is
  // worse than leaving it out, so the floor is deliberate.
  const trivial = await postDocs(t1, { mapId, nodeId: alphaId }, [{ name: 'note.txt', body: 'hi' }]);
  const alphaChat3 = await axios.post(`${BASE}/${mapId}/nodes/${alphaId}/chat`, {}, H(t1));
  ok(alphaChat3.data.docs.length === 2, 'a document with almost no text is not offered as a source');
  await axios.delete(`${BASE}/docs/${trivial.data.docs[0].docId}`, H(t1));

  const moved2 = await axios.patch(`${BASE}/docs/${docId}`, { nodeId: betaId }, H(t1));
  ok(moved2.status === 200 && moved2.data.doc.nodeId === betaId, `a document can be moved to another node (${moved2.status})`);
  const badMove = await axios.patch(`${BASE}/docs/${docId}`, { nodeId: otherRows[0].node_id }, H(t1));
  ok(badMove.status === 400, `a move onto a node outside the map is rejected (${badMove.status})`);

  const listed2 = await axios.get(`${BASE}/docs`, H(t1));
  ok(listed2.status === 200 && listed2.data.docs.length >= 2, 'the document library lists the caller\'s uploads');
  const foreignDel = await axios.delete(`${BASE}/docs/${docId}`, H(t2));
  ok(foreignDel.status === 404, `another user cannot delete the document (${foreignDel.status})`);

  // Delete semantics
  console.log('\n=== 10. Delete ===');
  const delRoot = await axios.delete(`${BASE}/${mapId}/nodes/${rootId}`, H(t1));
  ok(delRoot.status === 400, `deleting the root is refused with guidance (${delRoot.status})`);
  const delBranch = await axios.delete(`${BASE}/${mapId}/nodes/${betaId}`, H(t1));
  ok(delBranch.status === 200, 'deleting a branch succeeds');
  const afterDel = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(!afterDel.data.nodes.some(n => n.node_id === alpha1Id), 'the moved child went with its new parent');
  ok(afterDel.data.edges.length === 0, 'cross-links touching a deleted node are cleaned up');
  ok(!afterDel.data.docs.some(d => d.doc_id === docId),
    'a document attached to a deleted node goes with it');
  ok(afterDel.data.docs.length === 1, 'the map-level document survives a node delete');

  // Generation (optional)
  console.log('\n=== 11. Generation ===');
  if (!WITH_LLM) {
    console.log('  [SKIP] pass --llm to include live generation');
  } else {
    const gen = await axios.post(`${BASE}/generate`, { sourceType: 'topic', topic: 'Bond convexity' }, H(t1));
    ok(gen.status === 201 && gen.data.nodeCount > 5, `POST /generate builds a map (${gen.data?.nodeCount} nodes)`);
    if (gen.data?.mapId) {
      const tree2 = await axios.get(`${BASE}/${gen.data.mapId}`, H(t1));
      ok(tree2.data.nodes.length === gen.data.nodeCount, 'the generated map reads back at full size');
      await axios.delete(`${BASE}/${gen.data.mapId}`, H(t1));
    }
    const empty = await axios.post(`${BASE}/generate`, { sourceType: 'topic', topic: '' }, H(t1));
    ok(empty.status === 400, `an empty topic is rejected (${empty.status})`);

    // Generate from documents: the staged upload must end up owned by the map
    // it produced, so the root can name what it was built from.
    const staged = await postDocs(t1, {}, [{
      name: 'convexity.txt',
      body: 'Bond convexity measures the curvature of the price-yield relationship. ' +
            'Duration is a first-order approximation; convexity is the second-order correction. ' +
            'Positive convexity means the price rises more than duration predicts when yields fall, ' +
            'and falls less than predicted when yields rise. Callable bonds can exhibit negative ' +
            'convexity because the issuer will refinance as yields drop. Portfolio managers buy ' +
            'convexity as insurance against large rate moves, and pay for it in yield.'
    }]);
    ok(staged.status === 201 && !staged.data.docs[0].mapId, 'a staged document starts with no map');
    const genDoc = await axios.post(`${BASE}/generate`,
      { sourceType: 'document', docIds: [staged.data.docs[0].docId] }, H(t1));
    ok(genDoc.status === 201 && genDoc.data.nodeCount > 5,
      `POST /generate builds a map from documents (${genDoc.data?.nodeCount} nodes)`);
    if (genDoc.data?.mapId) {
      const built = await axios.get(`${BASE}/${genDoc.data.mapId}`, H(t1));
      ok(built.data.docs.length === 1, 'the map adopted the document it was built from');
      ok(built.data.sources.some(s => s.label === 'convexity.txt'), 'the source is named on the map');
      await axios.delete(`${BASE}/${genDoc.data.mapId}`, H(t1));
    }
    const unreadable = await postDocs(t1, {}, [{ name: 'tiny.txt', body: 'hi' }]);
    const genBad = await axios.post(`${BASE}/generate`,
      { sourceType: 'document', docIds: [unreadable.data.docs[0].docId] }, H(t1));
    ok(genBad.status === 422, `a document with no usable text is refused, not turned into a stub (${genBad.status})`);
    await axios.delete(`${BASE}/docs/${unreadable.data.docs[0].docId}`, H(t1));
  }

  // Cleanup
  const delMap = await axios.delete(`${BASE}/${mapId}`, H(t1));
  ok(delMap.status === 200, 'the map deletes cleanly');
  const gone = await axios.get(`${BASE}/${mapId}`, H(t1));
  ok(gone.status === 404, 'a deleted map is gone');
  await query('DELETE FROM mind_maps WHERE map_id = $1', [otherMap]);

  console.log(`\n──────────────\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Harness error:', e.message); process.exit(1); });
