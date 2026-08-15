/**
 * test_sprint3_tools_and_memory.js — Sprint 3 Verification Script
 * Tests: Specialist Tools (Paper, Resume, Crypto) + pgvector Memory Loop + Morning Briefing Scheduler
 * 
 * Run: node scripts/test_sprint3_tools_and_memory.js
 */

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';
let passed = 0, failed = 0, warnings = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

function warn(label) {
  console.log(`  ${WARN} ${label}`);
  warnings++;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('   Sprint 3 Verification — Tools & Memory');
  console.log('═══════════════════════════════════════════════\n');

  // ─── Test 1: ToolRegistry has all 5 tools ───
  console.log('▸ Test 1: ToolRegistry metadata');
  const { TOOLS, getToolMeta, listTools, getToolNames } = require('../services/cognitive/ToolRegistry');
  const names = getToolNames();
  assert(names.includes('search'), 'search tool registered');
  assert(names.includes('stocks'), 'stocks tool registered');
  assert(names.includes('paper'), 'paper tool registered');
  assert(names.includes('resume'), 'resume tool registered');
  assert(names.includes('crypto'), 'crypto tool registered');
  assert(listTools().length === 5, `listTools() returns 5 tools (got ${listTools().length})`);

  const paperMeta = getToolMeta('paper');
  assert(paperMeta && paperMeta.description.includes('arXiv'), 'paper tool description mentions arXiv');
  assert(paperMeta && paperMeta.inputSchema.required.includes('query'), 'paper tool requires query param');

  const resumeMeta = getToolMeta('resume');
  assert(resumeMeta && resumeMeta.cacheTTLSeconds === 0, 'resume tool has 0 cache TTL (unique inputs)');

  const cryptoMeta = getToolMeta('crypto');
  assert(cryptoMeta && cryptoMeta.cacheTTLSeconds === 90, 'crypto tool has 90s cache TTL');

  // ─── Test 2: PaperTool (arXiv API) ───
  console.log('\n▸ Test 2: PaperTool (arXiv search)');
  const PaperTool = require('../tools/PaperTool');
  try {
    const paperResult = await PaperTool.execute('quantum computing');
    assert(paperResult && !paperResult.error, 'PaperTool.execute("quantum computing") succeeded');
    assert(Array.isArray(paperResult.papers), 'Result contains papers array');
    if (paperResult.papers.length > 0) {
      const p = paperResult.papers[0];
      assert(p.title && p.title.length > 0, `First paper has title: "${p.title.substring(0, 60)}..."`);
      assert(Array.isArray(p.authors) && p.authors.length > 0, `Authors: ${p.authors.slice(0, 3).join(', ')}`);
      assert(p.summary && p.summary.length > 20, `Summary present (${p.summary.length} chars)`);
      assert(p.pdfUrl && p.pdfUrl.length > 0, `PDF URL present`);
    } else {
      warn('No papers returned (may be network/API issue)');
    }
  } catch (err) {
    warn(`PaperTool test failed (network?): ${err.message}`);
  }

  // ─── Test 3: ResumeTool (local analysis) ───
  console.log('\n▸ Test 3: ResumeTool (resume analysis)');
  const ResumeTool = require('../tools/ResumeTool');
  const resumeResult = await ResumeTool.execute(JSON.stringify({
    resumeText: 'Senior full stack developer with 5 years experience in JavaScript, TypeScript, Node.js, React, PostgreSQL, Docker, Git, REST APIs, and AWS. Led a team of 4 engineers building microservices. Experience with Redis, Kubernetes, and CI/CD pipelines.',
    targetRole: 'Full Stack Engineer'
  }));
  assert(resumeResult && !resumeResult.error, 'ResumeTool.execute() succeeded');
  assert(typeof resumeResult.matchScore === 'number', `Match score is a number: ${resumeResult.matchScore}`);
  assert(resumeResult.matchScore >= 40, `Match score ≥ 40 for a strong resume (got ${resumeResult.matchScore})`);
  assert(Array.isArray(resumeResult.matchingSkills), `Matching skills found: ${resumeResult.matchingSkills.join(', ')}`);
  assert(resumeResult.matchingSkills.includes('javascript'), 'Detected JavaScript skill');
  assert(resumeResult.matchingSkills.includes('react'), 'Detected React skill');
  assert(resumeResult.matchingSkills.includes('docker'), 'Detected Docker skill');
  assert(Array.isArray(resumeResult.recommendations), `Recommendations generated: ${resumeResult.recommendations.length}`);
  assert(resumeResult.analysis && resumeResult.analysis.seniorityDetected === true, 'Seniority signals detected (led, senior)');

  // Test with weak resume
  const weakResult = await ResumeTool.execute(JSON.stringify({
    resumeText: 'I am a student interested in coding. I know some Python basics.',
    targetRole: 'AI/ML Engineer'
  }));
  assert(weakResult.matchScore < 30, `Weak resume scores low for AI/ML (got ${weakResult.matchScore})`);
  assert(weakResult.missingSkills.length > 3, `Missing skills identified: ${weakResult.missingSkills.length}`);

  // ─── Test 4: CryptoTool (CoinGecko API) ───
  console.log('\n▸ Test 4: CryptoTool (CoinGecko lookup)');
  const CryptoTool = require('../tools/CryptoTool');
  try {
    const cryptoResult = await CryptoTool.execute('bitcoin');
    assert(cryptoResult && !cryptoResult.error, 'CryptoTool.execute("bitcoin") succeeded');
    assert(typeof cryptoResult.priceUsd === 'number', `BTC price: $${cryptoResult.priceUsd}`);
    assert(typeof cryptoResult.change24h === 'number', `24h change: ${cryptoResult.change24h}%`);
    assert(cryptoResult.marketCapUsd > 0, `Market cap: $${(cryptoResult.marketCapUsd / 1e9).toFixed(1)}B`);

    // Test ticker mapping
    const solResult = await CryptoTool.execute('SOL');
    assert(solResult && !solResult.error, 'CryptoTool.execute("SOL") ticker mapping works');
    assert(typeof solResult.priceUsd === 'number', `SOL price: $${solResult.priceUsd}`);
  } catch (err) {
    warn(`CryptoTool test failed (network/rate limit?): ${err.message}`);
  }

  // ─── Test 5: ToolManager integration ───
  console.log('\n▸ Test 5: ToolManager pipeline integration');
  const { executeTool } = require('../services/cognitive/ToolManager');
  try {
    const toolResult = await executeTool({
      executionId: 'test_sprint3_exec_001',
      agentId: 'rasha',
      toolName: 'resume',
      input: JSON.stringify({ resumeText: 'Expert in Node.js, React, Docker, PostgreSQL', targetRole: 'Backend Engineer' })
    });
    assert(toolResult && toolResult.output, 'executeTool(resume) through ToolManager succeeded');
    assert(typeof toolResult.output.matchScore === 'number', `ToolManager returned matchScore: ${toolResult.output.matchScore}`);
    assert(typeof toolResult.durationMs === 'number', `Duration: ${toolResult.durationMs}ms`);
    assert(toolResult.callId && toolResult.callId.startsWith('tc_'), `Call ID generated: ${toolResult.callId}`);
  } catch (err) {
    warn(`ToolManager integration test skipped (DB required): ${err.message}`);
  }

  // ─── Test 6: MemoryService deterministic fallback embedding ───
  console.log('\n▸ Test 6: MemoryService deterministic fallback embedding');
  const memoryService = require('../services/cognitive/MemoryService');
  const embedding = await memoryService.generateEmbedding('test quantum computing embedding');
  assert(embedding !== null, 'generateEmbedding() returns non-null (fallback or Ollama)');
  assert(Array.isArray(embedding), 'Embedding is an array');
  assert(embedding.length === 768, `Embedding dimension is 768 (got ${embedding.length})`);

  // Check norm — Ollama embeddings may not be L2-normalized, fallback ones are
  let norm = 0;
  for (const v of embedding) norm += v * v;
  norm = Math.sqrt(norm);
  assert(norm > 0.5, `Embedding has valid norm (norm = ${norm.toFixed(4)}, Ollama or fallback)`);

  // Check determinism (same input → same output)
  const embedding2 = await memoryService.generateEmbedding('test quantum computing embedding');
  const firstFive1 = embedding.slice(0, 5).map(v => v.toFixed(6)).join(',');
  const firstFive2 = embedding2.slice(0, 5).map(v => v.toFixed(6)).join(',');
  assert(firstFive1 === firstFive2, 'Deterministic: same input produces same embedding');

  // ─── Test 7: morning briefing service ───
  console.log('\n▸ Test 7: morning briefing exports');
  const briefing = require('../services/briefing');
  assert(typeof briefing.runMorningBriefing === 'function', 'runMorningBriefing() exported');
  assert(typeof briefing.briefingSessionTitle === 'function', 'briefingSessionTitle() exported');

  // ─── Test 8: ReflectionEngine imports MemoryService ───
  console.log('\n▸ Test 8: ReflectionEngine pgvector integration');
  const reflectionSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'cognitive', 'ReflectionEngine.js'), 'utf8'
  );
  assert(reflectionSource.includes('memoryService'), 'ReflectionEngine imports memoryService');
  assert(reflectionSource.includes('storeWithEmbedding'), 'ReflectionEngine calls storeWithEmbedding');
  assert(reflectionSource.includes("memoryType: 'procedural'"), 'ReflectionEngine stores procedural memory');
  assert(reflectionSource.includes('Auto-Embed into pgvector'), 'Sprint 3 auto-embed section present');
  assert(reflectionSource.includes('Distill Procedural Workflows'), 'Sprint 3 procedural distillation section present');

  // ─── Test 9: ContextBuilder includes new tools in prompts ───
  console.log('\n▸ Test 9: ContextBuilder tool injection');
  const { buildContext } = require('../services/cognitive/ContextBuilder');
  const ctx = buildContext({ goal: 'test', agentName: 'plato' });
  const systemMsg = ctx[0].content;
  assert(systemMsg.includes('"paper"'), 'System prompt includes paper tool');
  assert(systemMsg.includes('"resume"'), 'System prompt includes resume tool');
  assert(systemMsg.includes('"crypto"'), 'System prompt includes crypto tool');
  assert(systemMsg.includes('arXiv'), 'System prompt mentions arXiv for paper tool');
  assert(systemMsg.includes('cryptocurrency'), 'System prompt mentions cryptocurrency for crypto tool');

  // ─── Summary ───
  console.log('\n═══════════════════════════════════════════════');
  console.log(`   Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${WARN} ${warnings} warnings`);
  console.log('═══════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
