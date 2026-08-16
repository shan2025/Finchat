// test/csp-inline-handlers.test.js — the CSP must not switch the UI off.
//
// The frontend wires most of its buttons with inline on*= attributes. Those are
// governed by `script-src-attr`, a separate directive from `script-src`, and
// helmet's defaults set it to 'none'. Adding helmet's CSP without overriding it
// left every page rendering normally — inline <script> blocks are covered by
// script-src 'unsafe-inline' and kept running — while every onclick on every
// page silently did nothing.
//
// This test renders the real header through helmet and fails if that state can
// come back. If the inline handlers are ever migrated to addEventListener, the
// frontend half of this test stops finding them and the directive can go.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');

const directives = require('../config/csp');
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

/** The Content-Security-Policy header the app actually sends. */
function renderHeader() {
  const mw = helmet.contentSecurityPolicy({ directives });
  let header = null;
  const res = { setHeader: (name, value) => { if (/^content-security-policy$/i.test(name)) header = value; } };
  mw({}, res, () => {});
  return header;
}

/** Directive value as an array, e.g. "script-src-attr 'unsafe-inline'". */
function directiveOf(header, name) {
  const found = header.split(';').map(s => s.trim()).find(s => s === name || s.startsWith(name + ' '));
  return found === undefined ? null : found.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

describe('CSP leaves the UI operable', () => {
  test('inline event-handler attributes are allowed', () => {
    const attr = directiveOf(renderHeader(), 'script-src-attr');
    assert.notDeepStrictEqual(attr, ["'none'"],
      "script-src-attr 'none' blocks every onclick in the frontend — see config/csp.js");
    assert.ok(attr === null || attr.includes("'unsafe-inline'"),
      `script-src-attr must permit inline handlers, got: ${attr}`);
  });

  test('inline <script> blocks are allowed', () => {
    const src = directiveOf(renderHeader(), 'script-src');
    assert.ok(src && src.includes("'unsafe-inline'"),
      'every page bootstraps from an inline <script> block');
  });

  test('the frontend really does depend on inline handlers', () => {
    // Guards the guard: if this count ever reaches zero the directive above is
    // dead weight and should be dropped rather than carried forward.
    let handlers = 0;
    for (const file of fs.readdirSync(FRONTEND).filter(f => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
      handlers += (html.match(/\son(?:click|change|input|submit|keydown|keyup|mouseover)\s*=\s*"/gi) || []).length;
    }
    assert.ok(handlers > 0,
      'no inline handlers left — drop scriptSrcAttr from config/csp.js instead of keeping it');
  });

  test('the hardening that was the point of the CSP is still in place', () => {
    const header = renderHeader();
    assert.deepStrictEqual(directiveOf(header, 'object-src'), ["'none'"]);
    assert.deepStrictEqual(directiveOf(header, 'frame-ancestors'), ["'none'"]);
    assert.deepStrictEqual(directiveOf(header, 'base-uri'), ["'self'"]);
    assert.deepStrictEqual(directiveOf(header, 'default-src'), ["'self'"]);
    // unsafe-eval was removed when Tailwind stopped compiling in the browser.
    assert.ok(!header.includes("'unsafe-eval'"), "'unsafe-eval' must not come back");
  });

  test('server.js serves these directives rather than its own copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /contentSecurityPolicy:\s*\{\s*directives:\s*require\('\.\/config\/csp'\)/,
      'server.js should take its CSP from config/csp.js so this test covers production');
  });
});
