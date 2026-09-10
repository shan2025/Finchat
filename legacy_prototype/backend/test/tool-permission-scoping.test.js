// test/tool-permission-scoping.test.js — an agent must not be offered, or asked
// to get approval for, a tool it cannot run.
//
// Two defects this guards, both found via a mission that hung for a day:
//
// 1. listTools() took no agentId, so EVERY agent's system prompt advertised
//    bash/file_read/file_write/file_edit/glob even though only plato may run
//    them. nova duly planned `bash "synthesis.sh"` and `bash "brief.sh"` —
//    invented scripts, for work that is reasoning rather than shell.
//
// 2. executeTool ran the human-approval gate BEFORE the permission check, so
//    the run parked and raised an approval card for a tool that would have been
//    refused a line later. A human was asked to authorise unsandboxed host
//    shell access for an agent that could never use it, and the mission waited
//    forever on a decision with no effect.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  listTools, getToolNames, ADVANCED_SYSTEM_TOOLS, ADMIN_AGENT_ID,
  HOST_ACCESS_TOOLS, systemToolsFor, DIAGNOSTIC_AGENT_ID, HOPPER_HOST_TOOLS
} = require('../services/cognitive/ToolRegistry');

const RESTRICTED = [...ADVANCED_SYSTEM_TOOLS];
const namesFor = (opts) => listTools(opts).map(t => t.name);

describe('tool visibility is scoped to the agent', () => {
  test('a non-admin agent is offered no host-access tools', () => {
    for (const agentId of ['nova', 'aurelius', 'rasha', 'sentinel']) {
      const names = namesFor({ agentId });
      for (const tool of RESTRICTED) {
        assert.ok(!names.includes(tool),
          `"${tool}" must not be advertised to "${agentId}" — it cannot run it`);
      }
    }
  });

  test('the admin agent still sees them', () => {
    const names = namesFor({ agentId: ADMIN_AGENT_ID });
    for (const tool of RESTRICTED) {
      assert.ok(names.includes(tool),
        `"${tool}" must stay available to the admin agent "${ADMIN_AGENT_ID}"`);
    }
  });

  test('omitting agentId fails CLOSED, not open', () => {
    // These are deny-by-default host-access tools: a call site that forgets to
    // identify itself should lose capability rather than gain it.
    const names = namesFor({});
    for (const tool of RESTRICTED) {
      assert.ok(!names.includes(tool),
        `"${tool}" must be hidden when no agentId is supplied`);
    }
  });

  test('ordinary tools are untouched by the filter', () => {
    const names = namesFor({ agentId: 'nova' });
    for (const tool of ['search', 'paper', 'news', 'crypto', 'stocks']) {
      assert.ok(names.includes(tool), `"${tool}" must remain available to nova`);
    }
  });

  test('the filter hides only the restricted set', () => {
    const all = getToolNames();
    const scoped = namesFor({ agentId: 'nova' });
    const hidden = all.filter(n => !scoped.includes(n));
    assert.deepStrictEqual(hidden.sort(), [...RESTRICTED].sort(),
      'exactly the ADVANCED_SYSTEM_TOOLS should be hidden — nothing more');
  });
});

describe('permission is checked before approval is requested', () => {
  // Asserted against the source rather than by calling executeTool, because
  // checkPermission queries tool_permissions — a live DB round-trip would make
  // this suite slow, network-dependent, and would hold the pool open past the
  // end of the run. The ordering is a structural property, so read it as one.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'cognitive', 'ToolManager.js'), 'utf8');

  test('checkPermission is called before ApprovalRequiredError can be thrown', () => {
    const permissionAt = src.indexOf('await checkPermission(agentId, toolName)');
    const approvalAt = src.indexOf('throw new ApprovalRequiredError(toolName, input)');

    assert.ok(permissionAt !== -1, 'executeTool must still check permission');
    assert.ok(approvalAt !== -1, 'the human approval gate must still exist');
    assert.ok(permissionAt < approvalAt,
      'the permission check must come FIRST — otherwise an agent parks a run ' +
      'waiting on approval for a tool that would be refused immediately after, ' +
      'and a human is asked to authorise host shell access that cannot run');
  });

  test('both guards are inside executeTool, not merely present in the file', () => {
    const start = src.indexOf('async function executeTool(');
    assert.ok(start !== -1, 'executeTool must exist');
    const body = src.slice(start);
    assert.ok(body.includes('await checkPermission(agentId, toolName)'),
      'the permission check must live inside executeTool');
    assert.ok(body.includes('throw new ApprovalRequiredError(toolName, input)'),
      'the approval gate must live inside executeTool');
  });

  test('bash is still restricted to the admin agent', () => {
    assert.ok(ADVANCED_SYSTEM_TOOLS.has('bash'),
      'bash must remain an advanced system tool');
    assert.strictEqual(ADMIN_AGENT_ID, 'plato',
      'the admin agent id must match migration 026');
  });
});

// The diagnostician is the first agent to hold any ADVANCED_SYSTEM_TOOL other
// than the admin, so the boundary of that grant is worth pinning down: reading
// code is the whole job, changing the host is emphatically not.
describe('the diagnostician reads code but does not touch the host', () => {
  const hopperTools = () => listTools({ agentId: DIAGNOSTIC_AGENT_ID }).map(t => t.name);

  test('it is offered the reading pair', () => {
    const names = hopperTools();
    for (const tool of ['file_read', 'glob']) {
      assert.ok(names.includes(tool),
        `"${tool}" must be available to ${DIAGNOSTIC_AGENT_ID} — a diagnosis it cannot ` +
        'read the code for is a guess');
    }
  });

  test('host-access tools stay off unless an operator opted in', () => {
    const granted = systemToolsFor(DIAGNOSTIC_AGENT_ID);
    for (const tool of HOST_ACCESS_TOOLS) {
      assert.strictEqual(granted.has(tool), HOPPER_HOST_TOOLS,
        `"${tool}" must follow HOPPER_HOST_TOOLS exactly — it is unsandboxed host ` +
        'access, and on an ephemeral filesystem a write also silently disappears');
    }
  });

  test('the grant does not leak to any other agent', () => {
    for (const agentId of ['nova', 'aurelius', 'rasha', 'atlas']) {
      const granted = systemToolsFor(agentId);
      assert.strictEqual(granted.size, 0,
        `"${agentId}" must hold no advanced system tools`);
    }
  });

  test('it stays scoped to its own domain — the grant is not admin status', () => {
    // Reaching into ADVANCED_SYSTEM_TOOLS must not also buy the orchestrator's
    // exemption from per-agent tool scoping.
    const names = listTools({
      agentId: DIAGNOSTIC_AGENT_ID,
      agentTools: ['diagnostics', 'file_read', 'glob']
    }).map(t => t.name);
    assert.ok(!names.includes('portfolio'),
      'a scoped diagnostician must not be shown tools outside its domain');
    assert.ok(names.includes('diagnostics'), 'its own domain must survive scoping');
  });
});
