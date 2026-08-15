// knowledge_search.js — wires the header "Search system knowledge…" box on any
// page to GET /api/search. Shared-JS pattern: survives design-tool page regens;
// just re-add the <script src="knowledge_search.js"> include if it disappears.
(function () {
  const API = (typeof window.API_URL === 'string' && window.API_URL)
    ? window.API_URL
    : (location.protocol.startsWith('http') ? location.origin : 'http://localhost:3000');

  function getToken() {
    try {
      const raw = sessionStorage.getItem('finchat_user') || localStorage.getItem('finchat_session');
      if (raw) { const s = JSON.parse(raw); if (s && s.token) return s.token; }
    } catch (e) {}
    return localStorage.getItem('finchat_token') || sessionStorage.getItem('finchat_token');
  }

  function findSearchInput() {
    return document.getElementById('knowledgeSearch')
      || document.querySelector('header input[placeholder*="Search system knowledge"]')
      || document.querySelector('header input[placeholder*="Search"]');
  }

  const ICONS = { chat: 'chat', node: 'hub', memory: 'psychology', entity: 'category' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function init() {
    const input = findSearchInput();
    if (!input || input.dataset.ksWired) return;
    input.dataset.ksWired = '1';

    const wrap = input.parentElement;
    if (wrap && getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    const drop = document.createElement('div');
    drop.id = 'ksDropdown';
    drop.style.cssText = 'display:none; position:absolute; top:calc(100% + 8px); right:0; width:340px; max-width:88vw; max-height:380px; overflow-y:auto; background:#fffaf0; border:1px solid #e3d3ba; border-radius:16px; box-shadow:0 14px 34px rgba(46,43,37,.18); z-index:300; padding:6px;';
    (wrap || document.body).appendChild(drop);

    let timer = null, lastQ = '';

    function hide() { drop.style.display = 'none'; }
    function show() { if (drop.innerHTML) drop.style.display = 'block'; }

    function render(items, q) {
      if (!items.length) {
        drop.innerHTML = `<div style="padding:14px; font-size:13px; color:#8a7d6a;">No matches for “${esc(q)}”.</div>`;
        show();
        return;
      }
      drop.innerHTML = items.map(r => `
        <a href="${esc(r.href)}" style="display:flex; gap:10px; align-items:flex-start; padding:9px 10px; border-radius:11px; text-decoration:none; color:#201e1d;"
           onmouseover="this.style.background='#f5ead8'" onmouseout="this.style.background='transparent'">
          <span class="material-symbols-outlined" style="font-size:18px; color:#8c491a; margin-top:2px;">${ICONS[r.type] || 'search'}</span>
          <span style="min-width:0;">
            <span style="display:block; font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.title)}</span>
            <span style="display:block; font-size:12px; color:#8a7d6a; line-height:1.4; margin-top:1px;">${esc(r.snippet)}</span>
          </span>
        </a>`).join('');
      show();
    }

    async function run(q) {
      const token = getToken();
      if (!token) return;
      try {
        const res = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (q !== input.value.trim()) return; // stale response
        render(data.results || [], q);
      } catch (e) { /* server unreachable — stay quiet */ }
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { hide(); drop.innerHTML = ''; return; }
      drop.innerHTML = '<div style="padding:14px; font-size:13px; color:#8a7d6a;">Searching…</div>';
      show();
      timer = setTimeout(() => run(q), 280);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hide(); input.blur(); }
      if (e.key === 'Enter') {
        const first = drop.querySelector('a[href]');
        if (first && drop.style.display !== 'none') location.href = first.getAttribute('href');
      }
    });
    input.addEventListener('focus', show);
    document.addEventListener('mousedown', (e) => {
      if (!drop.contains(e.target) && e.target !== input) hide();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Rebind after spa_router.js swaps <main> — the search input it hooks is
  // part of the page body, not the persistent shell.
  window.fcKnowledgeSearch = { init };
})();
