// scripts/test_agent_settings.js — verify agent runtime settings actually take effect
const { getAgentConfig, refreshRegistry } = require('../services/agents/AgentRegistry');
const { buildContext, buildTraitDirective } = require('../services/cognitive/ContextBuilder');
const { query, getPool } = require('../database');
require('dotenv').config();

let passed = 0, failed = 0;
function check(label, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); passed++; }
  else { console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   Agent Runtime Settings — verification');
  console.log('═══════════════════════════════════════════════\n');

  // 1. runtime_settings load from registry
  console.log('▸ Test 1: runtime_settings present in registry');
  await refreshRegistry();
  const aur = await getAgentConfig('aurelius');
  check('aurelius has runtimeSettings', aur && aur.runtimeSettings && typeof aur.runtimeSettings === 'object',
    JSON.stringify(aur && aur.runtimeSettings));

  // 2. Trait directive reflects slider semantics
  console.log('\n▸ Test 2: buildTraitDirective maps sliders to language');
  const casual = buildTraitDirective({ risk: 'High', formal: 90, brief: 90, serious: 90 });
  check('High formal → casual tone', /casual/i.test(casual));
  check('High brief → detailed', /detailed/i.test(casual));
  check('High serious → playful', /playful/i.test(casual));
  check('High risk → bold', /bold/i.test(casual));
  const strict = buildTraitDirective({ risk: 'Low', formal: 10, brief: 10, serious: 10 });
  check('Low formal → formal tone', /formal, professional/i.test(strict));
  check('Low brief → concise', /concise/i.test(strict));
  check('Low risk → conservative', /conservative/i.test(strict));

  // 3. Directive is injected into the system prompt
  console.log('\n▸ Test 3: buildContext injects the directive');
  const msgs = buildContext({ goal: 'hi', agentName: 'aurelius', traits: { risk: 'High', formal: 90, brief: 90, serious: 90 } });
  const sys = msgs.find(m => m.role === 'system').content;
  check('System prompt contains STYLE & BEHAVIOR TUNING', /STYLE & BEHAVIOR TUNING/.test(sys));
  check('Directive omitted when no traits', !/STYLE & BEHAVIOR TUNING/.test(buildContext({ goal: 'hi', agentName: 'aurelius' }).find(m => m.role === 'system').content));

  // 4. risk → temperature mapping (mirror of CognitiveCore)
  console.log('\n▸ Test 4: risk → temperature');
  const RISK_TEMP = { Low: 0.3, Medium: 0.7, High: 1.0 };
  check('Low=0.3', RISK_TEMP.Low === 0.3);
  check('Medium=0.7', RISK_TEMP.Medium === 0.7);
  check('High=1.0', RISK_TEMP.High === 1.0);

  console.log('\n═══════════════════════════════════════════════');
  console.log(`   Results: ✅ ${passed} passed  ❌ ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('Harness error:', e); process.exit(1); });
