// test/execution-trace-skins.test.js — every agent is visible on the Agent Map.
//
// Two ways an agent silently disappears from the map and its Profiles panel:
//
//  1. ExecutionTrace's AGENT_SKIN is missing it, so agentMeta() falls back to a
//     generic plate with no avatar. Atlas sat like that on the Performance
//     Profiles table long after atlas_avatar.png existed in the frontend.
//  2. AgentLeaderboard's ROSTER is a hand-written list, so a new persona never
//     reaches Ranks or Profiles at all. Feynman and Hopper were invisible there
//     from the day they shipped.
//
// Both are cosmetic-looking bugs that make the system misreport who is working,
// so they are asserted rather than eyeballed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { personas } = require('../services/personas');
const { agentMeta } = require('../services/cognitive/ExecutionTrace');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

test('every persona has a colour and an avatar on the map', () => {
  for (const id of Object.keys(personas)) {
    const m = agentMeta(id);
    assert.equal(m.name, personas[id].name, `${id}: name must come from the persona roster`);
    assert.match(m.color, /^#[0-9a-f]{6}$/i, `${id}: needs a plate colour in AGENT_SKIN`);
    assert.ok(m.avatar, `${id}: needs an avatar in AGENT_SKIN — otherwise it renders as an anonymous plate`);
  }
});

test('each avatar file actually exists in the frontend', () => {
  for (const id of Object.keys(personas)) {
    const file = path.join(FRONTEND, agentMeta(id).avatar);
    assert.ok(fs.existsSync(file), `${id}: ${agentMeta(id).avatar} is not in frontend/ — it would 404 on every frame`);
  }
});

test('plates are distinguishable — no two agents share a colour', () => {
  const seen = new Map();
  for (const id of Object.keys(personas)) {
    const c = agentMeta(id).color.toLowerCase();
    assert.ok(!seen.has(c), `${id} and ${seen.get(c)} share the plate colour ${c}`);
    seen.set(c, id);
  }
});

test('the leaderboard roster is derived from personas, not hand-written', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'AgentLeaderboard.js'), 'utf8');
  assert.match(src, /const ROSTER = new Set\(Object\.keys\(personas\)\)/,
    'ROSTER must come from the persona roster — a literal list goes stale the next time an agent ships');
});

test('the map frontend knows every agent colour', () => {
  const html = fs.readFileSync(path.join(FRONTEND, 'finchat_brainmodel.html'), 'utf8');
  const line = html.split('\n').find(l => l.includes('var AGENT_COLORS'));
  assert.ok(line, 'finchat_brainmodel.html must still define AGENT_COLORS');
  for (const id of Object.keys(personas)) {
    assert.ok(line.includes(id + ':'), `AGENT_COLORS is missing ${id} — it will plate in the wrong colour`);
    assert.ok(line.toLowerCase().includes(agentMeta(id).color.toLowerCase()),
      `AGENT_COLORS has drifted from AGENT_SKIN for ${id}`);
  }
});
