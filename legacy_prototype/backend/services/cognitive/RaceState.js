// services/cognitive/RaceState.js — ephemeral, in-memory live state for a
// multi-agent race so the competing lanes (all running in this one process) can
// see each other's progress WHILE they run. Contest-awareness is a live-only
// signal — it is never persisted and needs no table. Old races auto-expire.
//
// The signals compared are the ones we can measure live and honestly:
//   evidence = distinct sources gathered so far (extractSources length)
//   fuel     = tokens spent so far
// Confidence is only known after reflection, so we do NOT fake a live % — the
// contest note frames an economic decision (more evidence vs. more fuel), not a
// "beat X" order.

const races = new Map(); // raceId -> { createdAt, lanes: Map(executionId -> lane) }
const TTL_MS = 10 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, r] of races) if (now - r.createdAt > TTL_MS) races.delete(id);
}

const cap = (s) => String(s || '').replace(/\b\w/g, c => c.toUpperCase());

/** Enrol a lane in a race. Idempotent. */
function register(raceId, executionId, agentId) {
  if (!raceId || !executionId) return;
  gc();
  let r = races.get(raceId);
  if (!r) { r = { createdAt: Date.now(), lanes: new Map() }; races.set(raceId, r); }
  if (!r.lanes.has(executionId)) {
    r.lanes.set(executionId, { executionId, agentId, evidence: 0, fuel: 0, turn: 0, done: false, districts: [], updatedAt: Date.now() });
  }
}

/** Update a lane's live progress. `districts` (if given) REPLACES the lane's
 *  covered-district list — the caller passes the full current set each turn. */
function update(raceId, executionId, patch = {}) {
  const r = races.get(raceId); if (!r) return;
  const l = r.lanes.get(executionId); if (!l) return;
  Object.assign(l, patch, { updatedAt: Date.now() });
}

/** Distinct knowledge districts every OTHER lane has already grounded evidence
 *  in — the live-coverage signal that pushes a lane toward complementary ground
 *  instead of duplicating a rival's sources. */
function rivalCoveredDistricts(raceId, executionId) {
  const r = races.get(raceId); if (!r) return [];
  const out = new Set();
  for (const l of r.lanes.values()) {
    if (l.executionId === executionId) continue;
    for (const d of (l.districts || [])) out.add(d);
  }
  return [...out];
}

/** Ranked standings: most evidence first, then least fuel. */
function standings(raceId) {
  const r = races.get(raceId); if (!r) return [];
  const lanes = [...r.lanes.values()];
  lanes.sort((a, b) => b.evidence - a.evidence || a.fuel - b.fuel);
  return lanes.map((l, i) => ({ ...l, position: i + 1 }));
}

/**
 * Build the structured contest note for one lane, or null when there is no
 * meaningful competition yet (fewer than 2 lanes, or no rival has produced
 * anything). PURE over the current state — unit-tested.
 *
 * @param {string} raceId
 * @param {string} executionId - the lane the note is for
 * @param {object} [opts]
 * @param {number|null} [opts.budgetRemainingTokens]
 */
function contestNote(raceId, executionId, { budgetRemainingTokens = null } = {}) {
  const all = standings(raceId);
  if (all.length < 2) return null;
  const me = all.find(l => l.executionId === executionId);
  if (!me) return null;
  const others = all.filter(l => l.executionId !== executionId);
  if (!others.some(o => o.evidence > 0 || o.fuel > 0)) return null; // nothing to compare against yet

  const leader = all[0];
  const iAmLeader = leader.executionId === executionId;
  const lines = [];
  lines.push(`--- LIVE RACE STATUS (you are ${cap(me.agentId)}, position ${me.position} of ${all.length}) ---`);
  for (const l of all) {
    const tag = l.executionId === executionId ? ' ← you' : (l === leader ? ' (leader)' : '');
    lines.push(`- ${cap(l.agentId)}: ${l.evidence} source${l.evidence === 1 ? '' : 's'}, ${(l.fuel / 1000).toFixed(1)}k fuel${l.done ? ' [answered]' : ''}${tag}`);
  }
  if (iAmLeader) {
    lines.push('You lead on evidence.');
  } else {
    const gap = leader.evidence - me.evidence;
    lines.push(gap > 0
      ? `Gap to leader: ${gap} source${gap === 1 ? '' : 's'} behind.`
      : `Gap to leader: level on sources, ${((me.fuel - leader.fuel) / 1000).toFixed(1)}k more fuel spent.`);
  }
  const budgetLine = budgetRemainingTokens != null ? ` Your remaining fuel budget: ${(budgetRemainingTokens / 1000).toFixed(1)}k.` : '';
  lines.push(`One more source costs roughly 300–500 tokens.${budgetLine}`);
  lines.push('Decide economically: gather more evidence ONLY if it would materially strengthen your answer and you can afford the fuel. If your answer is already well-supported, synthesize and respond now — a faster, well-sourced answer beats a slower padded one. Do NOT gather sources just to outnumber a rival.');
  return lines.join('\n');
}

function clear(raceId) { races.delete(raceId); }

module.exports = { register, update, standings, contestNote, rivalCoveredDistricts, clear, _races: races };
