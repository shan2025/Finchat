// test/session-expiry.test.js — an expired sign-in sends the user back to log in.
//
// Tokens live 7 days, but a remembered session outlived them in localStorage
// and pages only checked that a session existed. After a week the app still
// opened and every request failed; Chat showed the server's "Invalid or expired
// token" as the agent's reply. And requireAuth answered that same 401 when the
// DATABASE failed, so a DB blip looked like a bad token.
//
// Three layers are pinned here, none needing a database or a browser:
//   1. middleware/auth.js — which failures are 401 (sign out) and which are 503.
//   2. frontend/auth_session.js — run in a vm against fake storage and fetch.
//   3. The chat page's Send button keeps its phone icon when it is rebuilt.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const jwt = require('jsonwebtoken');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.JWT_SECRET = SECRET;

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

// ── 1. requireAuth ─────────────────────────────────────────────────────────
describe('requireAuth', () => {
  let dbQuery;
  let requireAuth, clearUserCache;

  // database.js is swapped through the require cache before auth.js loads it.
  const dbPath = require.resolve('../database');
  const authPath = require.resolve('../middleware/auth');
  const m = new Module(dbPath, null);
  m.filename = dbPath; m.loaded = true;
  m.exports = { query: (...args) => dbQuery(...args) };
  require.cache[dbPath] = m;
  delete require.cache[authPath];
  ({ requireAuth, clearUserCache } = require('../middleware/auth'));
  delete require.cache[dbPath];
  delete require.cache[authPath];

  const USER = { user_id: 'u1', name: 'Ada', email: 'a@x', role: 'user', token_balance: 5, is_frozen: false };

  function run(authorization) {
    const req = { headers: authorization ? { authorization } : {} };
    const out = { status: null, body: null, next: false };
    const res = {
      status(c) { out.status = c; return this; },
      json(b) { out.body = b; return this; }
    };
    return requireAuth(req, res, () => { out.next = true; }).then(() => ({ ...out, req }));
  }

  beforeEach(() => {
    clearUserCache();
    dbQuery = async () => ({ rows: [USER] });
  });

  test('a valid token reaches the route with req.user set', async () => {
    const r = await run('Bearer ' + jwt.sign({ userId: 'u1' }, SECRET, { expiresIn: '1h' }));
    assert.equal(r.next, true);
    assert.equal(r.status, null);
    assert.equal(r.req.user.id, 'u1');
  });

  test('an expired token is 401 "Invalid or expired token"', async () => {
    const t = jwt.sign({ userId: 'u1', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    const r = await run('Bearer ' + t);
    assert.equal(r.next, false);
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Invalid or expired token');
  });

  test('a token signed with another secret is 401', async () => {
    const r = await run('Bearer ' + jwt.sign({ userId: 'u1' }, 'some-other-secret-of-sufficient-length!!'));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Invalid or expired token');
  });

  test('a deleted user is 401 "User not found"', async () => {
    dbQuery = async () => ({ rows: [] });
    const r = await run('Bearer ' + jwt.sign({ userId: 'gone' }, SECRET, { expiresIn: '1h' }));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'User not found');
  });

  test('a database failure is 503, never the 401 that signs the user out', async () => {
    dbQuery = async () => { throw new Error('connection terminated'); };
    const origError = console.error;
    console.error = () => {};
    try {
      const r = await run('Bearer ' + jwt.sign({ userId: 'u1' }, SECRET, { expiresIn: '1h' }));
      assert.equal(r.next, false);
      assert.equal(r.status, 503);
      assert.notEqual(r.body.error, 'Invalid or expired token');
    } finally {
      console.error = origError;
    }
  });

  test('an error thrown by the route itself is not turned into an auth answer', async () => {
    const t = jwt.sign({ userId: 'u1' }, SECRET, { expiresIn: '1h' });
    const req = { headers: { authorization: 'Bearer ' + t } };
    const res = { status() { throw new Error('auth middleware answered'); }, json() {} };
    await assert.rejects(requireAuth(req, res, () => { throw new Error('route bug'); }), /route bug/);
  });
});

// ── 2. auth_session.js in the browser ──────────────────────────────────────
const AUTH_SESSION = fs.readFileSync(path.join(FRONTEND, 'auth_session.js'), 'utf8');

function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

/** Boot auth_session.js on a page; `respond` answers each fetch. */
function page({ pathname = '/finchat_chat.html', local = {}, session = {}, respond } = {}) {
  const replaced = [];
  const nativeCalls = [];
  const win = {
    localStorage: fakeStorage(local),
    sessionStorage: fakeStorage(session),
    location: { pathname, search: '', replace: (u) => replaced.push(u) },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch: async (input, init) => {
      nativeCalls.push({ input, init });
      const { status = 200, body = {} } = (respond && respond(input, init)) || {};
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
  };
  win.window = win;
  vm.runInNewContext(AUTH_SESSION, win);
  return { win, replaced, nativeCalls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const expiredJwt = () => jwt.sign({ userId: 'u1', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
const liveJwt = () => jwt.sign({ userId: 'u1' }, SECRET, { expiresIn: '1h' });
const remembered = (t) => ({
  finchat_session: JSON.stringify({ name: 'Ada', token: t }), finchat_token: t, finchat_jwt: t,
  finchat_remember: '1', finchat_remember_id: 'a@x'
});

describe('auth_session.js', () => {
  test('a remembered session whose token expired goes to sign-in on load', () => {
    const { win, replaced } = page({ local: remembered(expiredJwt()) });
    assert.deepEqual(replaced, ['finchat_login.html?expired=1']);
    assert.equal(win.localStorage.getItem('finchat_session'), null);
    assert.equal(win.localStorage.getItem('finchat_token'), null);
    assert.equal(win.localStorage.getItem('finchat_jwt'), null);
    // The Remember me choice and the prefilled email survive the sign-out.
    assert.equal(win.localStorage.getItem('finchat_remember'), '1');
    assert.equal(win.localStorage.getItem('finchat_remember_id'), 'a@x');
  });

  test('an expired tab session goes to sign-in on load', () => {
    const t = expiredJwt();
    const { win, replaced } = page({ session: { finchat_user: JSON.stringify({ token: t }), finchat_token: t } });
    assert.equal(replaced.length, 1);
    assert.equal(win.sessionStorage.getItem('finchat_user'), null);
  });

  test('a live token stays on the page', () => {
    const { replaced } = page({ local: remembered(liveJwt()) });
    assert.deepEqual(replaced, []);
  });

  test('the login page clears an expired session without redirecting to itself', () => {
    const { win, replaced } = page({ pathname: '/finchat_login.html', local: remembered(expiredJwt()) });
    assert.deepEqual(replaced, []);
    assert.equal(win.localStorage.getItem('finchat_session'), null);
  });

  test('the server rejecting a live-looking token signs the user out', async () => {
    const t = liveJwt();
    const { win, replaced } = page({
      local: remembered(t),
      respond: () => ({ status: 401, body: { error: 'Invalid or expired token' } })
    });
    const res = await win.fetch('/api/ai-chat/send', { method: 'POST', headers: { Authorization: 'Bearer ' + t } });
    assert.equal(res.status, 401, 'the page still gets the response');
    await tick();
    assert.deepEqual(replaced, ['finchat_login.html?expired=1']);
  });

  test('"User not found" (account deleted) also signs the user out', async () => {
    const t = liveJwt();
    const { win, replaced } = page({ local: remembered(t), respond: () => ({ status: 401, body: { error: 'User not found' } }) });
    await win.fetch('/api/tokens/balance', { headers: { Authorization: 'Bearer ' + t } });
    await tick();
    assert.equal(replaced.length, 1);
  });

  test('Headers objects and Request objects are recognised too', async () => {
    const t = liveJwt();
    const reject = () => ({ status: 401, body: { error: 'Invalid or expired token' } });
    const a = page({ local: remembered(t), respond: reject });
    await a.win.fetch('/api/x', { headers: new Headers({ Authorization: 'Bearer ' + t }) });
    const b = page({ local: remembered(t), respond: reject });
    await b.win.fetch(new Request('http://h/api/x', { headers: { Authorization: 'Bearer ' + t } }));
    await tick();
    assert.equal(a.replaced.length, 1);
    assert.equal(b.replaced.length, 1);
  });

  test('a server or database error does not sign the user out', async () => {
    const t = liveJwt();
    for (const status of [500, 502, 503]) {
      const { win, replaced } = page({ local: remembered(t), respond: () => ({ status, body: { error: 'boom' } }) });
      await win.fetch('/api/ai-chat/send', { headers: { Authorization: 'Bearer ' + t } });
      await tick();
      assert.deepEqual(replaced, [], `status ${status}`);
      assert.notEqual(win.localStorage.getItem('finchat_session'), null);
    }
  });

  test('a 401 on a request without a token (a wrong password) is left alone', async () => {
    const { win, replaced } = page({ pathname: '/finchat_settings.html', local: remembered(liveJwt()), respond: () => ({ status: 401, body: { error: 'Invalid or expired token' } }) });
    await win.fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    await tick();
    assert.deepEqual(replaced, []);
  });

  test('a 401 with some other message is left alone', async () => {
    const t = liveJwt();
    const { win, replaced } = page({ local: remembered(t), respond: () => ({ status: 401, body: { error: 'Invalid or missing cron secret.' } }) });
    await win.fetch('/api/cron/x', { headers: { Authorization: 'Bearer ' + t } });
    await tick();
    assert.deepEqual(replaced, []);
  });

  test('many rejected requests redirect once', async () => {
    const t = liveJwt();
    const { win, replaced } = page({ local: remembered(t), respond: () => ({ status: 401, body: { error: 'Invalid or expired token' } }) });
    await Promise.all([1, 2, 3, 4].map(() => win.fetch('/api/x', { headers: { Authorization: 'Bearer ' + t } })));
    await tick();
    assert.equal(replaced.length, 1);
  });

  test('loading the file twice wraps fetch once', () => {
    const { win } = page({ local: remembered(liveJwt()) });
    const wrapped = win.fetch;
    vm.runInNewContext(AUTH_SESSION, win);
    assert.equal(win.fetch, wrapped);
  });

  test('every page gets the file from pwaHead, ahead of the page scripts', () => {
    const { injectPwaHead } = require('../middleware/pwaHead');
    const out = injectPwaHead('<html><head><title>x</title></head><body><script>boot()</script></body></html>');
    const head = out.split('</head>')[0];
    assert.match(head, /<script src="\/auth_session\.js"><\/script>/);
    assert.doesNotMatch(head, /auth_session\.js"[^>]*(defer|async)/);
  });

  test('the login page explains why the user is there', () => {
    const login = fs.readFileSync(path.join(FRONTEND, 'finchat_login.html'), 'utf8');
    assert.match(login, /expired=1[\s\S]{0,200}showBanner\('loginBanner'/);
  });
});

// ── 3. The Send button keeps its phone icon ────────────────────────────────
describe('chat Send button on a phone', () => {
  const chat = fs.readFileSync(path.join(FRONTEND, 'finchat_chat.html'), 'utf8');
  const mobile = fs.readFileSync(path.join(FRONTEND, 'mobile_ui.js'), 'utf8');

  /** The body of a named function in the page, by brace matching. */
  function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  }

  function runMode(mode) {
    const btn = { style: {}, innerHTML: '', title: '', disabled: true };
    const hydrated = [];
    const ctx = {
      document: { getElementById: (id) => (id === 'sendBtn' ? btn : null) },
      window: { fcMobile: { hydrateIcons: (el) => hydrated.push(el) } },
      sendMessage() {}, stopGenerating() {}
    };
    ctx.fcMobile = ctx.window.fcMobile;
    vm.runInNewContext('var isSending, currentAbortController;' + extractFunction(chat, 'setSendButtonMode') +
      ';setSendButtonMode(' + JSON.stringify(mode) + ')', ctx);
    return { btn, hydrated };
  }

  for (const [mode, iconName] of [['send', 'arrowUp'], ['stop', 'stop']]) {
    test(`the rebuilt ${mode} button carries a phone icon and is hydrated`, () => {
      const { btn, hydrated } = runMode(mode);
      assert.match(btn.innerHTML, new RegExp(`class="fcm-only fcm-lic"><span data-fcm-icon="${iconName}">`));
      assert.deepEqual(hydrated, [btn]);
      assert.match(mobile, new RegExp(`\\b${iconName}: \\[`), `mobile_ui.js has no "${iconName}" icon`);
    });
  }

  test('the button as first rendered has the phone icon too', () => {
    assert.match(chat, /id="sendBtn"[^>]*>\s*<span class="material-symbols-outlined[^"]*">arrow_upward<\/span><span class="fcm-only fcm-lic"><span data-fcm-icon="arrowUp">/);
  });
});
