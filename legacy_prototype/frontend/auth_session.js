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

  function wasRemembered() {
    try { return localStorage.getItem(REMEMBER_FLAG) === '1'; } catch (e) { return false; }
  }

  function rememberedIdentifier() {
    try { return localStorage.getItem(REMEMBER_ID) || ''; } catch (e) { return ''; }
  }

  window.fcAuth = {
    persist: persist,
    clear: clear,
    wasRemembered: wasRemembered,
    rememberedIdentifier: rememberedIdentifier
  };
})();
