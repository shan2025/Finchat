// Sprint Z · Track A · A6 — text notes, generate-from-text, node enrichment,
// and the briefing conversation title.
//
// Same shape as test_mind_map_api.js: exercises the real Express stack over
// HTTP with a minted token, and skips anything that costs LLM quota unless
// --llm is passed.
//
// Requires the server running on PORT (default 3000):  npm run dev
// Run: node scripts/test_mind_map_text_and_enrich.js [--llm] [--port=3000]

const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const axios = require(B + '/node_modules/axios');
const jwt = require(B + '/node_modules/jsonwebtoken');
const { query } = require(B + '/database');

const PORT = (process.argv.find(a => a.startsWith('--port=')) || '').replace('--port=', '') || process.env.PORT || 3000;
const ROOT = `http://localhost:${PORT}`;
const BASE = `${ROOT}/api/mind-maps`;
const WITH_LLM = process.argv.includes('--llm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

const H = t => ({ headers: { Authorization: `Bearer ${t}` }, validateStatus: () => true });

const NOTE = `Consensus in a permissioned ledger is not the same problem as in an open one.
With a known validator set you can use BFT voting, which finalises in one round and
never forks. The cost is membership: adding or removing a validator is a governance
event, not a market outcome. Practical Byzantine Fault Tolerance tolerates f faulty
nodes out of 3f+1, and every validator talks to every other, so message complexity
grows quadratically and the set cannot grow very large.`;

// What someone would realistically paste in: enough breadth that a map of it is
// a map and not a list. NOTE above is deliberately one narrow paragraph, so the
// two exercise opposite ends of the branch-count guard.
const PASSAGE = `${NOTE}

Permissionless consensus starts from the opposite constraint: anyone may join, so
identity cannot gate participation and Sybil resistance has to be bought. Proof of
work buys it with electricity — a block costs real energy, so rewriting history costs
that energy again. Proof of stake buys it with capital at risk: validators bond funds
that are destroyed if they sign conflicting blocks. Neither gives instant finality;
both give a probability of reversal that decays as blocks accumulate on top.

Finality is therefore the sharpest axis to compare designs on. BFT protocols finalise
in seconds and never reorganise, but stall entirely if more than a third of the
validator set is unreachable — they prefer consistency over availability. Nakamoto
consensus never stalls and always makes progress, but a block is only ever probably
final, so exchanges wait for confirmations. Hybrid designs bolt a finality gadget onto
a longest-chain protocol to get both: the chain keeps producing blocks, and a separate
voting round periodically marks a checkpoint as irreversible.

Throughput is bounded by different things in each. In BFT it is message complexity,
which is why validator sets stay in the hundreds and why HotStuff's linear
communication was a significant result. In Nakamoto consensus it is block propagation:
larger blocks reach the network more slowly, which raises the orphan rate and pushes
mining toward whoever is best connected. Sharding and rollups both attack this by
moving execution off the consensus path rather than by speeding consensus up.

Governance is the part that is easiest to ignore and hardest to change later. A
permissioned chain's validator set is edited by whoever controls membership, so its
security is ultimately a legal question rather than a cryptographic one. A public
chain's rules change by client software adoption, which makes upgrades slow and
contentious but leaves no single party who can quietly rewrite the constraints.`;

(async () => {
  const users = await query('SELECT user_id FROM users ORDER BY created_at LIMIT 2');
  if (users.rows.length < 2) { console.log('Need two users. Aborting.'); process.exit(1); }
  const [u1, u2] = users.rows.map(r => r.user_id);

  const secret = process.env.JWT_SECRET;
  if (!secret) { console.log('JWT_SECRET missing from .env. Aborting.'); process.exit(1); }
  const tok = id => jwt.sign({ id, userId: id }, secret, { expiresIn: '1h' });
  const t1 = tok(u1), t2 = tok(u2);

  const reach = await axios.get(BASE, H(t1));
  if (reach.status !== 200) {
    console.log(`  server not reachable or auth shape differs (${reach.status}). Is it running on ${PORT}?`);
    process.exit(1);
  }

  // Whether nested children survive the write is OUR depth arithmetic, not the
  // model's judgement, so it is tested against a fixed response instead of
  // whatever the live model happens to return today. Only the in-process Engine
  // is stubbed — every HTTP test above still goes through the real thing.
  const inferenceId = require.resolve(B + '/services/inference');
  const realInference = require(inferenceId);
  let stubReply = null;
  require.cache[inferenceId].exports = {
    ...realInference,
    runInference: async (...args) => (stubReply
      ? { content: JSON.stringify(stubReply), provider: 'stub', model: 'stub' }
      : realInference.runInference(...args))
  };

  // A map to hang everything off, seeded directly so the cheap tests never
  // depend on the LLM.
  const Engine = require(B + '/services/cognitive/MindMapEngine');
  const mapId = await Engine.createMap({ userId: u1, title: 'Note Test', topic: 'consensus', sourceType: 'topic' });
  const tree = Engine.normalizeTree({
    root: { label: 'Consensus', summary: 'how a ledger agrees' },
    branches: [{ label: 'Permissioned' }, { label: 'Permissionless' }, { label: 'Finality' }]
  }, 'Consensus');
  const rows = Engine.flatten(tree, mapId);
  await Engine.insertNodes(rows);
  const rootId = rows[0].node_id;
  const permId = rows.find(r => r.label === 'Permissioned').node_id;

  const cleanup = [];   // doc ids created outside the map's cascade

  // ── 1. Writing a note ──────────────────────────────────────────
  console.log('\n=== 1. Text notes ===');
  const made = await axios.post(`${BASE}/docs/text`,
    { mapId, nodeId: permId, title: 'BFT notes', text: NOTE }, H(t1));
  ok(made.status === 201, `a note on a node is created (${made.status})`);
  const noteId = made.data?.doc?.docId;
  ok(made.data?.doc?.kind === 'text', `it is stored as kind "text" (${made.data?.doc?.kind})`);
  ok(made.data?.doc?.chars > 200, `its length is recorded (${made.data?.doc?.chars} chars)`);
  ok(made.data?.doc?.url === null, 'it has no file URL — there is no blob behind a note');

  const empty = await axios.post(`${BASE}/docs/text`, { mapId, nodeId: permId, text: '   ' }, H(t1));
  ok(empty.status === 400, `an empty note is rejected (${empty.status})`);

  const untitled = await axios.post(`${BASE}/docs/text`, { text: 'Quadratic message complexity is the ceiling on validator set size.' }, H(t1));
  ok(untitled.status === 201, `a library note needs no map (${untitled.status})`);
  ok(/^Quadratic message/.test(untitled.data?.doc?.filename || ''),
    `an unnamed note is titled from its own words ("${untitled.data?.doc?.filename}")`);
  if (untitled.data?.doc?.docId) cleanup.push(untitled.data.doc.docId);

  const strayNode = await axios.post(`${BASE}/docs/text`, { nodeId: permId, text: NOTE }, H(t1));
  ok(strayNode.status === 400, `a nodeId with no mapId is rejected (${strayNode.status})`);
  const foreignMap = await axios.post(`${BASE}/docs/text`, { mapId, nodeId: permId, text: NOTE }, H(t2));
  ok(foreignMap.status === 404, `another user cannot file a note on this map (${foreignMap.status})`);

  // ── 2. Reading and rewriting ───────────────────────────────────
  console.log('\n=== 2. Notes are editable ===');
  const read = await axios.get(`${BASE}/docs/${noteId}`, H(t1));
  ok(read.status === 200 && /Practical Byzantine/.test(read.data?.doc?.text || ''),
    'the note reads back with its text');

  const edited = await axios.patch(`${BASE}/docs/${noteId}/text`,
    { title: 'BFT notes (revised)', text: NOTE + '\nHotStuff reduces that to linear.' }, H(t1));
  ok(edited.status === 200, `a note can be rewritten in place (${edited.status})`);
  ok(/HotStuff/.test(edited.data?.doc?.text || ''), 'the rewrite is what comes back');
  ok(edited.data?.doc?.filename === 'BFT notes (revised)', 'the title is updated too');

  const retitle = await axios.patch(`${BASE}/docs/${noteId}/text`, { title: 'BFT notes' }, H(t1));
  ok(retitle.status === 200 && /HotStuff/.test(retitle.data?.doc?.text || ''),
    're-titling alone leaves the text alone');

  const blanked = await axios.patch(`${BASE}/docs/${noteId}/text`, { text: '' }, H(t1));
  ok(blanked.status === 400, `a note cannot be emptied (${blanked.status})`);

  const foreignEdit = await axios.patch(`${BASE}/docs/${noteId}/text`, { text: 'mine now' }, H(t2));
  ok(foreignEdit.status === 404, `another user cannot rewrite it (${foreignEdit.status})`);

  // An upload is immutable — the note editor must refuse it rather than
  // silently replacing the extracted text of a file that still exists on disk.
  const upl = await query(`
    INSERT INTO mind_map_docs (doc_id, user_id, map_id, node_id, filename, mimetype, size_bytes,
                               stored_name, kind, extracted, char_count)
    VALUES ($1,$2,$3,$4,'paper.pdf','application/pdf',1234,'x.pdf','document','some extracted text',19)
    RETURNING doc_id`, ['mmd_test_' + Date.now(), u1, mapId, permId]);
  const uploadId = upl.rows[0].doc_id;
  const editUpload = await axios.patch(`${BASE}/docs/${uploadId}/text`, { text: 'rewritten' }, H(t1));
  ok(editUpload.status === 400, `an uploaded document cannot be edited as a note (${editUpload.status})`);

  // ── 3. Notes are inherited like any other source ───────────────
  console.log('\n=== 3. Inheritance ===');
  const scoped = await Engine.inheritedDocs(permId);
  ok(scoped.some(d => d.doc_id === noteId), 'the node sees its own note');
  const child = await axios.post(`${BASE}/${mapId}/nodes`,
    { parentId: permId, label: 'PBFT' }, H(t1));
  const childId = child.data?.nodeId;
  const below = await Engine.inheritedDocs(childId);
  ok(below.some(d => d.doc_id === noteId), 'a child inherits the note from its parent');

  const bound = await axios.post(`${BASE}/${mapId}/nodes/${childId}/chat`, {}, H(t1));
  ok(bound.status === 200 && (bound.data.docs || []).some(d => d.docId === noteId),
    'the node conversation is grounded in the inherited note');

  // ── 4. Enrichment ──────────────────────────────────────────────
  console.log('\n=== 4. Enrichment ===');
  const noText = await axios.post(`${BASE}/${mapId}/nodes/${permId}/enrich`, { text: '  ' }, H(t1));
  ok(noText.status === 400, `enrich with no text is rejected (${noText.status})`);
  const foreignEnrich = await axios.post(`${BASE}/${mapId}/nodes/${permId}/enrich`, { text: NOTE }, H(t2));
  ok(foreignEnrich.status === 404, `another user cannot enrich this map (${foreignEnrich.status})`);

  // Children of children of children — the thing "more detail means more
  // children" actually asks for. Deterministic, so it runs without --llm.
  console.log('\n=== 4b. Nesting depth (stubbed model) ===');
  const deepMapId = await Engine.createMap({ userId: u1, title: 'Depth Test', topic: 'depth', sourceType: 'topic' });
  const deepRows = Engine.flatten(
    Engine.normalizeTree({ root: { label: 'Ledger' }, branches: [{ label: 'Design' }] }, 'Ledger'), deepMapId);
  await Engine.insertNodes(deepRows);
  const designId = deepRows.find(r => r.label === 'Design').node_id;

  stubReply = {
    summary: 'How the ledger is put together.',
    detail: 'Rewritten from the supplied material.',
    children: [
      {
        label: 'PBFT', summary: 'classic BFT', detail: 'tolerates f of 3f+1',
        children: [
          {
            label: 'Quorum size', summary: 'why 2f+1', detail: 'overlap argument',
            children: [{ label: 'View change', summary: 'leader replacement', detail: 'fires on timeout' }]
          }
        ]
      },
      { label: 'HotStuff', summary: 'linear messages', detail: 'pipelined phases' }
    ]
  };
  const deep = await Engine.enrichNode(deepMapId, designId, NOTE, { userId: u1 });
  stubReply = null;

  const deepFull = await Engine.getMap(deepMapId, u1);
  const byLabel = l => deepFull.nodes.find(n => n.label === l);
  ok(deep.added === 4, `every level of the reply is written (${deep.added} nodes)`);
  ok(byLabel('PBFT') && byLabel('PBFT').parent_id === designId, 'a child hangs off the enriched node');
  ok(byLabel('Quorum size') && byLabel('Quorum size').parent_id === byLabel('PBFT').node_id,
    'a child of that child is kept');
  ok(byLabel('View change') && byLabel('View change').parent_id === byLabel('Quorum size').node_id,
    'and a child of THAT one — nesting is not flattened on the way in');
  ok(byLabel('Design').summary === 'How the ledger is put together.', 'the node itself is rewritten');
  await query('DELETE FROM mind_maps WHERE map_id = $1', [deepMapId]);

  if (WITH_LLM) {
    const before = await axios.get(`${BASE}/${mapId}`, H(t1));
    const beforeCount = before.data.nodes.length;
    const beforeNode = before.data.nodes.find(n => n.node_id === permId);

    const grown = await axios.post(`${BASE}/${mapId}/nodes/${permId}/enrich`,
      { text: NOTE, saveNote: true, title: 'From the lecture' }, H(t1));
    ok(grown.status === 200, `enrich succeeds (${grown.status}) ${grown.data?.details || ''}`);
    ok(grown.data?.added > 0, `it added children (${grown.data?.added})`);
    ok(grown.data?.rewritten === true, 'it rewrote the node itself');
    ok(!!grown.data?.note, 'the supplied text was kept as a source note');
    if (grown.data?.note?.docId) cleanup.push(grown.data.note.docId);

    const after = await axios.get(`${BASE}/${mapId}`, H(t1));
    const afterNode = after.data.nodes.find(n => n.node_id === permId);
    ok(after.data.nodes.length > beforeCount,
      `the tree grew (${beforeCount} → ${after.data.nodes.length} nodes)`);
    ok((afterNode.summary || '') !== (beforeNode.summary || '') || (afterNode.detail || '') !== (beforeNode.detail || ''),
      'the node now says something it did not before');
    const kids = after.data.nodes.filter(n => n.parent_id === permId);
    console.log('        new children: ' + kids.map(k => k.label).join(', '));
    const grandkids = after.data.nodes.filter(n => kids.some(k => k.node_id === n.parent_id));
    console.log(`        depth reached: ${grandkids.length ? 'children of children present' : 'one level'}`);

    // Generate a whole map from pasted text.
    console.log('\n=== 5. Generate from text ===');
    const short = await axios.post(`${BASE}/generate`, { sourceType: 'text', text: 'too short' }, H(t1));
    ok(short.status === 422 || short.status === 400, `text that is too short is refused (${short.status})`);

    // A paragraph with no breadth is refused by the branch-count guard. What
    // matters is that the refusal names the fix — the client only ever shows
    // `error`, so a generic one reads as a crash.
    const thin = await axios.post(`${BASE}/generate`,
      { sourceType: 'text', text: NOTE, title: 'One paragraph' }, H(t1));
    if (thin.status === 422) {
      ok(/paste more|too thin/i.test(thin.data?.error || ''),
        `a thin paste is refused with an actionable reason ("${thin.data?.error}")`);
    } else if (thin.status === 201) {
      ok(true, 'a short paragraph was rich enough to map after all');
      await query('DELETE FROM mind_maps WHERE map_id = $1', [thin.data.mapId]);
    } else {
      ok(false, `unexpected status for a thin paste (${thin.status})`);
    }

    const built = await axios.post(`${BASE}/generate`,
      { sourceType: 'text', text: PASSAGE, title: 'Consensus notes' }, H(t1));
    ok(built.status === 201, `a map is built from pasted text (${built.status}) ${built.data?.details || ''}`);
    if (built.data?.mapId) {
      const full = await axios.get(`${BASE}/${built.data.mapId}`, H(t1));
      ok(full.data?.map?.source_type === 'text',
        `the map records where it came from (${full.data?.map?.source_type})`);
      ok((full.data?.docs || []).some(d => d.kind === 'text'),
        'the pasted text survives as a source on the map');
      console.log(`        built "${built.data.title}" — ${built.data.nodeCount} nodes`);
      await query('DELETE FROM mind_maps WHERE map_id = $1', [built.data.mapId]);
    }
  } else {
    console.log('  [SKIP] enrichment and generate-from-text (pass --llm to include)');
  }

  // ── 6. Briefing conversations are named ────────────────────────
  console.log('\n=== 6. Briefing session title ===');
  const { briefingSessionTitle } = require(B + '/services/briefing');
  const when = new Date('2026-08-13T06:00:00Z');
  ok(/Daily News/.test(briefingSessionTitle(when)) && /2026/.test(briefingSessionTitle(when)),
    `the title is dated ("${briefingSessionTitle(when)}")`);

  // A briefing already in the database — no meta row, no user message. Before
  // this change every one of these read "New conversation".
  const legacyId = `briefing_${when.getTime()}_legacy`;
  await query(`
    INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content)
    VALUES ($1,$2,$3,'plato','assistant','Frontier Intelligence Brief — test body')
  `, ['conv_test_' + Date.now(), legacyId, u1]);

  const sess = await axios.get(`${ROOT}/api/ai-chat/sessions`, H(t1));
  const found = (sess.data?.sessions || []).find(s => s.session_id === legacyId);
  ok(!!found, 'the briefing conversation is listed');
  ok(found && /Daily News/.test(found.title), `it is titled from the briefing, not "New conversation" ("${found?.title}")`);
  ok(found && found.title === briefingSessionTitle(when),
    'the title carries the date the briefing ran');

  await query('DELETE FROM ai_conversations WHERE session_id = $1', [legacyId]);
  await query('DELETE FROM ai_session_meta WHERE session_id = $1', [legacyId]);

  // ── cleanup ────────────────────────────────────────────────────
  await query('DELETE FROM mind_maps WHERE map_id = $1', [mapId]);
  if (cleanup.length) {
    await query('DELETE FROM mind_map_docs WHERE doc_id = ANY($1::text[])', [cleanup]);
  }

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('\nTest run threw:', err.message);
  process.exit(1);
});
