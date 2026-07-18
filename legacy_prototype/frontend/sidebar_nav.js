// sidebar_nav.js — shared sidebar for every FinChat page, matching the chat
// page's design (dark warm rail: brand, New chat, Recent, Navigation, System,
// profile card). The chat page keeps its own inline copy (it wires Recents into
// the live conversation); every OTHER page includes this file and gets its
// #sideNav rebuilt in place. Shared-JS pattern: survives design-tool regens —
// if a regen wipes the include, re-add <script src="sidebar_nav.js"></script>.
(function () {
  var API = (typeof window.API_URL === 'string' && window.API_URL)
    ? window.API_URL
    : (location.protocol.indexOf('http') === 0 ? location.origin : 'http://localhost:3000');

  function getSession() {
    try {
      var raw = sessionStorage.getItem('finchat_user') || localStorage.getItem('finchat_session');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PAGE_KEYS = [
    ['finchat_dashboard', 'operations'],
    ['finchat_agents', 'agents'],
    ['finchat_chat', 'chat'],
    ['finchat_neuralmap', 'neuralmap'],
    ['finchat_neuralnetwork', 'neuralmap'], // Model Lab lives under Neural Map
    ['finchat_audit', 'audit'],
    ['finchat_inbox', 'chat']
  ];
  function activeKey() {
    var p = location.pathname.toLowerCase();
    for (var i = 0; i < PAGE_KEYS.length; i++) {
      if (p.indexOf(PAGE_KEYS[i][0]) >= 0) return PAGE_KEYS[i][1];
    }
    return '';
  }

  var AGENT_AVATARS = {
    plato: 'plato_avatar.png', aurelius: 'aurelius_avatar.png',
    rasha: 'rasha_avatar.png', nova: 'nova_avatar.png'
  };

  var CSS = [
    ':root { --sbn-bg:#2a241d; --sbn-fg:#efe6d6; --sbn-muted:#a99e88; --sbn-accent:#c67139; --sbn-accent-hover:#b2622d; }',
    '#sideNav.sbn { background:var(--sbn-bg) !important; color:var(--sbn-fg) !important; overflow-x:hidden; padding:0 !important; display:flex; flex-direction:column; }',
    '.sbn-label { font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--sbn-muted); padding:8px 12px 6px; font-weight:700; }',
    '.sbn-item { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:12px; color:#cfc3ad; font-size:14px; font-weight:600; text-decoration:none; cursor:pointer; transition:background .14s ease, color .14s ease; }',
    '.sbn-item:hover { background:rgba(255,255,255,.07); }',
    '.sbn-item.sbn-active { background:var(--sbn-accent); color:#fff; font-weight:700; box-shadow:0 6px 16px rgba(140,73,26,.32); }',
    '.sbn-item.sbn-soon { color:#867a63; cursor:default; }',
    '.sbn-item.sbn-soon:hover { background:transparent; }',
    '.sbn-soonbadge { margin-left:auto; font-size:9px; letter-spacing:.1em; padding:3px 7px; border-radius:999px; background:rgba(239,230,214,.1); color:var(--sbn-muted); }',
    '.sbn-recent { display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:12px; color:#cfc3ad; font-size:13px; font-weight:500; text-decoration:none; cursor:pointer; transition:background .14s ease; }',
    '.sbn-recent:hover { background:rgba(255,255,255,.07); }',
    '.sbn-newchat { width:100%; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:11px; border-radius:999px; border:none; background:var(--sbn-accent); color:#fff; font-family:inherit; font-weight:700; font-size:13.5px; cursor:pointer; }',
    '.sbn-newchat:hover { background:var(--sbn-accent-hover); }',
    '.sbn-truncate { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }',
    '.sbn-serif { font-family:"Caprasimo", serif; }',
    // Drawer behaviour on narrow screens (idempotent with pages that already
    // ship the same rules; pages without a #navToggle simply keep it closed,
    // which matches their previous hidden-below-md behaviour).
    '@media (max-width:767px) { #sideNav.sbn { transform:translateX(-100%); transition:transform .25s; z-index:60; } #sideNav.sbn.open { transform:translateX(0); box-shadow:0 20px 60px rgba(0,0,0,.45); } }',
    '@media (min-width:768px) { #sideNav.sbn { transform:none !important; } }'
  ].join('\n');

  function ensureFont() {
    if (document.querySelector('link[href*="Caprasimo"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Caprasimo&display=swap';
    document.head.appendChild(l);
  }

  function ensureIcons() {
    if (document.querySelector('link[href*="Material+Symbols"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';
    document.head.appendChild(l);
  }

  function navItem(key, href, icon, label) {
    var act = activeKey() === key;
    return '<a class="sbn-item' + (act ? ' sbn-active' : '') + '" href="' + href + '">' +
      '<span class="material-symbols-outlined" style="font-size:20px;' + (act ? "font-variation-settings:'FILL' 1;" : '') + '">' + icon + '</span> ' + label + '</a>';
  }
  function soonItem(icon, label) {
    return '<div class="sbn-item sbn-soon"><span class="material-symbols-outlined" style="font-size:20px;">' + icon + '</span> <span style="flex:1;">' + label + '</span> <span class="sbn-soonbadge">SOON</span></div>';
  }

  function build() {
    var nav = document.getElementById('sideNav');
    if (!nav) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    ensureFont();
    ensureIcons();

    // Normalize the shell: same geometry on every page, drawer classes intact.
    nav.classList.add('sbn');
    nav.classList.remove('py-8', 'px-4', 'bg-primary-brown', 'text-cream-bg', 'hidden', 'md:flex');
    if (!nav.classList.contains('flex')) nav.classList.add('flex');

    var sess = getSession() || {};
    var name = sess.name || 'User';
    var role = sess.role || 'user';
    var initials = String(name).split(' ').map(function (w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
    var roleLabel = role === 'admin' ? 'Admin • Internal' : role === 'auditor' ? 'Auditor • Internal' : 'Staff • Internal';

    nav.innerHTML =
      '<div style="padding:22px 22px 14px;">' +
        '<div class="sbn-serif" style="font-size:27px; line-height:1; letter-spacing:-.01em; color:#f3ead9;">FinChat</div>' +
        '<div style="font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--sbn-muted); margin-top:7px;">AI Operating System</div>' +
      '</div>' +
      '<div style="padding:4px 14px 12px;">' +
        '<button class="sbn-newchat" onclick="location.href=\'finchat_chat.html\'">' +
          '<span class="material-symbols-outlined" style="font-size:18px;">add</span> New chat' +
        '</button>' +
      '</div>' +
      '<div style="padding:0 14px 12px;">' +
        '<div class="sbn-label" style="margin-bottom:2px;">Recent</div>' +
        '<div id="sbnRecent" style="display:flex; flex-direction:column; gap:2px; max-height:150px; overflow-y:auto;">' +
          '<div style="padding:8px 12px; font-size:12px; color:var(--sbn-muted);">Loading…</div>' +
        '</div>' +
      '</div>' +
      '<div style="flex:1; overflow-y:auto; padding:8px 14px;">' +
        '<div class="sbn-label">Navigation</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          navItem('operations', 'finchat_dashboard.html', 'dashboard', 'Operations') +
          navItem('agents', 'finchat_agents.html', 'smart_toy', 'Agents') +
          navItem('chat', 'finchat_chat.html', 'chat', 'Chat') +
          navItem('neuralmap', 'finchat_neuralmap.html', 'hub', 'Neural Map') +
          soonItem('assessment', 'Reports') +
          soonItem('menu_book', 'Knowledge') +
          soonItem('account_balance', 'Governance') +
          soonItem('account_tree', 'Blockchain') +
          navItem('audit', 'finchat_audit.html', 'policy', 'Audit Logs') +
        '</div>' +
        '<div class="sbn-label" style="padding-top:20px;">System</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          soonItem('settings', 'Settings') +
          soonItem('help', 'Support') +
        '</div>' +
      '</div>' +
      '<div style="padding:12px 14px 16px; border-top:1px solid rgba(239,230,214,.14);">' +
        '<div class="sbn-item" id="sbnProfile" style="padding:9px 10px; border-radius:14px;">' +
          '<div id="sbnAvatar" style="width:38px; height:38px; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; flex-shrink:0; background:linear-gradient(135deg,#d67f48,#8c491a); color:#fff; font-size:15px;" class="sbn-serif">' + esc(initials) + '</div>' +
          '<div style="flex:1; overflow:hidden;">' +
            '<div class="sbn-truncate" style="font-size:14px; font-weight:700; color:#f3ead9;">' + esc(name) + '</div>' +
            '<div class="sbn-truncate" style="font-size:11px; color:var(--sbn-muted); margin-top:1px;">' + roleLabel + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Avatar: render cached one, then refresh from the server (it's the source
    // of truth — cached sessions can predate an avatar upload).
    function setAvatar(url) {
      var el = document.getElementById('sbnAvatar');
      if (el && url) {
        el.style.background = 'none';
        el.innerHTML = '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
      }
    }
    if (sess.avatar_url) setAvatar(sess.avatar_url);
    if (sess.token) {
      fetch(API + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + sess.token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.user && d.user.avatar_url) {
            setAvatar(d.user.avatar_url);
            try {
              sess.avatar_url = d.user.avatar_url;
              if (sessionStorage.getItem('finchat_user')) sessionStorage.setItem('finchat_user', JSON.stringify(sess));
              if (localStorage.getItem('finchat_session')) localStorage.setItem('finchat_session', JSON.stringify(sess));
            } catch (e) {}
          }
        }).catch(function () {});

      // Recents — real Supabase sessions; deep-link into the chat page.
      fetch(API + '/api/ai-chat/sessions', { headers: { 'Authorization': 'Bearer ' + sess.token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var list = document.getElementById('sbnRecent');
          if (!list) return;
          var sessions = (d && d.sessions || []).slice(0, 6);
          if (!sessions.length) {
            list.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:var(--sbn-muted);">No conversations yet</div>';
            return;
          }
          list.innerHTML = sessions.map(function (s) {
            var av = AGENT_AVATARS[s.persona]
              ? '<span style="width:24px; height:24px; border-radius:999px; overflow:hidden; flex-shrink:0; background:#efe8de; display:inline-flex;"><img src="' + AGENT_AVATARS[s.persona] + '" style="width:100%;height:100%;object-fit:cover;"></span>'
              : '<span style="width:24px; height:24px; border-radius:999px; flex-shrink:0; background:#efe8de; display:inline-flex; align-items:center; justify-content:center; font-size:12px;">' + esc(s.personaAvatar || '🤖') + '</span>';
            return '<a class="sbn-recent" href="finchat_chat.html?session=' + encodeURIComponent(s.session_id) + '" title="' + esc(s.title) + ' — ' + esc(s.personaName || s.persona) + '">' +
              av + '<span class="sbn-truncate">' + esc(s.title) + '</span></a>';
          }).join('');
        }).catch(function () {});
    }

    // Close the drawer when a nav link is tapped (pages bound this to the OLD
    // links before we rebuilt the sidebar).
    var bd = document.getElementById('navBackdrop');
    nav.querySelectorAll('a[href]').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.classList.remove('open');
        if (bd) bd.classList.add('hidden');
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
