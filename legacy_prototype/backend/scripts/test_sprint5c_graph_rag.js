// scripts/test_sprint5c_graph_rag.js — Sprint 5C · Deep Vector Memory verification.
// Covers: entity extraction & upsert, edge creation, one-hop graph walk from a new goal,
// skill-recipe capture from a plan, embedding-similarity retrieval, and ContextBuilder
// injection of both.
const { query, getPool } = require('../database');
const { upsertEntity, upsertEdge, findRelatedForText, ingestExecution } = require('../services/cognitive/EntityGraph');
const { recordFromExecution, findRelevant, normalizeSteps } = require('../services/cognitive/SkillRecipes');
const { retrieveEnrichedContext } = require('../services/cognitive/MemoryService');
const { buildContext } = require('../services/cognitive/ContextBuilder');

let passed = 0, failed = 0;
function check(label, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); passed++; }
  else { console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const TAG = 'sprint5c_test';

async function cleanup() {
  await query("DELETE FROM entity_edges WHERE context_execution_id LIKE $1", [TAG + '%']);
  await query("DELETE FROM skill_recipes WHERE source_execution_id LIKE $1", [TAG + '%']);
  await query("DELETE FROM entities WHERE entity_id LIKE 'ent_%' AND canonical_name IN ('Solana','TSLA','Rust','React','pgvector')");
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Sprint 5C · Graph-RAG + Skill Recipes');
  console.log('═══════════════════════════════════════════════\n');

  await cleanup();

  // ── Test 1: entity upsert & counter bump ──
  console.log('▸ Test 1: Entity upsert idempotency');
  const solId1 = await upsertEntity({ name: 'Solana', type: 'technology' });
  const solId2 = await upsertEntity({ name: 'Solana', type: 'technology' });
  check('Same entity returns same id', solId1 === solId2);
  const solRow = (await query(`SELECT mention_count FROM entities WHERE entity_id=$1`, [solId1])).rows[0];
  check('mention_count bumped on repeat upsert', solRow.mention_count >= 2, 'count=' + solRow.mention_count);

  // ── Test 2: manual edges and one-hop walk ──
  console.log('\n▸ Test 2: Edges and one-hop walk from goal text');
  const rust = await upsertEntity({ name: 'Rust', type: 'technology' });
  const pgvec = await upsertEntity({ name: 'pgvector', type: 'technology' });
  await upsertEdge({ fromId: solId1, toId: rust, edgeType: 'co_mentioned', executionId: TAG + '_1' });
  await upsertEdge({ fromId: solId1, toId: pgvec, edgeType: 'co_mentioned', executionId: TAG + '_1' });
  const related = await findRelatedForText('what is the best way to build on Solana?', 8);
  const names = related.map(r => r.name);
  check('Related walk found Rust', names.includes('Rust'), names.join(', '));
  check('Related walk found pgvector', names.includes('pgvector'));
  check('Related returned edge type and weight', related.every(r => r.viaEdge && r.weight >= 1));

  // ── Test 3: ingestExecution — extraction path (uses live LLM) ──
  console.log('\n▸ Test 3: ingestExecution end-to-end');
  const ids = await ingestExecution({
    execution_id: TAG + '_ingest',
    goal: 'Compare TSLA stock performance to the broader market',
    result: 'TSLA is currently trading near recent highs; the S&P 500 lagged this week.'
  });
  check('Extraction produced ≥1 entity id', ids.length >= 1, ids.length + ' ids');

  // ── Test 4: skill-recipe capture only for natural, multi-step plans ──
  console.log('\n▸ Test 4: Skill recipe capture rules');
  const tooShort = await recordFromExecution({
    execution_id: TAG + '_short',
    goal: 'hi', result: 'hello',
    current_plan: { steps: [{ step: 1, action: 'respond' }] },
    completion_reason: 'natural'
  });
  check('Single-step plan is NOT captured', tooShort === null);
  const budgetOut = await recordFromExecution({
    execution_id: TAG + '_budget',
    goal: 'x', result: 'y',
    current_plan: { steps: [{ step: 1, action: 'tool', tool: 'search', input: 'x' }, { step: 2, action: 'respond' }] },
    completion_reason: 'budget_exceeded'
  });
  check('Budget-exceeded plan is NOT captured', budgetOut === null);
  const goodPlan = {
    steps: [
      { step: 1, action: 'tool', tool: 'search', input: 'TSLA competitors', thought: 'need context' },
      { step: 2, action: 'tool', tool: 'stocks', input: 'TSLA', thought: 'get price' },
      { step: 3, action: 'respond', thought: 'summarize' }
    ]
  };
  const captured = await recordFromExecution({
    execution_id: TAG + '_ok',
    goal: 'Research Tesla stock performance and compare to competitors',
    result: 'Tesla trades at $329 with weaker YTD than …',
    current_plan: goodPlan,
    completion_reason: 'natural',
    assigned_agent: 'aurelius'
  });
  check('Multi-step natural plan IS captured', captured && captured.recipeId);

  const norm = normalizeSteps(goodPlan);
  check('normalizeSteps preserves 3 steps', norm && norm.length === 3);
  check('normalizeSteps carries tool name', norm && norm[1].tool === 'stocks');

  // ── Test 5: recipe retrieval by embedding similarity ──
  console.log('\n▸ Test 5: Recipe similarity retrieval');
  const hits = await findRelevant({ goal: 'Analyze Tesla and its main rivals in the EV market', agentId: 'aurelius', limit: 3 });
  check('Similar goal returns ≥1 recipe', hits.length >= 1, hits.length + ' hits');
  const irrelevant = await findRelevant({ goal: 'Write a haiku about clouds', agentId: 'nova', limit: 3 });
  check('Unrelated goal returns 0 recipes (filter threshold)', irrelevant.length === 0, irrelevant.length + ' hits');

  // ── Test 6: enriched context bundle & prompt injection ──
  console.log('\n▸ Test 6: retrieveEnrichedContext + ContextBuilder injection');
  const enriched = await retrieveEnrichedContext({
    userId: 'test_sprint5c_user',
    conversationId: null,
    goal: 'Research Tesla stock performance and compare to competitors',
    agentName: 'aurelius'
  });
  check('Bundle has memories array', Array.isArray(enriched.memories));
  check('Bundle has graphContext array', Array.isArray(enriched.graphContext));
  check('Bundle has recipeHints array', Array.isArray(enriched.recipeHints));
  check('Recipes actually returned', enriched.recipeHints.length >= 1);

  const messages = buildContext({
    goal: 'Analyze Tesla vs competitors',
    agentName: 'aurelius',
    memories: enriched.memories,
    graphContext: enriched.graphContext,
    recipeHints: enriched.recipeHints
  });
  const sysBlob = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  check('System prompt contains PROVEN SKILL RECIPES section', /PROVEN SKILL RECIPES/.test(sysBlob));
  check('Skill recipe steps injected into prompt', /stocks|search/.test(sysBlob));

  // Also feed a query that mentions Solana so graph section shows
  const enriched2 = await retrieveEnrichedContext({
    userId: 'test_sprint5c_user',
    goal: 'How should I architect a Solana devnet integration?',
    agentName: 'nova'
  });
  const msgs2 = buildContext({
    goal: 'Architect Solana devnet',
    agentName: 'nova',
    memories: enriched2.memories,
    graphContext: enriched2.graphContext,
    recipeHints: enriched2.recipeHints
  });
  const sys2 = msgs2.filter(m => m.role === 'system').map(m => m.content).join('\n');
  check('Solana-anchored query triggers RELATED CONCEPTS section', /RELATED CONCEPTS/.test(sys2));

  await cleanup();

  console.log('\n═══════════════════════════════════════════════');
  console.log(`   Results: ✅ ${passed} passed  ❌ ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('Harness error:', e); process.exit(1); });
