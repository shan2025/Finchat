// auth_session.js — one place that decides where a signed-in session is stored.
//
// The rest of the app already agreed on where to LOOK. api_client.js reads, in
// order: sessionStorage.finchat_user → localStorage.finchat_session →
// localStorage.finchat_token → localStorage.finchat_jwt, and every page repeats
// some subset of that chain inline.
//
// Nothing agreed on where to WRITE. The login page set sessionStorage.finchat_user,
// sessionStorage.finchat_token and localStorage.finchat_token — but never
// localStorage.finchat_session, which is the slot the fallback chain treats as
// "this user asked to be remembered". So the Remember me checkbox had nothing
// behind it, and the session it should have persisted was written to two keys
// unconditionally instead, meaning every login was half-remembered whether the
// box was ticked or not.
//
// Load before any script that needs the session.
(function () {
  'use strict';

  if (window.fcAuth) return;

  // Tab-scoped: cleared when the tab closes, regardless of the checkbox.
  var TAB_KEYS = ['finchat_user', 'finchat_token'];
  // Device-scoped: written only when Remember me is ticked, and cleared
  // otherwise so switching the box off on a shared machine actually forgets.
  var DEVICE_KEYS = ['finchat_session', 'finchat_token', 'finchat_jwt'];

  var REMEMBER_FLAG = 'finchat_remember';
  var REMEMBER_ID = 'finchat_remember_id';

  function safeSet(store, key, value) {
    try { store.setItem(key, value); } catch (e) { /* private mode / quota */ }
  }
  function safeRemove(store, key) {
    try { store.removeItem(key); } catch (e) { /* nothing to do */ }
  }

  /**
   * @param {object} user   the sanitized user from the auth response
   * @param {string} token  the JWT
   * @param {boolean} remember  survive closing the browser
   * @param {string} [identifier]  what they typed, to prefill next time
   */
  function persist(user, token, remember, identifier) {
    var session = JSON.stringify(user);

    safeSet(sessionStorage, 'finchat_user', session);
    safeSet(sessionStorage, 'finchat_token', token);

    if (remember) {
      safeSet(localStorage, 'finchat_session', session);
      safeSet(localStorage, 'finchat_token', token);
      // knowledge.html and reports.html fall back to this key alone, so a
      // remembered session that skipped it would come back signed in
      // everywhere except those two pages.
      safeSet(localStorage, 'finchat_jwt', token);
      safeSet(localStorage, REMEMBER_FLAG, '1');
      if (identifier) safeSet(localStorage, REMEMBER_ID, identifier);
    } else {
      DEVICE_KEYS.forEach(function (k) { safeRemove(localStorage, k); });
      safeRemove(localStorage, REMEMBER_FLAG);
      safeRemove(localStorage, REMEMBER_ID);
    }
  }

  /** Wipe every slot the app reads. Used by sign-out. */
  function clear() {
    TAB_KEYS.forEach(function (k) { safeRemove(sessionStorage, k); });
    DEVICE_KEYS.forEach(function (k) { safeRemove(localStorage, k); });
    safeRemove(localStorage, REMEMBER_FLAG);
    // REMEMBER_ID survives on purpose: it is a convenience prefill, not a
    // credential, and clearing it makes signing back in needlessly tedious.
  }

  /** Drop the credentials but keep the Remember me choice and the prefill. */
  function expire() {
    TAB_KEYS.forEach(function (k) { safeRemove(sessionStorage, k); });
    DEVICE_KEYS.forEach(function (k) { safeRemove(localStorage, k); });
  }

  function wasRemembered() {
    try { return localStorage.getItem(REMEMBER_FLAG) === '1'; } catch (e) { return false; }
  }

  function rememberedIdentifier() {
    try { return localStorage.getItem(REMEMBER_ID) || ''; } catch (e) { return ''; }
  }

  window.fcAuth = {
    persist: persist,
    clear: clear,
    expire: expire,
    wasRemembered: wasRemembered,
    rememberedIdentifier: rememberedIdentifier
  };

  // ── Expired sessions ─────────────────────────────────────────────────────
  // A token lives 7 days (JWT_EXPIRES_IN), but a remembered session outlives
  // it in localStorage and pages only check that a session EXISTS. So after a
  // week the app still opened, and every request failed: Chat rendered the
  // server's "Invalid or expired token" as the agent's reply. Now an expired
  // token, or the server rejecting one, sends the user to sign in again.
  // pwaHead.js loads this file on every page so the check runs everywhere.
  var PUBLIC_PAGE = /(?:^|\/)(?:finchat_login|finchat_signup|offline|\w+_share)\.html$/;
  var REJECTED = { 'Invalid or expired token': 1, 'User not found': 1 };
  var leaving = false;

  function storedToken() {
    var slots = [[sessionStorage, 'finchat_user'], [localStorage, 'finchat_session']];
    for (var i = 0; i < slots.length; i++) {
      try {
        var s = JSON.parse(slots[i][0].getItem(slots[i][1]) || 'null');
        if (s && s.token) return s.token;
      } catch (e) { /* malformed entry — try the next */ }
    }
    try { return localStorage.getItem('finchat_token') || localStorage.getItem('finchat_jwt') || ''; } catch (e) { return ''; }
  }

  function isExpired(token) {
    try {
      var b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var claims = JSON.parse(atob(b64));
      return typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now();
    } catch (e) {
      return false; // not a JWT we can read — let the server decide
    }
  }

  function signedOut() {
    if (leaving) return;
    expire();
    if (PUBLIC_PAGE.test(location.pathname)) return;
    leaving = true;
    location.replace('finchat_login.html?expired=1');
  }

  var current = storedToken();
  if (current && isExpired(current)) signedOut();

  function sentBearer(input, init) {
    var h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
    if (!h) return false;
    var v = typeof h.get === 'function' ? h.get('Authorization') : (h.Authorization || h.authorization);
    return typeof v === 'string' && v.indexOf('Bearer ') === 0;
  }

  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var pending = nativeFetch.apply(this, arguments);
      if (!sentBearer(input, init)) return pending;
      return pending.then(function (res) {
        if (res.status === 401) {
          res.clone().json().then(function (body) {
            if (body && REJECTED[body.error]) signedOut();
          }, function () { /* not JSON — not ours */ });
        }
        return res;
      });
    };
  }
})();
