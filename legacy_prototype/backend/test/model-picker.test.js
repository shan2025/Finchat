// test/model-picker.test.js — the Agents page must not offer dead models.
//
// The per-agent LLM picker is a hardcoded <select> in finchat_agents.html while
// the models that actually work are decided in services/inference.js and,
// ultimately, by whatever Groq still serves. Those drifted: Groq decommissioned
// llama-3.3-70b-versatile (notice 2026-08-15), llama-3.1-8b-instant and
// deepseek-r1-distill-llama-70b, inference.js moved its primary to
// gpt-oss-120b, and the dropdown kept offering all three dead ids — still
// labelling 70B as "default" — so three of its five choices would have pinned
// an agent to a model that answers 400.
//
// Nothing surfaces that: the picker saves fine, and the agent only breaks later
// when it next runs.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AGENTS_PAGE = path.join(__dirname, '..', '..', 'frontend', 'finchat_agents.html');
const INFERENCE = path.join(__dirname, '..', 'services', 'inference.js');

// Confirmed absent from a live catalog read on 2026-08-17
// (GET https://api.groq.com/openai/v1/models).
const DECOMMISSIONED = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'deepseek-r1-distill-llama-70b',
  'llama3-70b-8192',
  'mixtral-8x7b-32768'
];

/** The value="…" of every option in the model picker. */
function pickerOptions() {
  const html = fs.readFileSync(AGENTS_PAGE, 'utf8');
  const select = /<select[^>]*id="modelPicker"[\s\S]*?<\/select>/.exec(html);
  assert.ok(select, 'the model picker (#modelPicker) is missing from the Agents page');
  return [...select[0].matchAll(/<option\s+value="([^"]*)"/g)].map(m => m[1]);
}

describe('per-agent model picker', () => {
  test('offers no model Groq has decommissioned', () => {
    const options = pickerOptions();
    for (const dead of DECOMMISSIONED) {
      assert.ok(!options.includes(dead),
        `#modelPicker still offers "${dead}", which Groq no longer serves — ` +
        'selecting it pins that agent to a model that answers 400');
    }
  });

  test('every option is a model the backend actually knows', () => {
    // Guards the other direction: an id invented in the markup, or a typo,
    // would save cleanly and fail only at inference time.
    const src = fs.readFileSync(INFERENCE, 'utf8');
    for (const value of pickerOptions().filter(Boolean)) {
      assert.ok(src.includes(value),
        `#modelPicker offers "${value}" but services/inference.js never mentions it`);
    }
  });

  test('the "Default" label names the model that is actually the default', () => {
    // This is the part that stayed wrong longest: the label read
    // "Default (Llama 3.3 70B — balanced)" while GROQ_PRIMARY_MODEL had already
    // become gpt-oss-120b, so the page confidently described the wrong model.
    const html = fs.readFileSync(AGENTS_PAGE, 'utf8');
    const defaultLabel = /<option\s+value="">([^<]*)<\/option>/.exec(
      /<select[^>]*id="modelPicker"[\s\S]*?<\/select>/.exec(html)[0]
    );
    assert.ok(defaultLabel, 'the picker needs an empty-value "Default" option');

    const primary = /GROQ_PRIMARY_MODEL\s*=\s*process\.env\.GROQ_MODEL\s*\|\|\s*'([^']+)'/
      .exec(fs.readFileSync(INFERENCE, 'utf8'));
    assert.ok(primary, 'could not read GROQ_PRIMARY_MODEL out of inference.js');

    // Compare loosely — the label is prose ("GPT-OSS 120B"), the id is
    // "openai/gpt-oss-120b" — but the distinguishing part must be present.
    const idPart = primary[1].split('/').pop().replace(/-/g, '').toLowerCase();
    const labelPart = defaultLabel[1].replace(/[\s-]/g, '').toLowerCase();
    assert.ok(labelPart.includes(idPart),
      `the Default option says "${defaultLabel[1].trim()}" but the real default is ${primary[1]}`);
  });

  test('the Groq fallback chain lists no decommissioned model', () => {
    const src = fs.readFileSync(INFERENCE, 'utf8');
    const chain = /GROQ_FALLBACK_MODELS\s*=\s*\(process\.env\.GROQ_FALLBACK_MODELS\s*\|\|\s*\n?\s*'([^']+)'/
      .exec(src);
    assert.ok(chain, 'could not read GROQ_FALLBACK_MODELS out of inference.js');
    const models = chain[1].split(',').map(s => s.trim());
    for (const dead of DECOMMISSIONED) {
      assert.ok(!models.includes(dead),
        `the Groq fallback chain still lists "${dead}" — a wasted round-trip and a ` +
        '404 on every fresh process before _deadModels retires it');
    }
  });
});
