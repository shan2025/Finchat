// Sprint Z · Track B — Study Mode block contract.
//   1. Parser: well-formed, malformed, multiple blocks per fence, unknown type,
//      empty arrays, nested fences, prose interleaving.
//   2. XSS: markup injected into any block field must come out escaped.
//   3. Directive: STUDY_MODE_DIRECTIVE reaches the system prompt only when on.
//   4. Live Groq round-trip: the model can actually produce valid JSON for
//      every one of the nine types (skipped with --no-llm).
//
// Run: node scripts/test_study_blocks.js  [--no-llm]

const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });

const StudyBlocks = require(B + '/../frontend/study_blocks.js');
const { buildContext } = require(B + '/services/cognitive/ContextBuilder');
const { withStudyBlocks } = require(B + '/services/cognitive/CognitiveCore');
const { STUDY_MODE_DIRECTIVE } = require(B + '/services/personas');

const SKIP_LLM = process.argv.includes('--no-llm');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

const fence = (json) => '```studyblock\n' + json + '\n```';

(async () => {
  // ── 1. Parser ────────────────────────────────────────────────────
  console.log('\n=== 1. Parser ===');

  const card = { type: 'card', title: 'Forward Pull', kicker: 'END ON TENSION', body: 'Close on an open loop.', howToUse: ['End on tension'], usefulFor: 'Scripts' };
  const segs = StudyBlocks.parse('Intro line.\n\n' + fence(JSON.stringify(card)) + '\n\nOutro line.');
  ok(segs.length === 3, 'prose / block / prose split into 3 segments (got ' + segs.length + ')');
  ok(segs[0].kind === 'prose' && segs[0].text.includes('Intro'), 'leading prose preserved');
  ok(segs[1].kind === 'block' && segs[1].block.title === 'Forward Pull', 'block parsed with its fields');
  ok(segs[2].kind === 'prose' && segs[2].text.includes('Outro'), 'trailing prose preserved');

  ok(StudyBlocks.has(fence('{"type":"card"}')), 'has() detects a fence');
  ok(!StudyBlocks.has('plain markdown with a ```js\ncode()\n``` block'), 'has() ignores ordinary code fences');

  const multi = StudyBlocks.parse(fence('{"type":"card","title":"A"}\n{"type":"note","body":"B"}'));
  ok(multi.filter(s => s.kind === 'block').length === 2, 'two objects in one fence both parse');

  const asArray = StudyBlocks.parse(fence('[{"type":"card","title":"A"},{"type":"card","title":"B"}]'));
  ok(asArray.filter(s => s.kind === 'block').length === 2, 'a JSON array in one fence parses');

  const broken = StudyBlocks.parse(fence('{"type":"card", "title": unquoted}'));
  ok(broken.length === 1 && broken[0].kind === 'fallback', 'malformed JSON degrades to fallback, not a throw');
  ok(StudyBlocks.renderToHTML(fence('{"type":"card", oops}')).includes('sb-fallback'),
    'fallback renders as a visible raw block');

  const unknown = StudyBlocks.renderToHTML(fence('{"type":"hologram","title":"X"}'));
  ok(unknown.includes('sb-fallback') && unknown.includes('Unrecognised'), 'unknown type degrades, content not dropped');

  const empties = StudyBlocks.renderToHTML(fence(JSON.stringify({ type: 'card', title: 'T', howToUse: [], usefulFor: '' })));
  ok(empties.includes('sb-card') && !empties.includes('How to use it'), 'empty arrays/strings are omitted, not rendered blank');

  const noFence = StudyBlocks.parse('just prose, no blocks at all');
  ok(noFence.length === 1 && noFence[0].kind === 'prose', 'a message with no blocks is a single prose segment');

  const nested = StudyBlocks.parse('```studyblock\n{"type":"note","body":"see the docs"}\n```\n\n```js\nconst a = 1;\n```');
  ok(nested.filter(s => s.kind === 'block').length === 1 && nested.some(s => s.kind === 'prose' && s.text.includes('const a')),
    'a normal code fence after a study fence stays prose');

  // ── 1b. Unfenced / mis-fenced output ─────────────────────────────
  // Observed live: the model produced a flawless card object but emitted it
  // bare, with no fence. Without a rescue the user would see raw JSON.
  console.log('\n=== 1b. Fence rescue ===');
  const bare = JSON.stringify({ type: 'card', title: 'Bond Duration', kicker: 'RATE SENSITIVITY', body: 'How much a price moves.' });
  ok(StudyBlocks.has(bare), 'has() detects a bare, unfenced block');
  const bareSegs = StudyBlocks.parse(bare).filter(s => s.kind === 'block');
  ok(bareSegs.length === 1 && bareSegs[0].block.title === 'Bond Duration', 'bare block is promoted and parsed');
  ok(StudyBlocks.renderToHTML(bare).includes('sb-card'), 'bare block renders as a card, not raw JSON');

  const mixed = StudyBlocks.parse('Here is the idea.\n' + bare + '\nThat is the shape of it.');
  ok(mixed.filter(s => s.kind === 'block').length === 1, 'a bare block surrounded by prose is promoted');
  ok(mixed.filter(s => s.kind === 'prose' && s.text.trim()).length === 2, 'the prose around a bare block survives');

  const jsonFence = StudyBlocks.parse('```json\n' + bare + '\n```');
  ok(jsonFence.filter(s => s.kind === 'block').length === 1, 'a ```json fence holding a block is treated as studyblock');
  ok(!StudyBlocks.renderToHTML('```json\n' + bare + '\n```').includes('```'), 'no orphaned backticks left behind');

  // The type check is the guard: unrelated JSON must NOT become a card.
  const foreign = '```json\n{"ticker":"TSLA","price":412.5,"type":"equity"}\n```';
  ok(!StudyBlocks.has(foreign), 'JSON with a foreign "type" is not hijacked into a card');
  ok(!StudyBlocks.has('{"name":"config","values":[1,2,3]}'), 'JSON with no "type" is left alone');
  ok(!StudyBlocks.has('The card type is useful for chunking.'), 'prose mentioning a type name is not misread');

  // Every declared type renders without throwing
  const samples = {
    card: { type: 'card', title: 'T', kicker: 'K', body: 'B', howToUse: ['x'], usefulFor: 'y' },
    flow: { type: 'flow', title: 'T', steps: ['Hook', 'Mini answer', 'Twist'], caption: 'c' },
    compare: { type: 'compare', title: 'T', left: { label: 'Low stakes', text: 'a' }, right: { label: 'High stakes', text: 'b' } },
    steps: { type: 'steps', title: 'T', steps: [{ label: 'One', text: 'do it' }, { label: 'Two', text: 'then this' }] },
    note: { type: 'note', title: 'The twist', body: 'short aside' },
    keyterms: { type: 'keyterms', title: 'T', terms: [{ term: 'Duration', definition: 'price sensitivity' }] },
    formula: { type: 'formula', title: 'T', expression: 'PV = FV / (1+r)^n', legend: [{ symbol: 'r', meaning: 'rate' }] },
    checkpoint: { type: 'checkpoint', questions: [{ question: 'Why?', answer: 'Because.' }] },
    takeaway: { type: 'takeaway', title: 'T', body: 'B', points: ['p'] }
  };
  for (const [type, block] of Object.entries(samples)) {
    let html = '';
    try { html = StudyBlocks.renderToHTML(fence(JSON.stringify(block))); } catch (e) { html = 'THREW: ' + e.message; }
    ok(html.includes('sb-block') && !html.includes('sb-fallback'), `renders "${type}" without falling back`);
  }

  ok(StudyBlocks.BLOCK_TYPES.length === 9, 'exactly nine block types in v1');

  // toText — the Save-to-Knowledge path
  const flat = StudyBlocks.toText(fence(JSON.stringify(samples.card)) + '\n' + fence(JSON.stringify(samples.checkpoint)));
  ok(flat.includes('Forward') === false && flat.includes('## T') && flat.includes('Q: Why?') && flat.includes('A: Because.'),
    'toText() flattens blocks to prose for the knowledge pipeline');
  ok(!/[{}"]/.test(flat.replace(/[^{}"]/g, '')), 'toText() output carries no JSON punctuation');

  // ── 2. XSS ───────────────────────────────────────────────────────
  console.log('\n=== 2. Injection ===');
  const nasty = '<img src=x onerror=alert(1)><script>alert(2)</' + 'script>';
  const evil = StudyBlocks.renderToHTML(fence(JSON.stringify({
    type: 'card', title: nasty, kicker: nasty, body: nasty, howToUse: [nasty], usefulFor: nasty
  })));
  ok(!/<img/i.test(evil), 'injected <img> is escaped in every field');
  ok(!/<script/i.test(evil), 'injected <script> is escaped');
  // The payload must survive as ONE escaped text run — that proves the handler
  // is inert text rather than a real attribute.
  ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;'), 'inline handler survives only as escaped text, never as an attribute');
  ok(evil.includes('&lt;img'), 'the payload is still visible to the user, just inert');

  const evilTerm = StudyBlocks.renderToHTML(fence(JSON.stringify({
    type: 'keyterms', terms: [{ term: '"><script>x</' + 'script>', definition: nasty }]
  })));
  ok(!/<script/i.test(evilTerm), 'no live <script> in a key-term chip');
  ok(evilTerm.includes('&quot;&gt;&lt;script&gt;'), 'attribute-breaking quote in a term is escaped, so data-sb-term stays intact');

  const evilFallback = StudyBlocks.renderToHTML(fence('{bad json ' + nasty + '}'));
  ok(!/<img/i.test(evilFallback), 'the fallback path escapes raw output too');

  // ── 3. Directive plumbing ────────────────────────────────────────
  console.log('\n=== 3. Directive ===');
  const off = buildContext({ goal: 'explain duration', agentName: 'aurelius' });
  const on = buildContext({ goal: 'explain duration', agentName: 'aurelius', studyMode: true });
  ok(!off[0].content.includes('STUDY MODE (ACTIVE)'), 'directive absent when studyMode is off');
  ok(on[0].content.includes('STUDY MODE (ACTIVE)'), 'directive present when studyMode is on');
  ok(on[0].content.includes('"blocks" array') || on[0].content.includes('"blocks"'),
    'the block grammar reaches the system prompt');
  ok(!on[0].content.includes('```studyblock'),
    'the model is never asked to emit a fence — fences are added server-side');
  ok(on[0].content.includes('Aurelius'), 'the persona survives — Study Mode is a format, not an agent swap');
  for (const t of StudyBlocks.BLOCK_TYPES) {
    if (!STUDY_MODE_DIRECTIVE.includes(t)) ok(false, `directive documents the "${t}" type`);
  }
  ok(StudyBlocks.BLOCK_TYPES.every(t => STUDY_MODE_DIRECTIVE.includes(t)), 'directive documents all nine types');

  // ── 3b. Sibling-array serialisation ──────────────────────────────
  // Blocks travel as real objects next to `response`, never nested inside it,
  // so the model never double-escapes. CognitiveCore folds them into fences.
  console.log('\n=== 3b. blocks[] serialisation ===');
  ok(on[0].content.includes('"blocks"'), 'the action schema advertises the blocks field in Study Mode');
  ok(!off[0].content.includes('"blocks"'), 'the blocks field is not advertised when Study Mode is off');

  const folded = withStudyBlocks({
    action: 'respond', response: 'Here is the shape of it.',
    blocks: [samples.card, samples.checkpoint]
  });
  ok(folded.startsWith('Here is the shape of it.'), 'the prose response survives the fold');
  const foldedBlocks = StudyBlocks.parse(folded).filter(s => s.kind === 'block');
  ok(foldedBlocks.length === 2, 'both blocks come back out of the fold');
  ok(foldedBlocks[0].block.type === 'card' && foldedBlocks[1].block.type === 'checkpoint', 'block order is preserved');

  ok(withStudyBlocks({ action: 'respond', response: 'plain answer' }) === 'plain answer',
    'an answer with no blocks is returned untouched');
  ok(withStudyBlocks({ action: 'respond', response: 'plain', blocks: [] }) === 'plain',
    'an empty blocks array is a no-op');

  // Quotes and newlines are exactly what broke the nested design.
  const quoted = withStudyBlocks({
    action: 'respond', response: 'x',
    blocks: [{ type: 'note', title: 'He said "duration"', body: 'line one\nline two — with "quotes"' }]
  });
  const quotedOut = StudyBlocks.parse(quoted).filter(s => s.kind === 'block')[0];
  ok(quotedOut && quotedOut.block.title === 'He said "duration"', 'quotes in a field survive the round trip');
  ok(quotedOut && quotedOut.block.body.includes('\n'), 'newlines in a field survive the round trip');

  // The parser's job is to keep the answer even when a block is junk.
  const mixedFold = withStudyBlocks({ action: 'respond', response: 'answer', blocks: [samples.card] });
  ok(mixedFold.includes('```studyblock'), 'blocks are folded into studyblock fences, the frontend contract');

  // ReasoningEngine drops malformed blocks rather than failing the whole turn.
  const { parseActionResponse } = require(B + '/services/cognitive/ReasoningEngine');
  const goodParse = parseActionResponse(JSON.stringify({
    thought: 't', action: 'respond', response: 'r', blocks: [samples.card]
  }));
  ok(goodParse.valid && Array.isArray(goodParse.parsed.blocks) && goodParse.parsed.blocks.length === 1,
    'parseActionResponse preserves a valid blocks array');
  const junkParse = parseActionResponse(JSON.stringify({
    thought: 't', action: 'respond', response: 'r', blocks: 'not an array'
  }));
  ok(junkParse.valid && !('blocks' in junkParse.parsed),
    'a malformed blocks value is dropped, the answer still succeeds');
  const partialParse = parseActionResponse(JSON.stringify({
    thought: 't', action: 'respond', response: 'r', blocks: [samples.card, 'junk', null, { no: 'type' }]
  }));
  ok(partialParse.valid && partialParse.parsed.blocks.length === 1,
    'junk entries are filtered out, valid ones kept');

  // ── 4. Live model round-trip ─────────────────────────────────────
  console.log('\n=== 4. Live model ===');
  if (SKIP_LLM) {
    console.log('  [SKIP] --no-llm passed');
  } else {
    const { reason } = require(B + '/services/cognitive/ReasoningEngine');
    // Groq's free tier caps tokens-per-DAY per model, so a long session can
    // exhaust the 70B budget and every later call 429s for reasons that have
    // nothing to do with the block contract. --model= lets the run move to a
    // model with budget left; the 8B fallback is the worst case worth proving
    // anyway, since that is what answers when the primary is rate-limited.
    const modelArg = (process.argv.find(a => a.startsWith('--model=')) || '').replace('--model=', '') || null;
    if (modelArg) console.log('  (model override: ' + modelArg + ')');
    const PACE_MS = Number((process.argv.find(a => a.startsWith('--pace=')) || '').replace('--pace=', '')) || 8000;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const only = (process.argv.find(a => a.startsWith('--types=')) || '').replace('--types=', '');
    const wanted = only ? only.split(',') : StudyBlocks.BLOCK_TYPES;
    let first = true;
    for (const type of wanted) {
      if (!first) await sleep(PACE_MS);
      first = false;
      try {
        // The real production path: ContextBuilder's prompt, the real schema
        // and directive, then CognitiveCore's serialiser — not a hand-rolled
        // prompt that might be easier than what the app actually sends.
        const messages = buildContext({
          goal: `Teach me bond duration. Include a "${type}" block in your answer.`,
          agentName: 'aurelius',
          studyMode: true
        });
        const out = await reason({ messages, temperature: 0.2, model: modelArg });
        const text = withStudyBlocks(out && out.action);
        const blocks = StudyBlocks.parse(text).filter(s => s.kind === 'block').map(s => s.block);
        const got = blocks.map(b => b.type).join(',');
        ok(blocks.some(b => String(b.type).toLowerCase() === type),
          `model produced a parseable "${type}" block` +
          (blocks.length ? ` — parsed types: [${got}]` : ' — nothing parsed, raw: ' + text.slice(0, 160).replace(/\s+/g, ' ')));
      } catch (e) {
        ok(false, `live "${type}" round-trip errored: ${e.message}`);
      }
    }
  }

  console.log(`\n──────────────\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
