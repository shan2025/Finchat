// test/auth-surface.test.js — the sign-in surface keeps its promises.
//
// Every control on the login and signup pages used to be one of three things:
// wired up, an alert() apologising for itself, or decoration. The checkbox and
// the Forgot Password link were decoration, "Continue with Google" was the
// apology, and the wallet step was a page that made no network calls at all.
//
// These tests pin the parts of that fix which are cheap to verify without a
// database: the handle rules, the Google verifier's refusal to trust an
// unverified assertion, the CSP allowances the Google button needs, and the
// frontend regressions that would quietly restore the old behaviour.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const usernames = require('../services/usernames');
const google = require('../services/googleAuth');
const csp = require('../config/csp');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const readPage = (f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8');

/**
 * Drop comments before searching for code. Both pages explain in prose what
 * they replaced, so a bare search for "alert(" matches the note about removing
 * alert() and the test fails on its own documentation.
 *
 * Line comments are only stripped when the `//` opens the line, so the `//` in
 * an https:// URL does not swallow the rest of it.
 */
function codeOnly(html) {
  return html
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

describe('username rules', () => {
  test('accepts a normal handle and lowercases it', () => {
    const r = usernames.validate('  ShanKumar_92  ');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.username, 'shankumar_92');
  });

  test('rejects handles the signup field must explain', () => {
    const cases = [
      ['', 'empty'],
      ['ab', 'too short'],
      ['a'.repeat(21), 'too long'],
      ['9lives', 'must start with a letter'],
      ['_private', 'must start with a letter'],
      ['has space', 'illegal character'],
      ['has-dash', 'illegal character'],
      ['user@host', 'illegal character']
    ];
    for (const [value, why] of cases) {
      const r = usernames.validate(value);
      assert.strictEqual(r.ok, false, `${JSON.stringify(value)} should fail (${why})`);
      assert.ok(r.error && r.error.length > 0, `${why} needs a message for the field`);
    }
  });

  test('reserved handles cannot be claimed, case-insensitively', () => {
    for (const reserved of ['admin', 'FinChat', 'SUPPORT', 'security']) {
      const r = usernames.validate(reserved);
      assert.strictEqual(r.ok, false, `${reserved} must be reserved`);
    }
  });

  test('every generated fallback would itself pass validation', () => {
    // generateUnique() hits the database, but its shaping is the half that can
    // silently drift from validate() — a suggestion the form then rejects is
    // worse than no suggestion. Re-derive the shaping here and check it holds
    // for inputs that break each rule.
    for (const seed of ['9lives', '', 'a', 'Shan Kumar!', 'admin', 'x'.repeat(60)]) {
      let base = usernames.normalize(seed).replace(/[^a-z0-9_]/g, '');
      if (!/^[a-z]/.test(base)) base = 'u' + base;
      base = base.slice(0, usernames.MAX - 3) || 'user';
      while (base.length < usernames.MIN) base += '0';
      if (usernames.RESERVED.has(base)) base = base + '1';

      const r = usernames.validate(base);
      assert.strictEqual(r.ok, true, `generated "${base}" from "${seed}" must be legal: ${r.error}`);
      assert.ok(base.length + 3 <= usernames.MAX,
        `"${base}" leaves no room for a collision suffix inside ${usernames.MAX} chars`);
    }
  });
});

describe('Google ID token verification', () => {
  test('is off unless GOOGLE_CLIENT_ID is set', () => {
    const original = process.env.GOOGLE_CLIENT_ID;
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      assert.strictEqual(google.isConfigured(), false);
      process.env.GOOGLE_CLIENT_ID = '   ';
      assert.strictEqual(google.isConfigured(), false, 'whitespace is not configuration');
      process.env.GOOGLE_CLIENT_ID = '123.apps.googleusercontent.com';
      assert.strictEqual(google.isConfigured(), true);
    } finally {
      if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = original;
    }
  });

  test('refuses to run at all when unconfigured', async () => {
    const original = process.env.GOOGLE_CLIENT_ID;
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      await assert.rejects(() => google.verifyIdToken('anything'), /not configured/);
    } finally {
      if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = original;
    }
  });

  test('rejects credentials it cannot even parse, before any network call', async () => {
    const original = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = '123.apps.googleusercontent.com';
    try {
      await assert.rejects(() => google.verifyIdToken(''), /Missing Google credential/);
      await assert.rejects(() => google.verifyIdToken(null), /Missing Google credential/);
      await assert.rejects(() => google.verifyIdToken('not-a-jwt'), /Malformed Google credential/);
      // A structurally valid JWT with no `kid` is the shape an attacker would
      // hand-roll; it must not reach the signature check with a null key.
      const unsigned = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') +
        '.' + Buffer.from(JSON.stringify({ sub: '1', email: 'a@b.c' })).toString('base64url') + '.';
      await assert.rejects(() => google.verifyIdToken(unsigned), /Malformed Google credential/);
    } finally {
      if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = original;
    }
  });

  test('the verifier never trusts a decoded payload directly', () => {
    // The failure mode this guards is a one-line "optimisation": swapping
    // jwt.verify for jwt.decode turns Google sign-in into sign-in-as-anyone,
    // and no unit test with a real token would catch it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'googleAuth.js'), 'utf8');
    assert.match(src, /jwt\.verify\(/, 'the ID token must be signature-verified');
    assert.match(src, /audience:/, 'a token minted for another client_id is not ours');
    assert.match(src, /issuer:/, 'the issuer must be pinned to Google');
    assert.match(src, /email_verified/, 'an unverified address must not claim an account');
  });
});

