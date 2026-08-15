// api_client.js — one authenticated GET path for the whole frontend.
//
// FinChat is a multi-page app: every navigation is a fresh document, so each
// page pays its full boot cost again. Several independent scripts each wanted
// the same endpoint on that boot — /api/tokens/balance was requested by the
// chat page's own startup sync AND by system_panels.js, which cannot see the
// page's local helpers. Per-file dedupe could never catch that; the coalescing
// has to live somewhere both can reach.
//
// window.fcApi.get(path) returns the SAME promise to every caller that asks
// for a path already in flight. It is not a cache: the entry is dropped as
// soon as the request settles, so the 30s pollers and post-send refreshes
// still read live data.
//
// Load this BEFORE any script that calls it. It has no dependencies.
(function () {
  'use strict';

  if (window.fcApi) return; // already installed

  const BASE = location.protocol.indexOf('http') === 0
    ? location.origin
    : 'http://localhost:3000';

  // Session shape varies by how the user signed in; check every known slot.
  function getToken() {
    for (const [store, key] of [[sessionStorage, 'finchat_user'],
                                [localStorage, 'finchat_session']]) {
      try {
        const s = JSON.parse(store.getItem(key) || 'null');
        if (s && s.token) return s.token;
      } catch (e) { /* malformed entry — try the next */ }
    }
    return localStorage.getItem('finchat_token')
      || localStorage.getItem('finchat_jwt')
      || '';
  }

  const inflight = new Map();

  function get(path, opts) {
    const key = path;
    const pending = inflight.get(key);
    if (pending) return pending;

    const token = getToken();
    const req = fetch(BASE + path, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      ...(opts || {})
    })
      .then(res => {
        if (!res.ok) {
          const err = new Error(path + ' responded ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, req);
    return req;
  }

  window.fcApi = { get, getToken, BASE };
})();
