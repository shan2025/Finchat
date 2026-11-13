// test/finance-disclosure.test.js — the advice disclosure lives once, in the UI;
// the agents give a clear read and never repeat it.
//
// Every finance prompt used to ORDER a "not financial advice — do your own
// research" note on each market view, so answers were hedged paragraph by
// paragraph and the product read as "go and research it yourself". The
// disclosure moved to a fixed line under the chat composer, and the prompts now
// carry one shared rule (MONEY_RULE): commit to a read, never trade, never size
// a position, never pass off past performance as a forecast, add no disclaimers.
//
// Also pinned here: the message ordering that the trust-boundary change made
// fragile — every system message before the first user turn, and back-to-back
// same-role turns merged before any provider sees them.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { personas, MONEY_RULE } = require('../services/personas');
const { buildContext } = require('../services/cognitive/ContextBuilder');
const { mergeAdjacentTurns } = require('../services/inference');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend');
const HEDGE = /not financial advice|do your own research|educational analysis only/i;

describe('the money rule', () => {
  test('every agent that talks about markets carries it', () => {
    for (const id of ['plato', 'aurelius', 'atlas']) {
      assert.ok(personas[id].systemPrompt.includes(MONEY_RULE), `${id} is missing MONEY_RULE`);
    }
  });

  test('it keeps the lines that matter and forbids the hedge', () => {
    assert.match(MONEY_RULE, /never execute, place or route a trade/i);
    assert.match(MONEY_RULE, /never size a position/i);
    assert.match(MONEY_RULE, /buy or sell a specific amount of their own money/i);
    assert.match(MONEY_RULE, /past-performance number as a forecast/i);
    assert.match(MONEY_RULE, /NO DISCLAIMERS IN YOUR ANSWERS/);
    assert.match(MONEY_RULE, /licensed adviser, say honestly that you are not/i);
  });

  test('no persona prompt asks for a disclaimer outside the rule that forbids one', () => {
    for (const [id, p] of Object.entries(personas)) {
      const rest = p.systemPrompt.split(MONEY_RULE).join('');
      // Feynman names the phrases once, in his own "do not add" sentence.
      const withoutBan = rest.replace(/Do not add disclaimers[^.]*\./gi, '');
      assert.ok(!HEDGE.test(withoutBan), `${id} still asks for or contains a hedge`);
      assert.ok(!/must carry|carries a brief/i.test(rest), `${id} still orders a note on every view`);
    }
  });
});

describe('tool outputs', () => {
  test('no tool hands the model a disclaimer to repeat', () => {
    const dir = path.join(BACKEND, 'tools');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!HEDGE.test(src), `${f} still carries a hedge`);
    }
  });

  test('the tool catalogue does not advertise one either', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'services', 'cognitive', 'ToolRegistry.js'), 'utf8');
    assert.ok(!/never financial advice|not-financial-advice note/i.test(src));
  });
});

describe('the disclosure in the UI', () => {
  const chat = fs.readFileSync(path.join(FRONTEND, 'finchat_chat.html'), 'utf8');
  const group = fs.readFileSync(path.join(FRONTEND, 'finchat_groupchat.html'), 'utf8');
  const mobile = fs.readFileSync(path.join(FRONTEND, 'mobile_ui.css'), 'utf8');

  test('chat and group chat both state it', () => {
    assert.match(chat, /id="composerDisclaimer"[^>]*>[^<]*not investment advice/);
    assert.match(group, /id="gcDisclaimer"[^>]*>[^<]*not investment advice/);
  });

  test('it is never hidden — not on phones, not on short screens', () => {
    assert.ok(!/#composerDisclaimer\s*\{[^}]*display:\s*none/.test(chat), 'chat hides it at some size');
    assert.ok(!/#composerDisclaimer\s*\{[^}]*display:\s*none/.test(mobile), 'the phone layout hides it');
  });
});

describe('message ordering for strict providers', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(400)
  }));

  test('every system message precedes the first user or assistant turn', () => {
    const msgs = buildContext({
      goal: 'What moved BTC?', agentName: 'aurelius',
      conversationHistory: long, // long enough to trigger the trimmed-history note
      toolResults: [{ tool: 'news', result: 'headline' }],
      memories: [{ type: 'preference', content: 'short answers' }]
    });
    assert.ok(msgs.some(m => /EARLIER CONVERSATION TRIMMED/.test(m.content)), 'sanity: the note was emitted');
    const firstTurn = msgs.findIndex(m => m.role !== 'system');
    const lateSystem = msgs.slice(firstTurn).find(m => m.role === 'system');
    assert.equal(lateSystem, undefined, `a system message follows a ${msgs[firstTurn].role} turn`);
  });

  test('after merging, roles alternate and nothing is lost', () => {
    const msgs = buildContext({
      goal: 'What moved BTC?', agentName: 'aurelius',
      toolResults: [{ tool: 'news', result: 'HEADLINE_X' }]
    });
    const merged = mergeAdjacentTurns(msgs);
    const turns = merged.filter(m => m.role !== 'system');
    for (let i = 1; i < turns.length; i++) {
      assert.notEqual(turns[i].role, turns[i - 1].role, 'two same-role turns survived the merge');
    }
    const last = merged[merged.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content, /HEADLINE_X/);
    assert.ok(last.content.endsWith('What moved BTC?'), 'the goal still comes last');
  });

  test('mergeAdjacentTurns leaves system messages and alternating turns alone', () => {
    const input = [
      { role: 'system', content: 'a' }, { role: 'system', content: 'b' },
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }
    ];
    assert.deepEqual(mergeAdjacentTurns(input), input);
  });

  test('mergeAdjacentTurns joins multimodal content part by part', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
    const out = mergeAdjacentTurns([
      { role: 'user', content: 'tool data' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, img] }
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].content, [{ type: 'text', text: 'tool data' }, { type: 'text', text: 'what is this?' }, img]);
  });
});
