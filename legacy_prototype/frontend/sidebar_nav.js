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
    ['finchat_groupchat', 'groupchat'],
    ['finchat_neuralmap', 'neuralmap'],
    ['finchat_neuralnetwork', 'neuralmap'], // Model Lab lives under Neural Map
    ['finchat_blockchain', 'blockchain'],
    ['finchat_settings', 'settings'],
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
    // Espresso (default, dark) theme vars — the cream theme overrides them below.
    '#sideNav.sbn { --sbn-bg:#2a241d; --sbn-fg:#efe6d6; --sbn-muted:#a99e88; --sbn-accent:#c67139; --sbn-accent-hover:#b2622d; --sbn-item:#cfc3ad; --sbn-hover:rgba(255,255,255,.07); --sbn-soon:#867a63; --sbn-badge:rgba(239,230,214,.1); --sbn-line:rgba(239,230,214,.14); }',
    // Cream (light) theme — from the app design system\'s cream family.
    '#sideNav.sbn.sbn-cream { --sbn-bg:#f3eee3; --sbn-fg:#3a2e23; --sbn-muted:#8c7a6b; --sbn-accent:#c67139; --sbn-accent-hover:#b2622d; --sbn-item:#5c4a38; --sbn-hover:rgba(58,46,35,.07); --sbn-soon:#b3a693; --sbn-badge:rgba(58,46,35,.08); --sbn-line:rgba(58,46,35,.12); border-right:1px solid #d6ccbc; }',
    '#sideNav.sbn { background:var(--sbn-bg) !important; color:var(--sbn-fg) !important; overflow-x:hidden; padding:0 !important; display:flex; flex-direction:column; }',
    '.sbn-label { font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--sbn-muted); padding:8px 12px 6px; font-weight:700; }',
    '.sbn-item { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:12px; color:var(--sbn-item); font-size:14px; font-weight:600; text-decoration:none; cursor:pointer; transition:background .14s ease, color .14s ease; }',
    '.sbn-item:hover { background:var(--sbn-hover); }',
    '.sbn-item.sbn-active { background:var(--sbn-accent); color:#fff; font-weight:700; box-shadow:0 6px 16px rgba(140,73,26,.32); }',
    '.sbn-item.sbn-soon { color:var(--sbn-soon); cursor:default; }',
    '.sbn-item.sbn-soon:hover { background:transparent; }',
    '.sbn-soonbadge { margin-left:auto; font-size:9px; letter-spacing:.1em; padding:3px 7px; border-radius:999px; background:var(--sbn-badge); color:var(--sbn-muted); }',
    '.sbn-recent { display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:12px; color:var(--sbn-item); font-size:13px; font-weight:500; text-decoration:none; cursor:pointer; transition:background .14s ease; }',
    '.sbn-recent:hover { background:var(--sbn-hover); }',
    '.sbn-ract { display:none; align-items:center; gap:2px; flex-shrink:0; margin-left:auto; }',
    '.sbn-recent:hover .sbn-ract { display:inline-flex; }',
    '.sbn-ract button { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border:none; border-radius:6px; background:transparent; color:var(--sbn-muted); cursor:pointer; padding:0; }',
    '.sbn-ract button:hover { background:var(--sbn-hover); color:var(--sbn-fg); }',
    '.sbn-newchat { width:100%; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:11px; border-radius:999px; border:none; background:var(--sbn-accent); color:#fff; font-family:inherit; font-weight:700; font-size:13.5px; cursor:pointer; }',
    '.sbn-newchat:hover { background:var(--sbn-accent-hover); }',
    '.sbn-themebtn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border:none; border-radius:999px; background:var(--sbn-badge); color:var(--sbn-muted); cursor:pointer; padding:0; }',
    '.sbn-themebtn:hover { color:var(--sbn-fg); }',
    '.sbn-truncate { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }',
    // Hide the scrollbar on the sidebar\'s scroll regions (scroll still works),
    // matching the chat page where the nav scroller was removed.
    '#sideNav.sbn, #sideNav.sbn [data-sbn-scroll] { scrollbar-width:none; -ms-overflow-style:none; }',
    '#sideNav.sbn::-webkit-scrollbar, #sideNav.sbn [data-sbn-scroll]::-webkit-scrollbar { width:0; height:0; display:none; }',
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

    // Nav theme: espresso (dark, default) or cream (light) — user-switchable,
    // persisted across pages.
    var navTheme = 'espresso';
    try { navTheme = localStorage.getItem('finchat_nav_theme') || 'espresso'; } catch (e) {}
    nav.classList.toggle('sbn-cream', navTheme === 'cream');

    var sess = getSession() || {};
    var name = sess.name || 'User';
    var role = sess.role || 'user';
    var initials = String(name).split(' ').map(function (w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
    var roleLabel = role === 'admin' ? 'Admin • Internal' : role === 'auditor' ? 'Auditor • Internal' : 'Staff • Internal';

    nav.innerHTML =
      '<div style="padding:22px 22px 14px; display:flex; align-items:flex-start; gap:8px;">' +
        '<div style="flex:1; min-width:0;">' +
          '<div class="sbn-serif" style="font-size:27px; line-height:1; letter-spacing:-.01em; color:var(--sbn-fg);">FinChat</div>' +
          '<div style="font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--sbn-muted); margin-top:7px;">AI Operating System</div>' +
        '</div>' +
        '<button class="sbn-themebtn" id="sbnThemeBtn" title="Switch nav theme (espresso / cream)">' +
          '<span class="material-symbols-outlined" style="font-size:16px;">' + (navTheme === 'cream' ? 'dark_mode' : 'light_mode') + '</span>' +
        '</button>' +
      '</div>' +
      '<div style="padding:4px 14px 12px;">' +
        '<button class="sbn-newchat" onclick="location.href=\'finchat_chat.html\'">' +
          '<span class="material-symbols-outlined" style="font-size:18px;">add</span> New chat' +
        '</button>' +
      '</div>' +
      '<div style="padding:0 14px 12px;">' +
        '<div class="sbn-label" style="margin-bottom:2px;">Recent</div>' +
        '<div id="sbnRecent" data-sbn-scroll style="display:flex; flex-direction:column; gap:2px; max-height:150px; overflow-y:auto;">' +
          '<div style="padding:8px 12px; font-size:12px; color:var(--sbn-muted);">Loading…</div>' +
        '</div>' +
      '</div>' +
      '<div data-sbn-scroll style="flex:1; overflow-y:auto; padding:8px 14px;">' +
        '<div class="sbn-label">Navigation</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          navItem('operations', 'finchat_dashboard.html', 'dashboard', 'Operations') +
          navItem('agents', 'finchat_agents.html', 'smart_toy', 'Agents') +
          navItem('chat', 'finchat_chat.html', 'chat', 'Chat') +
          navItem('groupchat', 'finchat_groupchat.html', 'forum', 'Group Chat') +
          navItem('neuralmap', 'finchat_neuralmap.html', 'hub', 'Neural Map') +
          soonItem('assessment', 'Reports') +
          soonItem('menu_book', 'Knowledge') +
          soonItem('account_balance', 'Governance') +
          navItem('blockchain', 'finchat_blockchain.html', 'account_tree', 'Blockchain') +
          navItem('audit', 'finchat_audit.html', 'policy', 'Audit Logs') +
        '</div>' +
        '<div class="sbn-label" style="padding-top:20px;">System</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          navItem('settings', 'finchat_settings.html', 'settings', 'Settings') +
          soonItem('help', 'Support') +
        '</div>' +
      '</div>' +
      '<div style="padding:12px 14px 16px; border-top:1px solid var(--sbn-line);">' +
        '<div class="sbn-item" id="sbnProfile" style="padding:9px 10px; border-radius:14px;">' +
          '<div id="sbnAvatar" style="width:38px; height:38px; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; flex-shrink:0; background:linear-gradient(135deg,#d67f48,#8c491a); color:#fff; font-size:15px;" class="sbn-serif">' + esc(initials) + '</div>' +
          '<div style="flex:1; overflow:hidden;">' +
            '<div class="sbn-truncate" style="font-size:14px; font-weight:700; color:var(--sbn-fg);">' + esc(name) + '</div>' +
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

      refreshRecents(sess.token);
    }

    // Theme toggle — persists and rebuilds so every themed element updates.
    var themeBtn = document.getElementById('sbnThemeBtn');
    if (themeBtn) themeBtn.onclick = function () {
      var next = nav.classList.contains('sbn-cream') ? 'espresso' : 'cream';
      try { localStorage.setItem('finchat_nav_theme', next); } catch (e) {}
      build();
    };

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

  // ── Recents with actions (copy / rename / delete) on every page ────────
  function copyTextSbn(text) {
    return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    });
  }

  function refreshRecents(token) {
    fetch(API + '/api/ai-chat/sessions', { headers: { 'Authorization': 'Bearer ' + token } })
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
          return '<a class="sbn-recent" data-sid="' + esc(s.session_id) + '" data-title="' + esc(s.title) + '" href="finchat_chat.html?session=' + encodeURIComponent(s.session_id) + '" title="' + esc(s.title) + ' — ' + esc(s.personaName || s.persona) + '">' +
            av + '<span class="sbn-truncate" style="flex:1; min-width:0;">' + esc(s.title) + '</span>' +
            '<span class="sbn-ract">' +
              '<button data-act="copy" title="Copy conversation text"><span class="material-symbols-outlined" style="font-size:14px;">content_copy</span></button>' +
              '<button data-act="rename" title="Rename conversation"><span class="material-symbols-outlined" style="font-size:14px;">edit</span></button>' +
              '<button data-act="delete" title="Delete conversation"><span class="material-symbols-outlined" style="font-size:14px;">delete</span></button>' +
            '</span></a>';
        }).join('');
        list.querySelectorAll('.sbn-ract button').forEach(function (b) {
          b.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            var a = b.closest('[data-sid]');
            var sid = a.getAttribute('data-sid');
            var act = b.getAttribute('data-act');
            var H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            if (act === 'rename') {
              var title = prompt('Rename conversation:', a.getAttribute('data-title') || '');
              if (!title || !title.trim()) return;
              fetch(API + '/api/ai-chat/sessions/' + sid, { method: 'PATCH', headers: H, body: JSON.stringify({ title: title.trim() }) })
                .then(function (r) { if (r.ok) refreshRecents(token); });
            } else if (act === 'delete') {
              if (!confirm('Delete this conversation? This cannot be undone.')) return;
              fetch(API + '/api/ai-chat/sessions/' + sid, { method: 'DELETE', headers: H })
                .then(function (r) { if (r.ok) refreshRecents(token); });
            } else if (act === 'copy') {
              fetch(API + '/api/ai-chat/history/' + sid, { headers: H })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                  if (!d) return;
                  var text = (d.messages || []).map(function (m) {
                    var who = m.role === 'user' ? 'You' : ((d.persona && d.persona.name) || m.persona || 'Agent');
                    return who + ': ' + (m.content || '').replace(/^\[(Plato|Aurelius|Rasha|Nova|System)\]\s*/i, '');
                  }).join('\n\n');
                  copyTextSbn(text).then(function (ok) {
                    b.title = ok ? 'Copied!' : 'Copy failed';
                    var icon = b.querySelector('span');
                    if (icon && ok) { icon.textContent = 'check'; setTimeout(function () { icon.textContent = 'content_copy'; }, 1500); }
                  });
                });
            }
          });
        });
      }).catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
