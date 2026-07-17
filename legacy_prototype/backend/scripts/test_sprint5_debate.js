// scripts/test_sprint5_debate.js — Sprint 5 · Phase 5A Verification
// Multi-Agent Debate & Inter-Agent Collaboration.
const {
  runDebate,
  selectParticipants,
  detectConflict
} = require('../services/agents/DebateOrchestrator');
const { eventBus } = require('../services/cognitive/EventBus');
const { query, getPool } = require('../database');
require('dotenv').config();

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); passed++; }
  else { console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Sprint 5 · Phase 5A — Multi-Agent Debate');
  console.log('═══════════════════════════════════════════════\n');

  // ── Test 1: Peer delegation / participant selection ──
  console.log('▸ Test 1: Peer delegation (participant selection)');
  const financeParticipants = await selectParticipants('Should I invest in Tesla stock given the AI chip race?');
  check('Selects ≥2 participants for a finance goal', financeParticipants.length >= 2, financeParticipants.join(', '));
  check('Finance goal routes to Aurelius', financeParticipants.includes('aurelius'));

  const explicit = await selectParticipants('anything', ['aurelius', 'nova']);
  check('Honors explicit participant list', explicit.includes('aurelius') && explicit.includes('nova'), explicit.join(', '));

  const vague = await selectParticipants('hello there');
  check('Tops up to ≥2 even for a vague goal', vague.length >= 2, vague.join(', '));

  // ── Test 2: Conflict detection shape ──
  console.log('\n▸ Test 2: Conflict detection');
  const conflictResult = await detectConflict({
    goal: 'Is now a good time to go all-in on crypto?',
    positions: [
      { agentId: 'aurelius', name: 'Aurelius', position: 'Yes — momentum is strong and institutional inflows are rising. Go in now.' },
      { agentId: 'nova', name: 'Nova', position: 'No — on-chain fundamentals are weak and the rally is speculative. Wait.' }
    ]
  });
  check('detectConflict returns a boolean "conflict"', typeof conflictResult.conflict === 'boolean', String(conflictResult.conflict));
  check('detectConflict returns an "axes" array', Array.isArray(conflictResult.axes));
  check('Opposing positions flagged as a conflict', conflictResult.conflict === true);

  // ── Test 3: Full debate WITH conflict → rounds run ──
  console.log('\n▸ Test 3: Full debate on a contested decision');
  const debate = await runDebate({
    goal: 'Should FinChat pivot its entire roadmap to focus only on crypto trading and drop the career and research agents?',
    userId: 'test_sprint5_user',
    participants: ['aurelius', 'nova'],
    maxRounds: 2
  });
  check('Debate has an id', typeof debate.debateId === 'string' && debate.debateId.startsWith('debate_'), debate.debateId);
  check('Debate status completed', debate.status === 'completed');
  check('Two participants recorded', debate.participants.length === 2);
  check('Opening positions present (round 0)', debate.transcript.some(t => t.round === 0));
  check('Consensus text produced', typeof debate.consensus === 'string' && debate.consensus.length > 40,
    `${debate.consensus.length} chars`);
  if (debate.conflictDetected) {
    check('Conflict → debate rounds ran (≥1)', debate.roundsRun >= 1, `rounds=${debate.roundsRun}`);
    check('Transcript includes a rebuttal round', debate.transcript.some(t => t.round >= 1));
  } else {
    console.log(`  ⚠️  No conflict detected by moderator — rounds skipped by design (roundsRun=${debate.roundsRun})`);
  }

  // ── Test 4: Persistence ──
  console.log('\n▸ Test 4: Debate persistence in Postgres');
  const dRes = await query('SELECT * FROM debates WHERE debate_id = $1', [debate.debateId]);
  check('Debate row persisted', dRes.rows.length === 1);
  if (dRes.rows.length === 1) {
    check('Persisted status = completed', dRes.rows[0].status === 'completed');
    check('final_consensus stored', !!dRes.rows[0].final_consensus);
  }
  const aRes = await query('SELECT * FROM debate_arguments WHERE debate_id = $1', [debate.debateId]);
  check('Argument rows persisted', aRes.rows.length >= 2, `${aRes.rows.length} rows`);
  check('Round-0 arguments link to executions',
    aRes.rows.some(r => r.round_number === 0 && r.execution_id));

  // ── Test 5: EventBus pulses ──
  console.log('\n▸ Test 5: EventBus debate pulses');
  const seen = new Set();
  const handlers = {};
  for (const ev of ['debate:started', 'debate:positions_gathered', 'debate:conflict', 'debate:completed']) {
    handlers[ev] = () => seen.add(ev);
    eventBus.on(ev, handlers[ev]);
  }
  await runDebate({
    goal: 'What is a good beginner programming language?',
    userId: 'test_sprint5_user',
    participants: ['nova', 'rasha'],
    maxRounds: 1
  });
  for (const ev of Object.keys(handlers)) eventBus.off(ev, handlers[ev]);
  check('debate:started fired', seen.has('debate:started'));
  check('debate:positions_gathered fired', seen.has('debate:positions_gathered'));
  check('debate:conflict fired', seen.has('debate:conflict'));
  check('debate:completed fired', seen.has('debate:completed'));

  // ── Cleanup ──
  console.log('\n▸ Cleanup');
  await query(`DELETE FROM debate_arguments WHERE debate_id IN (SELECT debate_id FROM debates WHERE user_id = 'test_sprint5_user')`);
  await query(`DELETE FROM debates WHERE user_id = 'test_sprint5_user'`);
  console.log('  ✅ Test debates removed');

  console.log('\n═══════════════════════════════════════════════');
  console.log(`   Results: ✅ ${passed} passed  ❌ ${failed} failed`);
  console.log('═══════════════════════════════════════════════');

  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('❌ Test harness error:', err);
  process.exit(1);
});
