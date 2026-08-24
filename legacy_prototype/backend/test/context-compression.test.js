// test/context-compression.test.js — the prompt must not re-send what the model
// no longer needs.
//
// A verified 2-turn run charged 6,860 prompt tokens to produce 1,133 of output
// (migration 031's split made this visible). Measured per block, the cause was
// the tool catalogue: 18 tools with full parameter schemas, ~1,744 tokens,
// rebuilt on EVERY iteration. On a first turn it was 99.7% of the whole request
// against a 10-token question.
//
// These tests pin the two reductions and the KPI that measures them. They do
// NOT assert absolute sizes — the catalogue legitimately changes as tools are
// added — only the properties that must hold.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  buildContext, packHistory, buildToolDescriptions, HISTORY_BUDGET_CHARS
} = require('../services/cognitive/ContextBuilder');

const systemText = (msgs) => msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');

describe('prompt prefix stability', () => {
  // The property that makes provider-side prefix caching possible at all.
  // DeepSeek served 1,920 of 1,933 prompt tokens from cache on a repeated
  // prefix; a prefix that changes between turns can never hit. An earlier
  // version rendered the catalogue full on turn one and compact once results
  // arrived, which saved ~366 tokens and forfeited a cache hit worth more.
  const first = (msgs) => msgs.find(m => m.role === 'system').content;

  test('the first system message is byte-identical across turns of a run', () => {
    const turn1 = buildContext({ goal: 'find me jobs', agentName: 'rasha' });
    const turn2 = buildContext({
      goal: 'find me jobs', agentName: 'rasha',
      toolResults: [{ tool: 'jobs', result: 'some listings' }]
    });
    const turn3 = buildContext({
      goal: 'find me jobs', agentName: 'rasha',
      toolResults: [{ tool: 'jobs', result: 'some listings' }, { tool: 'search', result: 'more' }],
      conversationHistory: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
      memories: [{ type: 'preference', content: 'remote only' }]
    });

    assert.equal(first(turn2), first(turn1),
      'arriving tool results must not perturb the cached prefix');
    assert.equal(first(turn3), first(turn1),
      'nor may memories or conversation history');
  });

  test('volatile content sits after the prefix, never inside it', () => {
    const msgs = buildContext({
      goal: 'find me jobs', agentName: 'rasha',
      toolResults: [{ tool: 'jobs', result: 'VOLATILE_RESULT' }],
      memories: [{ type: 'x', content: 'VOLATILE_MEMORY' }]
    });
    assert.ok(!first(msgs).includes('VOLATILE_RESULT'));
    assert.ok(!first(msgs).includes('VOLATILE_MEMORY'));
    assert.match(systemText(msgs), /VOLATILE_RESULT/, 'still present, just later');
  });

  test('the catalogue rendering is a run-level policy, not a per-turn decision', () => {
    // Whichever mode is configured, every turn must render the same way.
    const withResults = buildContext({
      goal: 'g', agentName: 'rasha', toolResults: [{ tool: 'jobs', result: 'x' }]
    });
    const without = buildContext({ goal: 'g', agentName: 'rasha' });
    assert.equal(/Parameters:/.test(systemText(withResults)),
      /Parameters:/.test(systemText(without)),
      'schemas must not appear on one turn and vanish on the next');
  });
});

describe('tool catalogue compaction', () => {
  test('compaction never hides a tool, only its schema', () => {
    // Dropping a tool entirely would make the one legitimate exception — the
    // goal genuinely needs a tool that has not run yet — unreachable.
    const full = buildToolDescriptions(true, 'rasha', { compact: false });
    const compact = buildToolDescriptions(true, 'rasha', { compact: true });
    const names = [...full.matchAll(/- "([a-z_]+)":/g)].map(m => m[1]);
    assert.ok(names.length > 0, 'sanity: the fixture agent has tools');
    for (const n of names) {
      assert.ok(compact.includes(`"${n}"`), `compact form must still name "${n}"`);
    }
    assert.ok(compact.length < full.length, 'compaction must actually save something');
  });

  test('an oversized catalogue compacts itself, a scoped one does not', () => {
    // A scoped agent's catalogue is small; it keeps full parameter schemas,
    // which is what makes the prefix worth caching. A caller that gets the
    // WHOLE catalogue (the orchestrator, or an agent with no configured tools)
    // is the case that pushed a request past the size a provider has already
    // 413'd — there, compact beats accurate-but-rejected.
    const scoped = buildContext({
      goal: 'g', agentName: 'rasha',
      agentTools: ['search', 'resume', 'jobs', 'fetch', 'apply_draft', 'mission', 'applications']
    });
    const unscoped = buildContext({ goal: 'g', agentName: 'plato' });
    assert.match(systemText(scoped), /\| Parameters:/, 'a scoped catalogue keeps its schemas');
    assert.match(systemText(unscoped), /short form/, 'the full catalogue falls back to compact');
  });

  test('a breached budget keeps its own restricted schema, tools and all', () => {
    const msgs = buildContext({
      goal: 'g', agentName: 'rasha', budgetExceeded: true,
      toolResults: [{ tool: 'jobs', result: 'x' }]
    });
    const sys = systemText(msgs);
    assert.match(sys, /NOT allowed to use tools/);
    assert.ok(!/AVAILABLE TOOLS/.test(sys), 'the wrap-up turn needs no catalogue at all');
  });
});

