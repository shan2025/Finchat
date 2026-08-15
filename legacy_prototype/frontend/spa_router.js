// spa_router.js — client-side navigation for FinChat.
//
// FinChat is a multi-page app: every navigation tears down the document and
// rebuilds it, which means re-parsing the shared JS and, more expensively,
// re-running each page's boot API calls. A database round trip costs ~126ms,
// so those repeated boot fetches — not the HTML — are what makes moving
// between pages feel slow.
//
// This router keeps the document alive. It fetches the target page, swaps only
// <main>, and leaves the persistent shell (#sideNav, injected <head> styles,
// the socket, and any cached API data on window) untouched.
//
// ── Scope of the migration ────────────────────────────────────────────────
// Only pages listed in MIGRATED are handled here. A link to anything else
// falls through to a normal browser navigation, so unmigrated pages keep
// working exactly as before. To migrate a page it must:
//
//   1. have an empty <nav id="sideNav"></nav> (shell is injected, not inline),
//   2. keep all its markup inside a single <main> element,
//   3. keep its page logic in inline <script> blocks with no src=, and
//   4. tolerate its script running more than once per document lifetime —
//      which is why view scripts are executed inside a fresh function scope
//      (see runViewScripts) rather than at global scope, where a second
//      `const API_URL` would throw.
//
// Pages NOT migrated, and why: finchat_chat.html, finchat_dashboard.html,
// finchat_agents.html, finchat_neuralmap.html and finchat_audit.html carry
// inline sidebar markup and/or multiple interdependent script blocks; they
// need their globals scoped before they can join. finchat_login.html and
// finchat_signup.html are deliberately excluded — an auth boundary should be
// a real document load.
(function () {
  'use strict';

  const MIGRATED = new Set([
    'finchat_knowledge.html',
    'finchat_reports.html'
  ]);
  // finchat_settings.html meets conditions 1-3 but not 4: it has 10 inline
  // on*= attributes whose handlers must be reachable from global scope, and 28
  // top-level const/let bindings that cannot be re-declared. Migrating it means
  // converting those handlers to addEventListener first.

  const pageOf = (url) => {
    try { return new URL(url, location.origin).pathname.split('/').pop() || ''; }
    catch (e) { return ''; }
  };

  // Only run on a migrated page — otherwise this page's own globals were never
  // scoped and swapping into it would be unsafe.
  if (!MIGRATED.has(pageOf(location.href))) return;
  if (!window.history || !window.fetch) return;

  // ── per-view lifecycle ──────────────────────────────────────────────────
  // A view's timers and listeners must die with it, or navigating five times
  // leaves five copies of every poller running.
  let viewTimers = [];
  let viewTeardown = [];

  const realSetInterval = window.setInterval.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  let tracking = false;

  function startTracking() {
    tracking = true;
    window.setInterval = function (fn, ms, ...rest) {
      const id = realSetInterval(fn, ms, ...rest);
      if (tracking) viewTimers.push(['i', id]);
      return id;
    };
    window.setTimeout = function (fn, ms, ...rest) {
      const id = realSetTimeout(fn, ms, ...rest);
      if (tracking) viewTimers.push(['t', id]);
      return id;
    };
  }

  function stopTracking() {
    tracking = false;
    window.setInterval = realSetInterval;
    window.setTimeout = realSetTimeout;
  }

  function teardownView() {
    viewTimers.forEach(([kind, id]) => {
      if (kind === 'i') clearInterval(id); else clearTimeout(id);
    });
    viewTimers = [];
    viewTeardown.forEach(fn => { try { fn(); } catch (e) { console.warn('teardown failed', e); } });
    viewTeardown = [];
  }

  // Views can register their own cleanup: window.fcView.onTeardown(fn)
  window.fcView = {
    onTeardown(fn) { if (typeof fn === 'function') viewTeardown.push(fn); }
  };

  // ── view script execution ───────────────────────────────────────────────
  // Each block runs inside its own function scope. Two pages both declaring
  // `const API_URL` at top level would be a redeclaration SyntaxError if these
  // were appended as plain global <script> tags.
  // Injected as a real <script> element rather than new Function()/eval: the
  // CSP allows 'unsafe-inline' but deliberately does NOT allow 'unsafe-eval',
  // and weakening it to enable the router would be a bad trade.
  //
  // The IIFE wrapper is what makes re-entry safe — these pages declare 17-28
  // top-level const/let bindings, so re-running one at global scope (navigate
  // away and back) would be a redeclaration SyntaxError. It is also why a page
  // with inline on*= handlers cannot be migrated as-is: those resolve against
  // the global scope, which the wrapper hides.
  function runViewScripts(doc) {
    const blocks = [...doc.querySelectorAll('main script, body > script')]
      .filter(s => !s.src);
    startTracking();
    try {
      for (const block of blocks) {
        const el = document.createElement('script');
        el.textContent = '(function(){\n' + block.textContent + '\n})();';
        document.body.appendChild(el);
        el.remove();
      }
    } finally {
      stopTracking();
    }
  }

  // Widgets that bind to elements inside <main> have to rebind after a swap.
  // Those that live in the persistent shell (sidebar_nav, sidebar_collapse)
  // deliberately are not re-run.
  function reinitShellWidgets() {
    try { window.fcNotifications && window.fcNotifications.init(); } catch (e) { /* non-fatal */ }
    try { window.fcKnowledgeSearch && window.fcKnowledgeSearch.init(); } catch (e) { /* non-fatal */ }
    // Reflect the active page in the persistent nav.
    document.querySelectorAll('#sideNav a[href]').forEach(a => {
      const isCurrent = pageOf(a.getAttribute('href')) === pageOf(location.href);
      a.classList.toggle('active', isCurrent);
      if (isCurrent) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  let navToken = 0;

  async function navigate(url, { push = true, scroll = 0 } = {}) {
    const token = ++navToken;
    document.documentElement.classList.add('spa-loading');
    try {
      const res = await fetch(url, { headers: { 'X-Requested-With': 'spa' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();

      // A superseded navigation must not paint over a newer one.
      if (token !== navToken) return;

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const nextMain = doc.querySelector('main');
      const currentMain = document.querySelector('main');
      if (!nextMain || !currentMain) throw new Error('no <main> to swap');

      teardownView();

      currentMain.replaceWith(nextMain.cloneNode(true));
      document.title = doc.title || document.title;
      if (push) history.pushState({ spa: true }, '', url);

      runViewScripts(doc);
      reinitShellWidgets();
      window.scrollTo(0, scroll);
      window.dispatchEvent(new CustomEvent('fc:navigated', { detail: { url } }));
    } catch (e) {
      // Any failure falls back to a real navigation, so a router bug degrades
      // to the old behaviour instead of a blank page.
      console.warn('[spa] falling back to full navigation:', e.message);
      location.href = url;
    } finally {
      document.documentElement.classList.remove('spa-loading');
    }
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    if (a.origin !== location.origin) return;
    if (a.dataset.noSpa !== undefined) return;

    const target = pageOf(a.href);
    if (!MIGRATED.has(target)) return;          // full load for unmigrated pages
    if (a.href === location.href) { e.preventDefault(); return; }

    e.preventDefault();
    navigate(a.href);
  });

  window.addEventListener('popstate', () => {
    if (!MIGRATED.has(pageOf(location.href))) { location.reload(); return; }
    navigate(location.href, { push: false });
  });

  // The first view was rendered by the server; adopt its timers so leaving
  // this page cleans up after it too.
  startTracking();
  window.addEventListener('load', stopTracking, { once: true });
})();
