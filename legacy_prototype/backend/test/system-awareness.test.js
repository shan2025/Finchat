// test/system-awareness.test.js — an agent must be able to speak, and the
// supervisor must not claim it can without looking.
//
// Both halves of this file come from one incident. Atlas shipped complete: a
// persona, a config row, tools, a budget, and a delegation rule that routed
// portfolio questions to him. He answered the very first question put to him
// correctly (the execution record has the gold price in it). The user saw
// nothing at all, because routes/aiChat.js stores an agent's reply with
// sender_id 'ATLAS' and messages.sender_id is a foreign key into users — and
// the persona seed in server.js was a hand-written list of the four agents that
// existed when it was written. The question row was already committed when the
// foreign key threw, so the conversation showed a question, no answer, and no
// error anywhere the user could see.
//
// Asked "is atlas working?", the supervisor said "Yes, Atlas is fully
// operational" — reciting its own roster paragraph, because nothing in the
// system let it check.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { personas } = require('../services/personas');
const { TOOLS, listTools, ADMIN_AGENT_ID } = require('../services/cognitive/ToolRegistry');
const { verdictFor } = require('../tools/SystemStatusTool');

const readSource = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// A minimally healthy agent, so each test below changes exactly one thing.
const healthyAgent = (over = {}) => ({
  agentId: 'atlas',
  configured: true,
  canDeliver: true,
  isDirectAddressable: true,
  runs: { total: 5, healthy: 5 },
  failingMissions: 0,
  ...over
});

describe('every persona can deliver a message', () => {
  test('the seed is derived from the roster, not a hand-written list', () => {
    const src = readSource('server.js');
    assert.match(src, /personasToSeed\s*=\s*\[\s*\.\.\.Object\.keys\(personas\)/,
      'server.js must seed identity rows from the persona roster — a literal list ' +
      'goes stale the moment an agent is added, which is exactly how Atlas shipped mute');

    // The specific shape that broke: a hardcoded array of persona ids.
    const hardcoded = src.match(/personasToSeed\s*=\s*\[\s*'/);
    assert.equal(hardcoded, null, 'the seed list must not be written out literally');
  });

  test('the derivation covers every agent the chat route can address', () => {
    // routes/aiChat.js writes the reply as personaId.toUpperCase(); the seed
    // must produce that exact id for every persona, or that agent is mute.
    const seeded = new Set(
      [...Object.keys(personas), 'system'].flatMap(id => [id.toLowerCase(), id.toUpperCase()])
    );
    for (const id of Object.keys(personas)) {
      assert.ok(seeded.has(id.toUpperCase()),
        `"${id}" replies are stored as sender "${id.toUpperCase()}" — that row must be seeded`);
    }
  });

  test('the chat route still stores agent replies under the uppercased id', () => {
    // If this changes, the seed above must change with it.
    const src = readSource('routes/aiChat.js');
    assert.match(src, /personaId\.toUpperCase\(\)/,
      'the seeded identity ids are derived from this — keep them in step');
  });
});

describe('the system_status tool', () => {
  test('is registered and executable', () => {
    assert.ok(TOOLS.system_status, 'must exist in the registry, or the supervisor is never offered it');
    const impl = require('../services/cognitive/ToolManager');
    assert.ok(impl, 'ToolManager must load with the tool wired in');
    assert.match(readSource('services/cognitive/ToolManager.js'),
      /system_status:\s*require\('\.\.\/\.\.\/tools\/SystemStatusTool'\)/,
      'a registry entry with no implementation is a tool that always errors');
  });

  test('is offered to the supervisor', () => {
    const names = listTools({ agentId: ADMIN_AGENT_ID }).map(t => t.name);
    assert.ok(names.includes('system_status'),
      'the agent told to check system health must be able to see the tool');
  });

  test('its description tells the model when to reach for it', () => {
    const d = TOOLS.system_status.description;
    assert.match(d, /working/i, 'must be findable from the user\'s own words');
    assert.match(d, /broken|not from what you remember/i);
  });
});

describe('the health verdict names the real defect', () => {
  test('an agent with no identity row is BROKEN, not healthy', () => {
    const v = verdictFor(healthyAgent({ canDeliver: false }));
    assert.equal(v.status, 'broken',
      'an agent whose replies cannot be stored is broken however well it runs');
    assert.match(v.problems.join(' '), /foreign key/i,
      'the verdict must point at the actual cause, not just say "broken"');
    assert.match(v.problems.join(' '), /ATLAS/,
      'and name the sender id that is missing, so the fix is obvious');
  });

  test('a completed run does not rescue an agent that cannot deliver', () => {
    // Atlas exactly: the execution completed naturally, with a correct answer.
    const v = verdictFor(healthyAgent({ canDeliver: false, runs: { total: 1, healthy: 1 } }));
    assert.equal(v.status, 'broken');
  });

  test('an unconfigured agent is broken', () => {
    assert.equal(verdictFor(healthyAgent({ configured: false })).status, 'broken');
  });

  test('runs that never complete naturally are broken', () => {
    const v = verdictFor(healthyAgent({ runs: { total: 4, healthy: 0 } }));
    assert.equal(v.status, 'broken');
  });

  test('an agent that has never run is "untested", not "healthy"', () => {
    const v = verdictFor(healthyAgent({ runs: { total: 0, healthy: 0 } }));
    assert.equal(v.status, 'untested', 'never having been tried is not evidence of working');
  });

  test('an answer that never reached the chat is degraded, and dated', () => {
    // The repaired state of the Atlas incident: the identity row now exists, so
    // nothing is structurally broken, but the run from before the fix produced
    // an answer the user never saw. Saying "healthy" here would tell the user
    // their missing reply is going to turn up.
    const v = verdictFor(healthyAgent({
      deliveryGap: { lastCompletedRunAt: '2026-09-09T15:45:29Z', detail: 'lost' }
    }));
    assert.equal(v.status, 'degraded', 'a lost answer is not a healthy agent');
    assert.match(v.problems.join(' '), /never reached the chat/i);
    assert.match(v.problems.join(' '), /clears itself/i,
      'must say the flag is historical, or a fixed agent reads as permanently faulty');
  });

  test('softer problems degrade rather than condemn', () => {
    const v = verdictFor(healthyAgent({ failingMissions: 2 }));
    assert.equal(v.status, 'degraded');
    assert.match(v.problems.join(' '), /standing task/i);
  });

  test('a working agent is reported as working', () => {
    assert.equal(verdictFor(healthyAgent()).status, 'healthy');
  });
});

describe('the supervisor checks before it reassures', () => {
  const plato = personas.plato.systemPrompt;

  test('health questions are routed to the tool, not to memory', () => {
    assert.match(plato, /system_status/,
      'Plato must be told the tool exists — it is the only way it can see system state');
    assert.match(plato, /is Atlas working|whether an agent or the system is working/i,
      'the trigger must be phrased the way a user actually asks');
    assert.match(plato, /NEVER answer a health question from the roster above or from memory/i);
  });

  test('the roster is labelled as capability, not as status', () => {
    assert.match(plato, /NOT evidence that any of them is currently working/i,
      'the roster paragraph is what got recited as an all-clear — it must say what it is');
  });

  test('failures must be reported as failures', () => {
    assert.match(plato, /say it is broken/i);
    assert.match(plato, /never soften a failure/i);
    assert.match(plato, /untested/i, 'an agent that has not run must not be called proven');
  });
});