describe('conversation history budget', () => {
  const turns = (n, size) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `m${i}:${'x'.repeat(size)}`
  }));

  test('keeps the most recent turns, not the oldest', () => {
    // The tail is what the current question refers back to; the head is usually
    // a topic the user has moved on from.
    const { kept, dropped } = packHistory(turns(40, 500), 4000);
    assert.ok(dropped > 0, 'sanity: this fixture must exceed the budget');
    assert.equal(kept[kept.length - 1].content.slice(0, 4), 'm39:');
  });

  test('stays within the budget', () => {
    const { kept } = packHistory(turns(40, 500), 4000);
    const used = kept.reduce((n, m) => n + m.content.length, 0);
    assert.ok(used <= 4000, `kept ${used} chars against a 4000 budget`);
  });

  test('one oversized message is still kept rather than leaving no context', () => {
    const { kept } = packHistory([{ role: 'user', content: 'x'.repeat(50000) }], 4000);
    assert.equal(kept.length, 1);
  });

  test('a trimmed window is declared, not silently narrowed', () => {
    // Without this the model reads the oldest kept turn as the start of the
    // conversation and can contradict something it agreed to earlier.
    const msgs = buildContext({
      goal: 'g', agentName: 'rasha',
      conversationHistory: turns(400, HISTORY_BUDGET_CHARS)
    });
    assert.match(systemText(msgs), /EARLIER CONVERSATION TRIMMED/);
  });

  test('short conversations are passed through whole and unannounced', () => {
    const msgs = buildContext({
      goal: 'g', agentName: 'rasha', conversationHistory: turns(4, 50)
    });
    assert.ok(!/EARLIER CONVERSATION TRIMMED/.test(systemText(msgs)));
    assert.equal(msgs.filter(m => m.role === 'assistant').length, 2);
  });
});

describe('per-agent tool scoping', () => {
  // The lists live in agent_configs.tools and were curated long ago; nothing
  // consulted them, so every agent advertised all 18 research tools on every
  // turn — a careers agent carrying forex and commodities schemas.
  const RASHA_TOOLS = ['search', 'resume', 'jobs', 'fetch', 'apply_draft'];

  test('an agent is shown its own domain and not everyone else\'s', () => {
    const scoped = buildToolDescriptions(true, 'rasha', { agentTools: RASHA_TOOLS });
    for (const t of ['jobs', 'resume', 'apply_draft']) {
      assert.ok(scoped.includes(`"${t}"`), `rasha must keep "${t}"`);
    }
    for (const t of ['forex', 'commodities', 'crypto', 'stocks', 'watchlist']) {
      assert.ok(!scoped.includes(`"${t}"`), `rasha should not carry "${t}" schemas`);
    }
  });

  test('scoping actually shrinks the block', () => {
    const full = buildToolDescriptions(true, 'rasha', { agentTools: null });
    const scoped = buildToolDescriptions(true, 'rasha', { agentTools: RASHA_TOOLS });
    assert.ok(scoped.length < full.length * 0.75,
      `expected a substantial cut, got ${full.length} → ${scoped.length}`);
  });

  test('the verification tools survive any scoping', () => {
    // The RULES block orders the model to verify named things with wikipedia or
    // search. Scoping either away would command a tool never shown.
    const scoped = buildToolDescriptions(true, 'aurelius', { agentTools: ['stocks'] });
    assert.ok(scoped.includes('"wikipedia"'));
    assert.ok(scoped.includes('"search"'));
  });

  test('the orchestrator is never scoped', () => {
    // Plato's own row lists only ["search"], but it is the fallback for every
    // goal no specialist matched, so restricting it breaks its whole purpose.
    const plato = buildToolDescriptions(true, 'plato', { agentTools: ['search'] });
    for (const t of ['jobs', 'stocks', 'paper', 'crypto']) {
      assert.ok(plato.includes(`"${t}"`), `plato must keep "${t}"`);
    }
  });

  test('an unconfigured agent keeps everything rather than losing everything', () => {
    // Empty and "not configured" are indistinguishable in the data; guessing
    // toward "none" would silently strip an agent of every capability.
    const empty = buildToolDescriptions(true, 'memory', { agentTools: [] });
    const none = buildToolDescriptions(true, 'memory', { agentTools: null });
    assert.equal(empty, none);
    assert.ok(empty.includes('"search"'));
  });
});

// A scoped agent's real manifest. Production always passes one (CognitiveCore
// reads agent_configs.tools), and it matters here: without it the build gets the
// whole catalogue, which is now large enough to trip the size-based compaction
// in ContextBuilder — so these fixtures would measure that instead of the
// trimming they exist to pin.
const RASHA_TOOLS = ['search', 'resume', 'jobs', 'fetch', 'apply_draft', 'mission', 'applications'];

describe('the savings KPI', () => {
  test('reports nothing saved when nothing was trimmed', () => {
    const stats = {};
    buildContext({ goal: 'g', agentName: 'rasha', agentTools: RASHA_TOOLS, stats });
    assert.equal(stats.charsSaved, 0);
    assert.ok(stats.chars > 0);
  });

  test('counts dropped history separately from the catalogue', () => {
    const stats = {};
    const long = Array.from({ length: 300 },
      () => ({ role: 'user', content: 'y'.repeat(500) }));
    const msgs = buildContext({ goal: 'g', agentName: 'rasha', agentTools: RASHA_TOOLS, conversationHistory: long, stats });

    assert.ok(stats.historyCharsSaved > 0, 'this fixture is far over the history budget');
    assert.equal(stats.toolCatalogueCharsSaved, 0, 'no tool results, so no catalogue saving');

    // Every turn is either kept or counted as dropped — none may vanish unnoticed.
    const keptTurns = msgs.filter(m => m.role === 'assistant' || (m.role === 'user' && m.content.startsWith('y'))).length;
    assert.equal(keptTurns + stats.droppedTurns, 300);
    assert.equal(stats.charsSaved, stats.toolCatalogueCharsSaved + stats.historyCharsSaved);
  });
});
