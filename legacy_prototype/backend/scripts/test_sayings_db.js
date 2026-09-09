// Exercises Sayings against the real database: the never-repeat ledger, the
// seed pool, learning from a source-backed run, and topical recall. Creates a
// throwaway user and removes everything it wrote.

const { query } = require('../database');
const Sayings = require('../services/Sayings');

const USER = `test_sayings_${Date.now()}`;

async function main() {
  await query(
    `INSERT INTO users (user_id, email, name, password_hash)
     VALUES ($1, $2, 'Sayings Test', 'x') ON CONFLICT DO NOTHING`,
    [USER, `${USER}@example.invalid`]
  );

  // ── never repeat ────────────────────────────────────────────
  const seen = new Set();
  let nulls = 0;
  for (let i = 0; i < 14; i++) {
    const s = await Sayings.pickSaying({ agentId: 'aurelius', userId: USER });
    if (!s) { nulls++; continue; }
    if (seen.has(s.saying_id)) throw new Error(`REPEAT: ${s.saying_id}`);
    seen.add(s.saying_id);
  }
  console.log(`never-repeat: ${seen.size} distinct seeds drawn, then ${nulls} exhausted picks (no repeats)`);
  if (seen.size !== 10) throw new Error(`expected 10 aurelius seeds, got ${seen.size}`);
  if (nulls !== 4) throw new Error(`expected 4 exhausted picks, got ${nulls}`);

  // ── pools are per-agent ─────────────────────────────────────
  const nova = await Sayings.pickSaying({ agentId: 'nova', userId: USER });
  console.log(`per-agent: nova still has lines -> ${Sayings.formatSaying(nova)}`);
  if (!nova) throw new Error('nova pool should be untouched');

  // ── learning from a real run ────────────────────────────────
  const learned = await Sayings.learnFromRun({
    agentId: 'aurelius',
    userId: USER,
    goal: 'what is the Federal Reserve doing with interest rates',
    response: 'Here is what I found. The Federal Reserve held its benchmark rate at 4.25% for a third meeting, citing services inflation that has not cooled.',
    sources: [{ tool: 'news', title: 'Fed holds rates steady', url: 'https://example.com/fed', verified: true }]
  });
  console.log(`learned: ${learned ? learned.saying_id : 'NOTHING'}`);
  if (!learned) throw new Error('should have learned a line');

  // ── no source, no learning ──────────────────────────────────
  const unsourced = await Sayings.learnFromRun({
    agentId: 'aurelius', userId: USER,
    goal: 'rates again',
    response: 'The Federal Reserve held its benchmark rate at 4.25% for a third consecutive meeting this year.',
    sources: []
  });
  console.log(`unsourced run learned nothing: ${unsourced === null}`);
  if (unsourced !== null) throw new Error('must not learn without a verified source');

  // ── topical recall ──────────────────────────────────────────
  const recall = await Sayings.pickSaying({
    agentId: 'aurelius', userId: USER,
    topic: 'any update on federal reserve rate policy?'
  });
  console.log(`topical recall: ${Sayings.formatSaying(recall)}`);
  if (!recall || recall.origin !== 'learned') throw new Error('should recall the learned line on topic');

  // and never twice
  const again = await Sayings.pickSaying({
    agentId: 'aurelius', userId: USER, topic: 'federal reserve rate policy'
  });
  console.log(`topical recall does not repeat: ${again === null}`);
  if (again !== null) throw new Error('learned line repeated');

  // ── an unrelated topic must not match ───────────────────────
  await Sayings.learnFromRun({
    agentId: 'nova', userId: USER,
    goal: 'progress in fusion energy confinement',
    response: 'The reactor sustained a plasma for 1,066 seconds, roughly triple the previous record set in 2025.',
    sources: [{ tool: 'paper', title: 'Fusion record', url: 'https://example.com/fusion', verified: true }]
  });
  const mismatch = await Sayings.pickSaying({
    agentId: 'nova', userId: USER, topic: 'how do I bake sourdough bread'
  });
  console.log(`off-topic question recalls nothing: ${mismatch === null}`);
  if (mismatch !== null) throw new Error('irrelevant recall');

  console.log('\nALL DB CHECKS PASSED');
}

main()
  .catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(async () => {
    await query('DELETE FROM agent_sayings WHERE user_id = $1', [USER]).catch(() => {});
    await query('DELETE FROM agent_saying_shown WHERE user_id = $1', [USER]).catch(() => {});
    await query('DELETE FROM users WHERE user_id = $1', [USER]).catch(() => {});
    require('../database').destroyPool?.();
    process.exit(process.exitCode || 0);
  });
