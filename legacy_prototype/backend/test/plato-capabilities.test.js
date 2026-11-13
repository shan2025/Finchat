// test/plato-capabilities.test.js — Plato describes the tools he actually has.
//
// His prompt used to say he ran "in a Docker container" with terminal and file
// access, that he must NEVER say he could not list files, and named bash,
// file_write and file_edit as his. In production those tools are refused
// outright (ToolRegistry: HOST_TOOLS_ENABLED and NODE_ENV !== 'production'),
// so he was ordered to insist on abilities he did not have — and to invent
// output when the call was refused. The prompt now points at the AVAILABLE
// TOOLS block, which listTools builds from the same switch that enforces it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { personas } = require('../services/personas');

const plato = personas.plato.systemPrompt;

describe("Plato's prompt", () => {
  test('makes no claim the platform cannot back', () => {
    assert.ok(!/Docker/i.test(plato), 'no container claim');
    assert.ok(!/HAVE terminal/i.test(plato), 'no terminal claim');
    assert.ok(!/NEVER say "I cannot/i.test(plato), 'must be allowed to say he cannot');
    assert.ok(!/`(bash|file_write|file_edit)`/.test(plato), 'must not name host tools as his');
  });

  test('defers to the tool list he is actually shown', () => {
    assert.match(plato, /AVAILABLE TOOLS list in this prompt is the complete truth/);
    assert.match(plato, /say plainly that you cannot do that here/);
    assert.match(plato, /never describe output you did not get from a tool/i);
  });
});

describe('the list he defers to', () => {
  // ToolRegistry reads its switch once at load, so each environment needs a
  // fresh process — the same approach as tool-permission-scoping.test.js.
  const platoCatalogue = (env) => execFileSync(process.execPath, ['-e', `
    const { buildContext } = require('./services/cognitive/ContextBuilder');
    process.stdout.write(buildContext({ goal: 'list the files', agentName: 'plato' })[0].content);
  `], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env },
    encoding: 'utf8'
  });

  test('exists under the name the prompt uses', () => {
    assert.match(platoCatalogue({ NODE_ENV: 'production' }), /AVAILABLE TOOLS:/);
  });

  test('in production it offers reading the code, and no shell or file writing', () => {
    const sys = platoCatalogue({ NODE_ENV: 'production', HOST_TOOLS_ENABLED: 'true' });
    assert.match(sys, /"file_read"/);
    assert.match(sys, /"glob"/);
    for (const t of ['bash', 'file_write', 'file_edit']) {
      assert.ok(!new RegExp(`"${t}"`).test(sys), `"${t}" must not be offered in production`);
    }
  });

  test('on a development machine with the switch on, the shell does appear', () => {
    assert.match(platoCatalogue({ NODE_ENV: 'development', HOST_TOOLS_ENABLED: 'true' }), /"bash"/);
  });
});
