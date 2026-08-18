// notifications_widget.js — shared notification bell behaviour.
//
// The regenerated Agents/Operations pages ship the bell markup (#notifBell,
// #notifBadge, #notifDropdown, #notifList) but lost the JS that drives it.
// This file restores it, and is safe to include on any page: every DOM lookup
// is guarded, so pages without the markup simply do nothing.
// file:// fallback — route root-relative "/api/…" fetches to the local backend
// when a page is opened directly from disk. Global + idempotent; no-op over http.
(function(){ if(location.protocol==='file:'&&!window.__apiFileFix){ window.__apiFileFix=true; var _f=window.fetch.bind(window);
  window.fetch=function(u,o){ try{ if(typeof u==='string'&&u.charAt(0)==='/') u='http://localhost:3000'+u; }catch(e){} return _f(u,o); }; } })();
(function () {
  function init() {
    if (!document.getElementById('notifBell')) return; // no bell on this page
    const tok = () => localStorage.getItem('finchat_token') || sessionStorage.getItem('finchat_token') ||
      (JSON.parse(sessionStorage.getItem('finchat_user') || 'null') || {}).token || '';
    const $ = (id) => document.getElementById(id);
    let open = false;

    function timeAgo(ts) {
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    }

    async function refreshBadge() {
      try {
        const r = await fetch('/api/notifications/unread-count', { headers: { Authorization: 'Bearer ' + tok() } });
        if (!r.ok) return;
        const d = await r.json();
        const badge = $('notifBadge');
        if (!badge) return;
        if (d.count > 0) { badge.textContent = d.count > 99 ? '99+' : d.count; badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
      } catch (e) { }
    }

    // Where each notification type takes you when clicked. A notification can
    // also carry an explicit `link` (added in migration 018) which wins.
    const TYPE_LINKS = {
      approval: 'finchat_dashboard.html',   // approval gate lives on Operations
      debate: 'finchat_dashboard.html',
      briefing: 'finchat_chat.html',
      fraud: 'finchat_audit.html',
      mission: 'finchat_agents.html',
      group_chat: 'finchat_groupchat.html',
      system: 'finchat_dashboard.html'
    };
    let notifCache = {}; // notification_id → item, so the click handler can route

    // Types whose whole payload IS the report text — the notification content
    // already carries the FULL body (same thing sent to email/Telegram). For
    // these, when there's no better destination (see the !n.link guard in the
    // click handler), we show the report in a modal instead of dumping the user
    // on a page where only a truncated teaser is visible. Briefings are excluded
    // because they carry an explicit link to the chat session that holds them.
    const REPORT_TYPES = { mission: 1 };

    function targetFor(n) {
      if (n.link) return n.link;
      // Older approval notifications embed [execution:<id>] in the content.
      const exec = /\[execution:([^\]]+)\]/.exec(n.content || '');
      if (exec) return 'finchat_dashboard.html?execution=' + encodeURIComponent(exec[1]);
      return TYPE_LINKS[n.type] || null;
    }

    // Full-report modal. Renders markdown when marked+DOMPurify are present
    // (as on the Agents page), else falls back to escaped text with <br>.
    function escHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // One-line teaser for the dropdown. Notification bodies are markdown (the
    // same text sent to email/Telegram), so slicing the raw source showed
    // literal "# 🧠 Frontier Research…" and "**bold**" in the list.
    function mdSnippet(md, max) {
      const t = String(md == null ? '' : md)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '• ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, url) => txt.trim() || url)
        .replace(/(\*\*\*|\*\*|__|~~)(.+?)\1/g, '$2')
        .replace(/(^|[\s(])[*_]([^*_\n]+)[*_]/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*(?:[-*_]\s*){3,}\s*$/gm, ' ')
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return escHtml(t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t);
    }
    // Minimal markdown → HTML, self-contained on purpose. Only 5 of the 13
    // pages that ship this widget load marked+DOMPurify, so on the rest the
    // modal used to dump raw "## …" / "**…**" source. Input is HTML-escaped
    // FIRST and no raw HTML is ever passed through, so the output is safe
    // without a sanitizer.
    const MD_HREF_OK = /^(https?:|mailto:|\/|#)/i;
    function mdInline(s) {
      const codes = [];
      let t = escHtml(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
      t = t
        // URL body allows one level of nested parens, so Wikipedia-style
        // "…/Foo_(bar)" links don't leave a stray ")" in the text.
        .replace(/!\[[^\]]*\]\(\s*(?:[^()\s]|\([^()\s]*\))*(?:\s+&quot;[^&]*&quot;)?\s*\)/g, '')
        .replace(/\[([^\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (m, txt, url) =>
          MD_HREF_OK.test(url) ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>' : txt)
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>')
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
      return t.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[i] + '</code>');
    }
    function mdToHtml(src) {
      const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
      const isSep = (s) => s != null && /\|/.test(s) && /-/.test(s) && /^[\s|:-]+$/.test(s);
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const out = [];
      let para = [], list = null, quote = null, code = null;
      const softJoin = (arr) => mdInline(arr.join('\n')).replace(/\n/g, '<br>');
      const flushPara = () => { if (para.length) { out.push('<p>' + softJoin(para) + '</p>'); para = []; } };
      const flushList = () => {
        if (!list) return;
        out.push('<' + list.tag + '>' + list.items.map(i => '<li>' + mdInline(i) + '</li>').join('') + '</' + list.tag + '>');
        list = null;
      };
      const flushQuote = () => { if (quote) { out.push('<blockquote>' + softJoin(quote) + '</blockquote>'); quote = null; } };
      const flushAll = () => { flushPara(); flushList(); flushQuote(); };

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i], line = raw.trim();
        if (/^```/.test(line)) {
          if (code) { out.push('<pre><code>' + escHtml(code.join('\n')) + '</code></pre>'); code = null; }
          else { flushAll(); code = []; }
          continue;
        }
        if (code) { code.push(raw); continue; }
        if (!line) { flushAll(); continue; }

        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) { flushAll(); const l = h[1].length; out.push('<h' + l + '>' + mdInline(h[2].replace(/\s+#+\s*$/, '')) + '</h' + l + '>'); continue; }
        if (/^([-*_])\s*(?:\1\s*){2,}$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

        if (line.indexOf('|') !== -1 && isSep(lines[i + 1])) {
          flushAll();
          const head = cells(line);
          const rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) { rows.push(cells(lines[i])); i++; }
          i--;
          out.push('<table><thead><tr>' + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>' +
            rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
          continue;
        }

        const ul = /^[-*+]\s+(.*)$/.exec(line);
        const ol = /^\d+[.)]\s+(.*)$/.exec(line);
        if (ul || ol) {
          flushPara(); flushQuote();
          const tag = ul ? 'ul' : 'ol';
          if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
          list.items.push((ul || ol)[1]);
          continue;
        }
        // Wrapped continuation of the previous list item (indented, not a new bullet).
        if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + line; continue; }

        const bq = /^>\s?(.*)$/.exec(line);
        if (bq) { flushPara(); flushList(); if (!quote) quote = []; quote.push(bq[1]); continue; }

        flushList(); flushQuote();
        para.push(line);
      }
      if (code) out.push('<pre><code>' + escHtml(code.join('\n')) + '</code></pre>');
      flushAll();
      return out.join('');
    }

    // Report styles live with the widget too: `.markdown-body` is only defined
    // on a few pages, and Tailwind's preflight resets heading sizes and list
    // bullets everywhere else. Scoped by #id so it wins on the pages that do.
    function ensureReportStyles() {
      if (document.getElementById('notifReportStyles')) return;
      const st = document.createElement('style');
      st.id = 'notifReportStyles';
      st.textContent = [
        '#notifReportModal .markdown-body{word-wrap:break-word}',
        '#notifReportModal .markdown-body>*:first-child{margin-top:0}',
        '#notifReportModal .markdown-body>*:last-child{margin-bottom:0}',
        '#notifReportModal .markdown-body h1,#notifReportModal .markdown-body h2,#notifReportModal .markdown-body h3,',
        '#notifReportModal .markdown-body h4,#notifReportModal .markdown-body h5,#notifReportModal .markdown-body h6',
        '{font-weight:800;color:#3a2e23;line-height:1.3;margin:1.15em 0 .45em}',
        '#notifReportModal .markdown-body h1{font-size:1.3em}',
        '#notifReportModal .markdown-body h2{font-size:1.15em}',
        '#notifReportModal .markdown-body h3{font-size:1.05em}',
        '#notifReportModal .markdown-body h4,#notifReportModal .markdown-body h5,#notifReportModal .markdown-body h6{font-size:1em}',
        '#notifReportModal .markdown-body p{margin:0 0 .6em}',
        '#notifReportModal .markdown-body ul{list-style:disc;padding-left:1.4em;margin:0 0 .6em}',
        '#notifReportModal .markdown-body ol{list-style:decimal;padding-left:1.6em;margin:0 0 .6em}',
        '#notifReportModal .markdown-body li{margin:.2em 0}',
        '#notifReportModal .markdown-body strong{font-weight:700;color:#2f261d}',
        '#notifReportModal .markdown-body em{font-style:italic}',
        '#notifReportModal .markdown-body a{color:#8c491a;text-decoration:underline;text-underline-offset:2px}',
        '#notifReportModal .markdown-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:rgba(74,56,40,.08);padding:1px 5px;border-radius:4px}',
        '#notifReportModal .markdown-body pre{background:rgba(74,56,40,.08);padding:10px 12px;border-radius:8px;overflow-x:auto;margin:0 0 .7em}',
        '#notifReportModal .markdown-body pre code{background:transparent;padding:0}',
        '#notifReportModal .markdown-body blockquote{border-left:3px solid #d9cbb2;padding-left:12px;margin:0 0 .7em;color:#5c4a38}',
        '#notifReportModal .markdown-body hr{border:none;border-top:1px solid #e6dcc8;margin:1.1em 0}',
        '#notifReportModal .markdown-body table{width:100%;border-collapse:collapse;margin:0 0 .8em;font-size:.95em;display:block;overflow-x:auto}',
        '#notifReportModal .markdown-body th,#notifReportModal .markdown-body td{border:1px solid #e6dcc8;padding:6px 9px;text-align:left;vertical-align:top}',
        '#notifReportModal .markdown-body th{background:rgba(74,56,40,.06);font-weight:700}'
      ].join('');
      document.head.appendChild(st);
    }

    function showReport(n) {
      let ov = $('notifReportModal');
      if (ov) ov.remove();
      ensureReportStyles();
      const body = (window.marked && window.DOMPurify)
        ? DOMPurify.sanitize(marked.parse(n.content || ''), { ADD_ATTR: ['target'] })
        : mdToHtml(n.content || '');
      ov = document.createElement('div');
      ov.id = 'notifReportModal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:24px;';
      ov.innerHTML =
        '<div style="background:#fffaf0;max-width:760px;width:100%;max-height:85vh;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;">' +
          '<div style="display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid #e6dcc8;">' +
            '<div style="flex:1;min-width:0;font-size:15px;font-weight:800;color:#3a2e23;">' + escHtml(n.title || 'Report') + '</div>' +
            '<button id="notifReportClose" style="border:none;background:transparent;font-size:22px;line-height:1;color:#8c7a6b;cursor:pointer;">&times;</button>' +
          '</div>' +
          '<div class="markdown-body" style="padding:20px 24px;overflow-y:auto;font-size:14px;line-height:1.55;color:#3a2e23;">' + body + '</div>' +
        '</div>';
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.addEventListener('click', e => { if (e.target === ov) close(); });
      $('notifReportClose').onclick = close;
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });
    }

    async function loadList() {
      const list = $('notifList');
      if (!list) return;
      list.innerHTML = '<div style="padding:16px;text-align:center;color:#8c7a6b;font-size:12px">Loading…</div>';
      try {
        const r = await fetch('/api/notifications?limit=20', { headers: { Authorization: 'Bearer ' + tok() } });
        const d = await r.json();
        const items = d.notifications || [];
        notifCache = {};
        items.forEach(n => { notifCache[n.notification_id] = n; });
        if (!items.length) { list.innerHTML = '<div style="padding:24px;text-align:center;color:#8c7a6b;font-size:12px">No notifications yet</div>'; return; }
        list.innerHTML = items.map(n => `
          <div onclick="__notifClick('${n.notification_id}')" style="padding:12px 16px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;${n.is_read ? 'opacity:0.55' : 'background:rgba(212,175,55,0.08)'}">
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:700;color:#3a2e23">${escHtml(n.title)}</div>
              <div style="font-size:11px;color:#5c4a38;margin-top:2px;line-height:1.4">${mdSnippet(n.content, 120)}</div>
              <div style="font-size:10px;color:#8c7a6b;font-family:ui-monospace,monospace;margin-top:3px">${timeAgo(n.created_at)}</div>
            </div>
            ${n.is_read ? '' : '<span style="width:8px;height:8px;border-radius:50%;background:#dc2626;flex-shrink:0;margin-top:4px"></span>'}
          </div>`).join('');
      } catch (e) { list.innerHTML = '<div style="padding:16px;text-align:center;color:#dc2626;font-size:12px">Failed to load</div>'; }
    }

    window.__notifClick = async function (id) {
      const n = notifCache[id];
      try { await fetch('/api/notifications/' + id + '/read', { method: 'POST', headers: { Authorization: 'Bearer ' + tok() } }); } catch (e) { }
      // Report/briefing notifications carry the full body — show it in place
      // instead of navigating to a page where only a teaser is visible.
      if (n && REPORT_TYPES[n.type] && !n.link && (n.content || '').trim()) {
        const dd = $('notifDropdown'); if (dd) { dd.classList.add('hidden'); open = false; }
        showReport(n);
        await loadList(); refreshBadge();
        return;
      }
      const dest = n ? targetFor(n) : null;
      if (dest) {
        // Same page AND same query (e.g. same ?session=)? just refresh the
        // list instead of a pointless reload. If only the page matches but
        // the query differs (e.g. a different ?session=<id>), we still need
        // to navigate so the page picks up the new deep-link param.
        const here = location.pathname.split('/').pop() + location.search;
        if (dest !== here) { location.href = dest; return; }
      }
      await loadList(); refreshBadge();
    };
    window.markAllNotifsRead = async function () {
      try { await fetch('/api/notifications/read-all', { method: 'POST', headers: { Authorization: 'Bearer ' + tok() } }); } catch (e) { }
      await loadList(); refreshBadge();
    };
    window.toggleNotifications = function (e) {
      if (e) e.stopPropagation();
      const dd = $('notifDropdown'); if (!dd) return;
      open = !open; dd.classList.toggle('hidden', !open);
      if (open) loadList();
    };
    // Close-on-outside-click binds to `document`, which outlives any single
    // view — so re-running init() after an SPA swap would stack one stale
    // listener per navigation, each closing over a dead `open` flag. The live
    // handler is swapped through a slot instead, leaving exactly one listener
    // for the life of the document.
    window.__notifCloseOnOutside = (e) => {
      const dd = $('notifDropdown'), bell = $('notifBell');
      if (open && dd && !dd.contains(e.target) && bell && !bell.contains(e.target)) { dd.classList.add('hidden'); open = false; }
    };
    if (!window.__notifDocBound) {
      window.__notifDocBound = true;
      document.addEventListener('click', (e) => window.__notifCloseOnOutside(e));
    }
    function bindSocket() {
      const s = window.socket || (typeof socket !== 'undefined' ? socket : null);
      if (s && !window.__notifSockBound) { s.on('notification:new', () => { refreshBadge(); if (open) loadList(); }); window.__notifSockBound = true; }
    }
    refreshBadge();
    // Egress guard: skip the network poll while the tab is hidden; socket push
    // still delivers new notifications instantly when the tab is open.
    setInterval(() => { if (!document.hidden) refreshBadge(); bindSocket(); }, 30000);
    setTimeout(bindSocket, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // The bell lives inside the page's <main>, which spa_router.js replaces on a
  // client-side navigation. Re-running init() rebinds to the new element; the
  // 30s poll above is registered once per init, so the router tears the old
  // view's timers down before calling this.
  window.fcNotifications = { init };
})();
