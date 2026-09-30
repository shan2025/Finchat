// chat_context.js — pull other conversations into the one you're in.
//
// Ctrl+K (⌘K) in the chat, or the link button in the composer, opens a picker
// of your past chats: type to search by name or content, arrows + Enter (or
// click) to add one, Esc to close. Picked chats sit as chips above the
// composer and are sent with every message as `contextSessions`; the backend
// stores them on the conversation (ai_session_meta.context_sessions), so a
// reopened chat comes back with its chips.
//
// Links are kept per agent, like the page's personaSessions: each agent tab
// is its own conversation, so switching agents must not carry (or wipe) the
// other one's links.
(function () {
  'use strict';

  const MAX_LINKS = 5;
  let cfg = null;
  const linksByKey = {};          // key (persona id) → [{ sessionId, title, persona }]
  let pop = null, listEl = null, searchEl = null;
  let results = [], cursor = 0, fetchSeq = 0, debounce = null;

  const key = (k) => k || (cfg && cfg.getKey()) || '_';
  const esc = (s) => (cfg && cfg.esc ? cfg.esc(s) : String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m, t) => { if (cfg && cfg.toast) cfg.toast(m, t || 'info'); };

  function ago(ts) {
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (!isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function injectStyles() {
    if (document.getElementById('fcCtxStyles')) return;
    const st = document.createElement('style');
    st.id = 'fcCtxStyles';
    st.textContent = `
      #ctxChips{display:none;flex-wrap:wrap;gap:6px;padding:12px 16px 0}
      #ctxChips.has{display:flex}
      .fc-ctxchip{display:inline-flex;align-items:center;gap:6px;max-width:260px;padding:4px 6px 4px 10px;border-radius:999px;background:#f5ead8;border:1px solid #e3d3ba;color:#3a2e23;font-size:12.5px;font-weight:600}
      .fc-ctxchip .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fc-ctxchip button{border:none;background:transparent;color:#8a7d6a;cursor:pointer;display:inline-flex;padding:2px;border-radius:999px}
      .fc-ctxchip button:hover{background:#e9dcc6;color:#201e1d}
      .fc-ctxchip .t{cursor:pointer}
      .fc-ctxchip .st{font-size:11px;font-weight:600;color:#a1937f;white-space:nowrap}
      .fc-ctxchip.busy .lk{animation:fcCtxSpin 1s linear infinite}
      @keyframes fcCtxSpin{to{transform:rotate(360deg)}}
      #ctxPreview{display:none;margin:8px 16px 0;padding:10px 12px;border-radius:12px;background:#f5ead8;border:1px solid #e3d3ba;font-size:12.5px;line-height:1.5;color:#3a2e23;max-height:180px;overflow-y:auto;white-space:pre-wrap}
      #ctxPreview.open{display:block}
      #ctxPreview h1,#ctxPreview h2,#ctxPreview h3,#ctxPreview h4{font-size:12.5px;font-weight:700;margin:8px 0 2px}
      #ctxPreview ul{margin:2px 0 4px 18px;list-style:disc} #ctxPreview p{margin:2px 0} #ctxPreview hr{display:none}
      #ctxPreview > b{display:block;margin-bottom:4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#8a7d6a}
      #ctxPop{display:none;position:absolute;left:0;bottom:calc(100% + 10px);width:min(440px,100%);background:#fffaf0;border:1px solid #e3d3ba;border-radius:18px;box-shadow:0 16px 40px rgba(46,43,37,.22);z-index:45;overflow:hidden}
      #ctxPop.open{display:block}
      #ctxPop .hd{padding:12px 14px 8px;font-size:12px;font-weight:700;color:#8a7d6a;letter-spacing:.04em;text-transform:uppercase}
      #ctxPop .sr{display:flex;align-items:center;gap:8px;margin:0 10px 8px;padding:8px 12px;border-radius:12px;background:#f5ead8;border:1px solid #e3d3ba}
      #ctxPop .sr input{flex:1;min-width:0;border:none;background:transparent;outline:none;font:inherit;font-size:14px;color:#201e1d}
      #ctxPop .ls{max-height:300px;overflow-y:auto;padding:0 6px 6px}
      #ctxPop .row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;cursor:pointer}
      #ctxPop .row.cur{background:#f3e7d3}
      #ctxPop .row .av{width:26px;height:26px;border-radius:999px;background:#efe8de;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:13px}
      #ctxPop .row .av img{width:100%;height:100%;object-fit:cover}
      #ctxPop .row .tx{flex:1;min-width:0}
      #ctxPop .row .tt{font-size:13.5px;font-weight:600;color:#201e1d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #ctxPop .row .mt{font-size:11.5px;color:#a1937f}
      #ctxPop .row .ck{color:var(--accent,#c2410c);visibility:hidden}
      #ctxPop .row.sel .ck{visibility:visible}
      #ctxPop .em{padding:18px 12px;text-align:center;font-size:13px;color:#a1937f}
      #ctxPop .ft{padding:8px 14px;border-top:1px solid #efe3cf;font-size:11px;color:#a1937f}
      #ctxPop kbd{font-family:inherit;padding:1px 5px;border-radius:5px;border:1px solid #e3d3ba;background:#f5ead8;font-size:10.5px}
    `;
    document.head.appendChild(st);
  }

  function ensureDom() {
    const box = document.getElementById('composerBox');
    const input = document.getElementById('msgInput');
    if (!box || !input) return false;
    if (!getComputedStyle(box).position || getComputedStyle(box).position === 'static') box.style.position = 'relative';
    if (!document.getElementById('ctxChips')) {
      const chips = document.createElement('div');
      chips.id = 'ctxChips';
      box.insertBefore(chips, input);
      const prev = document.createElement('div');
      prev.id = 'ctxPreview';
      box.insertBefore(prev, input);
      chips.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ctx-remove]');
        if (b) { remove(b.dataset.ctxRemove); input.focus(); return; }
        const chip = e.target.closest('[data-ctx-id]');
        if (chip) showPreview(chip.dataset.ctxId);
      });
    }
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'ctxPop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Add another chat as context');
      pop.innerHTML = `
        <div class="hd">Add a chat as context</div>
        <div class="sr"><span class="material-symbols-outlined" style="font-size:18px;color:#a1937f">search</span>
          <input id="ctxSearch" type="text" placeholder="Search your chats by name or content…" autocomplete="off"></div>
        <div class="ls" id="ctxList" role="listbox"></div>
        <div class="ft"><kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> add/remove · <kbd>Esc</kbd> close · up to ${MAX_LINKS} chats</div>`;
      box.appendChild(pop);
      listEl = pop.querySelector('#ctxList');
      searchEl = pop.querySelector('#ctxSearch');
      searchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => load(searchEl.value.trim()), 220);
      });
      searchEl.addEventListener('keydown', onSearchKey);
      listEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-idx]');
        if (row) { cursor = +row.dataset.idx; toggle(results[cursor]); }
      });
      document.addEventListener('mousedown', (e) => {
        if (!pop.classList.contains('open')) return;
        if (pop.contains(e.target) || e.target.closest('#ctxBtn')) return;
        close();
      });
    }
    return true;
  }

  function onSearchKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[cursor]) toggle(results[cursor]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  }

  function move(d) {
    if (!results.length) return;
    cursor = (cursor + d + results.length) % results.length;
    paintList();
    const cur = listEl.querySelector('.row.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  async function load(q) {
    const seq = ++fetchSeq;
    const token = cfg.getToken();
    if (!token) { listEl.innerHTML = '<div class="em">Sign in to link chats.</div>'; return; }
    if (!results.length) listEl.innerHTML = '<div class="em">Loading your chats…</div>';
    try {
      const url = `${cfg.apiUrl}/api/ai-chat/sessions?limit=50${q ? '&q=' + encodeURIComponent(q) : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (seq !== fetchSeq) return; // a newer search already won
      if (!res.ok) { listEl.innerHTML = '<div class="em">Could not load your chats.</div>'; return; }
      const data = await res.json();
      const current = cfg.getSessionId();
      results = (data.sessions || []).filter(s => s.session_id !== current);
      cursor = 0;
      paintList(q);
    } catch (e) {
      if (seq === fetchSeq) listEl.innerHTML = '<div class="em">Could not load your chats.</div>';
    }
  }

  function paintList(q) {
    if (!results.length) {
      listEl.innerHTML = `<div class="em">${q ? 'No chats match “' + esc(q) + '”.' : 'No other chats yet.'}</div>`;
      return;
    }
    const picked = new Set(ids());
    listEl.innerHTML = results.map((s, i) => {
      const p = cfg.personas && cfg.personas[s.persona];
      const av = p ? p.avatar : esc(s.personaAvatar || '🤖');
      return `<div class="row${i === cursor ? ' cur' : ''}${picked.has(s.session_id) ? ' sel' : ''}" data-idx="${i}" role="option" aria-selected="${picked.has(s.session_id)}">
        <span class="av">${av}</span>
        <span class="tx"><div class="tt">${esc(s.title)}</div><div class="mt">${esc(s.personaName || s.persona)} · ${ago(s.last_message_at)}</div></span>
        <span class="material-symbols-outlined ck" style="font-size:20px">check_circle</span>
      </div>`;
    }).join('');
  }

  function toggle(s) {
    if (!s) return;
    const list = linksByKey[key()] || [];
    if (list.some(l => l.sessionId === s.session_id)) {
      remove(s.session_id);
    } else {
      if (list.length >= MAX_LINKS) { toast(`Up to ${MAX_LINKS} chats can be linked`, 'warn'); return; }
      linksByKey[key()] = [...list, { sessionId: s.session_id, title: s.title, persona: s.persona }];
      render();
      compactPending();
    }
    paintList(searchEl && searchEl.value.trim());
  }

  function render() {
    if (!ensureDom()) return;
    const chips = document.getElementById('ctxChips');
    const list = linksByKey[key()] || [];
    chips.classList.toggle('has', list.length > 0);
    chips.innerHTML = list.map(l => {
      const busy = compacting.has(l.sessionId);
      const status = busy ? 'compacting…' : l.summary ? 'compacted' : l.failed ? 'raw' : '';
      const tip = busy ? 'Compacting this chat into a summary…'
        : l.summary ? 'Compacted — click to read what the agent gets'
        : l.failed ? 'Could not compact — the agent reads its latest messages instead'
        : `The agent reads “${l.title}” before answering`;
      return `
      <span class="fc-ctxchip${busy ? ' busy' : ''}" data-ctx-id="${esc(l.sessionId)}" title="${esc(tip)}">
        <span class="material-symbols-outlined lk" style="font-size:15px;color:#8a7d6a">${busy ? 'progress_activity' : 'link'}</span>
        <span class="t">${esc(l.title || 'Untitled conversation')}</span>
        ${status ? `<span class="st">· ${status}</span>` : ''}
        <button type="button" data-ctx-remove="${esc(l.sessionId)}" aria-label="Remove ${esc(l.title)}"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>
      </span>`;
    }).join('');
    const prev = document.getElementById('ctxPreview');
    if (prev && prev.classList.contains('open') && !list.some(l => l.sessionId === prev.dataset.id)) {
      prev.classList.remove('open');
    }
    const btn = document.getElementById('ctxBtn');
    if (btn) btn.style.color = list.length ? 'var(--accent,#c2410c)' : '';
  }

  function open() {
    if (!cfg || !ensureDom()) return;
    pop.classList.add('open');
    searchEl.value = '';
    results = []; cursor = 0;
    load('');
    requestAnimationFrame(() => searchEl.focus());
  }

  function close(refocus) {
    if (!pop) return;
    pop.classList.remove('open');
    if (refocus) { const mi = document.getElementById('msgInput'); if (mi) mi.focus(); }
  }

  // Compact each newly linked chat right away, so the summary is ready (and
  // already learned into the knowledge graph) before the user hits send.
  const compacting = new Set();
  function compactPending() {
    const token = cfg && cfg.getToken();
    if (!token) return;
    const pending = (linksByKey[key()] || []).filter(l => !l.summary && !l.failed && !compacting.has(l.sessionId));
    for (const l of pending) {
      compacting.add(l.sessionId);
      render();
      fetch(`${cfg.apiUrl}/api/ai-chat/sessions/${encodeURIComponent(l.sessionId)}/compact`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }
      })
        .then(r => r.json().then(d => ({ ok: r.ok, d })))
        .then(({ ok, d }) => applyCompaction(l.sessionId, ok && d.summary ? d.summary : null))
        .catch(() => applyCompaction(l.sessionId, null))
        .finally(() => { compacting.delete(l.sessionId); render(); });
    }
  }
  function applyCompaction(sessionId, summary) {
    // The user may have switched agents meanwhile — update every list holding it.
    for (const list of Object.values(linksByKey)) {
      for (const l of list) {
        if (l.sessionId !== sessionId) continue;
        if (summary) { l.summary = summary; l.failed = false; } else l.failed = true;
      }
    }
    if (!summary) toast('Could not compact that chat — the agent will read its latest messages instead', 'warn');
  }

  function showPreview(sessionId) {
    const prev = document.getElementById('ctxPreview');
    const l = (linksByKey[key()] || []).find(x => x.sessionId === sessionId);
    if (!prev || !l) return;
    if (prev.classList.contains('open') && prev.dataset.id === sessionId) { prev.classList.remove('open'); return; }
    prev.dataset.id = sessionId;
    const md = l.summary && window.marked && window.DOMPurify;
    prev.style.whiteSpace = md ? 'normal' : '';
    prev.innerHTML = `<b>What the agent gets from “${esc(l.title)}”</b>` + (l.summary
      ? (md ? DOMPurify.sanitize(marked.parse(l.summary)) : esc(l.summary))
      : compacting.has(sessionId) ? 'Compacting…' : 'Not compacted — the agent reads the latest messages of this chat.');
    prev.classList.add('open');
  }

  function ids(k) { return (linksByKey[key(k)] || []).map(l => l.sessionId); }
  function set(list, k) {
    const old = new Map((linksByKey[key(k)] || []).map(l => [l.sessionId, l]));
    linksByKey[key(k)] = (Array.isArray(list) ? list : []).slice(0, MAX_LINKS)
      .map(l => ({
        sessionId: l.sessionId, title: l.title, persona: l.persona,
        summary: l.summary || old.get(l.sessionId)?.summary || null
      }));
    render();
    if (!k || k === key()) compactPending();
  }
  function clear(k) { delete linksByKey[key(k)]; render(); }
  function remove(sessionId, k) {
    linksByKey[key(k)] = (linksByKey[key(k)] || []).filter(l => l.sessionId !== sessionId);
    render();
  }

  // Ctrl+K / ⌘K toggles the picker from anywhere on the chat page.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      if (!cfg || !document.getElementById('msgInput')) return;
      e.preventDefault();
      if (pop && pop.classList.contains('open')) close(true); else open();
    }
  });

  window.fcChatContext = {
    init(options) { cfg = options; injectStyles(); render(); },
    open, close, ids, set, clear, remove, render,
    toggle() { if (pop && pop.classList.contains('open')) close(true); else open(); }
  };
})();