describe('CSP admits the Google button', () => {
  const GSI = 'https://accounts.google.com';

  test('all four directives Google Identity Services needs are present', () => {
    // Missing any one of these fails differently and quietly: no script, no
    // stylesheet, a blank iframe, or a button that never returns a credential.
    assert.ok(csp.scriptSrc.includes(GSI), 'script-src must allow the GSI client');
    assert.ok(csp.styleSrc.includes(GSI), 'style-src must allow the stylesheet GSI injects');
    assert.ok(csp.frameSrc && csp.frameSrc.includes(GSI), 'frame-src must allow the button iframe');
    assert.ok(csp.connectSrc.includes(GSI), 'connect-src must allow the credential exchange');
  });

  test('frame-src does not silently widen the policy', () => {
    assert.deepStrictEqual(csp.frameSrc, ["'self'", GSI]);
    assert.deepStrictEqual(csp.frameAncestors, ["'none'"], 'we still refuse to be framed');
  });

  test('COOP allows popups to reach their opener', () => {
    // helmet's default Cross-Origin-Opener-Policy is 'same-origin', which cuts
    // window.opener for popups this page opened itself. Google Sign-In returns
    // its credential through that reference, so the default makes the user
    // authenticate successfully and then leaves the popup hanging blank on
    // accounts.google.com/gsi/transform, with no error logged anywhere.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /crossOriginOpenerPolicy:\s*\{\s*policy:\s*'same-origin-allow-popups'\s*\}/,
      "COOP must be 'same-origin-allow-popups' or Google Sign-In hangs after a successful login");
  });
});

describe('the sign-in pages do not regress', () => {
  const login = readPage('finchat_login.html');
  const signup = readPage('finchat_signup.html');

  test('the fake wallet onboarding step is gone', () => {
    assert.strictEqual(fs.existsSync(path.join(FRONTEND, 'finchat_link_wallet.html')), false,
      'finchat_link_wallet.html made no network calls and described a server-side keypair as the user\'s');
    for (const [name, html] of [['login', login], ['signup', signup]]) {
      assert.ok(!/link_wallet/.test(html), `${name} still links to the deleted wallet step`);
    }
  });

  test('errors are shown in the form, not thrown at an alert()', () => {
    for (const [name, html] of [['login', login], ['signup', signup]]) {
      assert.ok(!/\balert\s*\(/.test(codeOnly(html)),
        `${name} still calls alert() — field errors belong on the field`);
      assert.ok(/field-error/.test(html), `${name} needs per-field error slots`);
      assert.ok(/form-banner/.test(html), `${name} needs a banner for errors with no single field`);
    }
  });

  test('Remember me is wired to the slot the rest of the app reads', () => {
    const helper = fs.readFileSync(path.join(FRONTEND, 'auth_session.js'), 'utf8');
    // api_client.js falls back to localStorage.finchat_session; that is the key
    // that means "remembered", and the login page never used to write it.
    assert.match(helper, /finchat_session/, 'the remembered session key must be written');
    assert.match(helper, /finchat_jwt/, 'knowledge.html and reports.html read only this key');
    assert.match(login, /auth_session\.js/, 'login must persist through the shared helper');
    assert.match(login, /id="rememberMe"/, 'the checkbox must still exist');
    assert.match(login, /rememberMe'\)\.checked/, 'the checkbox must be read on submit');
  });

  test('signing out clears every slot a remembered session wrote', () => {
    // Now that Remember me really persists, a logout that drops one key leaves
    // the user signed in via the survivors.
    for (const page of ['finchat_chat.html', 'finchat_settings.html']) {
      const html = readPage(page);
      assert.match(html, /auth_session\.js/, `${page} must load the session helper`);
      assert.match(html, /fcAuth\.clear\(\)/, `${page} must clear through the shared helper`);
    }
  });

  test('the signup form collects and checks a username', () => {
    assert.match(signup, /id="username"/, 'signup needs a username field');
    assert.match(signup, /username-available/, 'availability must be checked as they type');
    assert.match(signup, /usernameSeq/, 'out-of-order responses must not label the wrong value');
  });
});
