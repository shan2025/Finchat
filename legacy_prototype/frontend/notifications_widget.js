// notifications_widget.js — shared notification bell behaviour.
//
// The regenerated Agents/Operations pages ship the bell markup (#notifBell,
// #notifBadge, #notifDropdown, #notifList) but lost the JS that drives it.
// This file restores it, and is safe to include on any page: every DOM lookup
// is guarded, so pages without the markup simply do nothing.
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
      briefing: 'finchat_inbox.html',
      fraud: 'finchat_audit.html',
      mission: 'finchat_agents.html',
      group_chat: 'finchat_groupchat.html',
      system: 'finchat_dashboard.html'
    };
    let notifCache = {}; // notification_id → item, so the click handler can route

    function targetFor(n) {
      if (n.link) return n.link;
      // Older approval notifications embed [execution:<id>] in the content.
      const exec = /\[execution:([^\]]+)\]/.exec(n.content || '');
      if (exec) return 'finchat_dashboard.html?execution=' + encodeURIComponent(exec[1]);
      return TYPE_LINKS[n.type] || null;
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
              <div style="font-size:12px;font-weight:700;color:#3a2e23">${n.title}</div>
              <div style="font-size:11px;color:#5c4a38;margin-top:2px;line-height:1.4">${(n.content || '').slice(0, 120)}</div>
              <div style="font-size:10px;color:#8c7a6b;font-family:ui-monospace,monospace;margin-top:3px">${timeAgo(n.created_at)}</div>
            </div>
            ${n.is_read ? '' : '<span style="width:8px;height:8px;border-radius:50%;background:#dc2626;flex-shrink:0;margin-top:4px"></span>'}
          </div>`).join('');
      } catch (e) { list.innerHTML = '<div style="padding:16px;text-align:center;color:#dc2626;font-size:12px">Failed to load</div>'; }
    }

    window.__notifClick = async function (id) {
      const n = notifCache[id];
      try { await fetch('/api/notifications/' + id + '/read', { method: 'POST', headers: { Authorization: 'Bearer ' + tok() } }); } catch (e) { }
      const dest = n ? targetFor(n) : null;
      if (dest) {
        // Same page? just refresh the list instead of a pointless reload.
        const here = location.pathname.split('/').pop();
        if (dest.split('?')[0] !== here) { location.href = dest; return; }
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
    document.addEventListener('click', (e) => {
      const dd = $('notifDropdown'), bell = $('notifBell');
      if (open && dd && !dd.contains(e.target) && bell && !bell.contains(e.target)) { dd.classList.add('hidden'); open = false; }
    });
    function bindSocket() {
      const s = window.socket || (typeof socket !== 'undefined' ? socket : null);
      if (s && !window.__notifSockBound) { s.on('notification:new', () => { refreshBadge(); if (open) loadList(); }); window.__notifSockBound = true; }
    }
    refreshBadge();
    setInterval(() => { refreshBadge(); bindSocket(); }, 12000);
    setTimeout(bindSocket, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
