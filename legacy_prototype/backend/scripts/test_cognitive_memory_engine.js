// scripts/test_cognitive_memory_engine.js — Sprint X · Cognitive Memory Engine verification.
// Covers: chat ingestion (LLM extraction → living nodes → reasoned edges → events →
// provenance), dedup on re-ingestion, activation recording, gap detection, and the
// dream consolidation cycle (duplicate merge + edge decay).
//
// Uses the live DB and live Groq inference — run with the backend env present:
//   node scripts/test_cognitive_memory_engine.js

const { query, getPool } = require('../database');
const {
  ingestChat, recordActivation, detectGaps, dream, findExisting
} = require('../services/cognitive/MemoryEngine');
const { findRelatedForText } = require('../services/cognitive/EntityGraph');

let passed = 0, failed = 0;
function check(label, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); passed++; }
  else { console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const SESSION = 'cme_test_session';
const newIds = new Set(); // entities this test created → deleted at the end

async function cleanup() {
  if (newIds.size > 0) {
    const ids = [...newIds];
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    await query(`DELETE FROM entities WHERE entity_id IN (${ph})`, ids); // events/links/edges cascade
  }
  await query(`DELETE FROM entities WHERE canonical_name = 'Zebrafish Quantum Testing'`);
  await query(`DELETE FROM node_events WHERE source_id = $1`, [SESSION]);
  await query(`DELETE FROM graph_insights WHERE kind = 'dream_report' AND created_at > now() - interval '5 minutes'`);
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Sprint X · Cognitive Memory Engine');
  console.log('═══════════════════════════════════════════════\n');

  // ── Test 1: chat ingestion pipeline (live LLM) ──
  console.log('▸ Test 1: ingestChat — extraction → living nodes → reasoned edges');
  const report1 = await ingestChat({
    userId: 'cme_test_user',
    sessionId: SESSION,
    agentId: 'plato',
    userText: 'Can you explain how Transformers work in machine learning? I mostly code in Python.',
    aiText: 'Transformers are a neural network architecture built on self-attention. They power modern large language models. In Python you would typically use PyTorch to implement them.',
    sourceLabel: 'CME test chat'
  });
  for (const l of report1.learned) if (l.isNew) newIds.add(l.entityId);
  check('Learned at least 2 entities', report1.learned.length >= 2,
    report1.learned.map(l => l.name).join(', '));
  check('Detected at least 1 typed relation', report1.linked.length >= 1,
    report1.linked.map(l => `${l.from}→${l.to} (${l.type})`).join('; '));

  const anyId = report1.learned[0]?.entityId;
  const ent = anyId ? (await query(`SELECT * FROM entities WHERE entity_id = $1`, [anyId])).rows[0] : null;
  check('Node has a summary', !!ent && ent.summary.length > 0, ent?.summary?.slice(0, 60));
  check('Node has importance & confidence', !!ent && ent.importance > 0 && ent.confidence > 0,
    ent ? `imp=${ent.importance} conf=${ent.confidence}` : '');

  const evs = (await query(`SELECT event_type FROM node_events WHERE entity_id = $1`, [anyId])).rows;
  check('Timeline event recorded (created/mentioned)', evs.length > 0, evs.map(e => e.event_type).join(','));

  const links = (await query(`SELECT link_type, link_ref FROM entity_links WHERE entity_id = $1`, [anyId])).rows;
  check('Provenance link to chat session recorded', links.some(l => l.link_type === 'chat_session' && l.link_ref === SESSION));

  // ── Test 2: dedup — re-ingesting the same concepts grows nodes, doesn't fork ──
  console.log('\n▸ Test 2: duplicate detection on re-ingestion');
  const before = (await query(`SELECT COUNT(*)::int AS n FROM entities WHERE status = 'active'`)).rows[0].n;
  const report2 = await ingestChat({
    userId: 'cme_test_user',
    sessionId: SESSION,
    agentId: 'plato',
    userText: 'More about transformers please — the attention mechanism specifically.',
    aiText: 'The attention mechanism in Transformers lets each token weigh every other token, which is why they handle long-range context so well.',
    sourceLabel: 'CME test chat 2'
  });
  for (const l of report2.learned) if (l.isNew) newIds.add(l.entityId);
  const dupes = (await query(`
    SELECT LOWER(canonical_name) AS n, COUNT(*)::int AS c FROM entities
    WHERE status = 'active' GROUP BY LOWER(canonical_name) HAVING COUNT(*) > 1
  `)).rows;
  const reingested = report2.learned.filter(l => !l.isNew);
  check('Known concepts resolved to existing nodes (not forked)', reingested.length >= 1,
    reingested.map(l => l.name).join(', ') || 'all new');

  // ── Test 3: edges carry reason / strength / source ──
  console.log('\n▸ Test 3: living edges');
  const edge = (await query(`
    SELECT reason, strength, source, edge_type FROM entity_edges
    WHERE source = 'chat' ORDER BY created_at DESC LIMIT 1
  `)).rows[0];
  check('Chat edge exists with strength', !!edge && edge.strength > 0, edge ? `${edge.edge_type} s=${edge.strength}` : '');
  check('Edge has a reason', !!edge && edge.reason.length > 0, edge?.reason?.slice(0, 60));

  // ── Test 4: activation ──
  console.log('\n▸ Test 4: recordActivation — nodes light up');
  const ids = report1.learned.map(l => l.entityId).filter(Boolean);
  await recordActivation({ entityIds: ids, userId: 'cme_test_user', agentId: 'plato', source: 'retrieval', sourceId: SESSION, detail: 'CME test activation' });
  const act = (await query(`SELECT activation_count, last_activated_at FROM entities WHERE entity_id = $1`, [ids[0]])).rows[0];
  check('activation_count bumped', act.activation_count >= 1, `count=${act.activation_count}`);
  check('last_activated_at set', !!act.last_activated_at);
  const actEv = (await query(`SELECT 1 FROM node_events WHERE entity_id = $1 AND event_type = 'activated'`, [ids[0]])).rows;
  check('activated event in timeline', actEv.length >= 1);

  // ── Test 5: retrieval returns entity ids (for auto-activation in chat) ──
  console.log('\n▸ Test 5: graph retrieval carries entity_id + anchors');
  const rel = await findRelatedForText('Tell me about Transformers and attention', 6);
  check('findRelatedForText returns entity_id', rel.length > 0 && rel.every(r => r.entity_id),
    rel.slice(0, 3).map(r => `${r.name}(${r.viaEdge})`).join(', '));
  check('Anchors included', rel.some(r => r.viaEdge === 'anchor'));

  // ── Test 6: dream — duplicate merge + decay + gaps ──
  console.log('\n▸ Test 6: dream consolidation cycle');
  await query(`
    INSERT INTO entities (entity_id, canonical_name, entity_type, mention_count, summary)
    VALUES ('ent_test_dupe_a', 'Zebrafish Quantum Testing', 'topic', 5, 'dupe A'),
           ('ent_test_dupe_b', 'Zebrafish Quantum Testing', 'technology', 2, 'a much longer duplicate summary that should win')
    ON CONFLICT DO NOTHING
  `);
  const dreamReport = await dream({ userId: 'cme_test_user' });
  check('Dream report produced', !!dreamReport && !!dreamReport.finishedAt,
    `merged=${dreamReport.merged} decayed=${dreamReport.edgesDecayed} gaps=${dreamReport.gapsFound}`);
  const dupeA = (await query(`SELECT status FROM entities WHERE entity_id = 'ent_test_dupe_a'`)).rows[0];
  const dupeB = (await query(`SELECT status, merged_into FROM entities WHERE entity_id = 'ent_test_dupe_b'`)).rows[0];
  check('Duplicate merged (survivor active, loser merged)',
    dupeA?.status === 'active' && dupeB?.status === 'merged' && dupeB?.merged_into === 'ent_test_dupe_a',
    `A=${dupeA?.status} B=${dupeB?.status}→${dupeB?.merged_into}`);
  const survivor = (await query(`SELECT mention_count, summary FROM entities WHERE entity_id = 'ent_test_dupe_a'`)).rows[0];
  check('Survivor absorbed mentions + best summary', survivor.mention_count === 7 && survivor.summary.includes('longer'),
    `mentions=${survivor.mention_count}`);

  // ── Test 7: insights table has the dream report ──
  const ins = (await query(`SELECT 1 FROM graph_insights WHERE kind = 'dream_report' AND created_at > now() - interval '2 minutes'`)).rows;
  check('Dream report stored as insight', ins.length >= 1);

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  await cleanup();
  console.log('(test artifacts cleaned up)');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('💥 Test crashed:', err);
  try { await cleanup(); } catch (e) { }
  process.exit(1);
});
