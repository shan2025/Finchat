// sidebar_nav.js — shared sidebar for every FinChat page, matching the chat
// page's design (dark warm rail: brand, New chat, Recent, Navigation, System,
// profile card). The chat page keeps its own inline copy (it wires Recents into
// the live conversation); every OTHER page includes this file and gets its
// #sideNav rebuilt in place. Shared-JS pattern: survives design-tool regens —
// if a regen wipes the include, re-add <script src="sidebar_nav.js"></script>.
// file:// fallback — route root-relative "/api/…" fetches to the local backend
// when a page is opened directly from disk. Global + idempotent; no-op over http.
(function(){ if(location.protocol==='file:'&&!window.__apiFileFix){ window.__apiFileFix=true; var _f=window.fetch.bind(window);
  window.fetch=function(u,o){ try{ if(typeof u==='string'&&u.charAt(0)==='/') u='http://localhost:3000'+u; }catch(e){} return _f(u,o); }; } })();
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
    ['finchat_neuralspace', 'neuralspace'],
    ['finchat_universe', 'neuralspace'], // old name — the page now redirects
    ['finchat_neuralmap', 'neuralmap'],
    ['finchat_neuralnetwork', 'neuralmap'], // Model Lab lives under Neural Map
    ['finchat_brainmodel', 'brainmodel'],
    ['finchat_mindmap', 'mindmap'],
    ['finchat_knowledge', 'knowledge'],
    ['finchat_reports', 'reports'],
    // Blockchain + Audit Logs were pulled out of the top-level rail and now live
    // under Settings → Security & audit; map their pages to the Settings key so
    // that row highlights while you're on them.
    ['finchat_blockchain', 'settings'],
    ['finchat_audit', 'settings'],
    ['finchat_settings', 'settings'],
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
  // Agents with no PNG of their own. Without an entry here they fall through to
  // the generic 🤖 bubble, which reads as "unknown sender" rather than as a
  // named agent — so they get a coloured initial plate instead.
  var AGENT_PLATES = {
    atlas: { initial: 'A', bg: '#1f4a3f', fg: '#7fd1b9' }
  };
  function agentBubble(id) {
    var base = 'width:24px; height:24px; border-radius:999px; flex-shrink:0; display:inline-flex; align-items:center; justify-content:center;';
    if (AGENT_AVATARS[id]) {
      return '<span style="' + base + ' overflow:hidden; background:#efe8de;"><img src="' + AGENT_AVATARS[id] + '" style="width:100%;height:100%;object-fit:cover;"></span>';
    }
    var p = AGENT_PLATES[id];
    if (p) {
      return '<span style="' + base + ' background:' + p.bg + '; color:' + p.fg + '; font-size:12px; font-weight:700;">' + p.initial + '</span>';
    }
    return null;
  }

  // The mascot head, at finchat_login.html's original coordinates — the viewBox
  // is just cropped to its bounding box. Inlined rather than <img src> because
  // the mark has to invert with the rail theme: ink follows currentColor
  // (--sbn-fg) and the face panel is punched in --sbn-bg, so it reads cream-on-
  // espresso and brown-on-cream without a second file.
  var MASCOT_HEAD =
    // Tilted -7deg about the head's bbox centre (55,40) to match the lean the
    // login robot has mid-animation. The viewBox is widened from "17 7 76 66"
    // to the rotated bounding box so the antenna and nubs don't clip.
    '<svg viewBox="13.25 2.6 83.5 74.8" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<g transform="rotate(-7 55 40)">' +
      '<circle cx="55" cy="12" r="5" fill="currentColor"/>' +
      '<rect x="53.5" y="14" width="3" height="15" rx="1.5" fill="currentColor"/>' +
      '<path d="M 23 48 Q 17 48 17 41 Q 17 34 23 34 Z" fill="currentColor"/>' +
      '<path d="M 87 48 Q 93 48 93 41 Q 93 34 87 34 Z" fill="currentColor"/>' +
      '<rect x="25" y="27" width="60" height="46" rx="22" fill="currentColor"/>' +
      // Fallback matters: an undefined var here makes fill invalid, which paints
      // the face solid black and erases the eyes.
      '<rect x="35" y="37" width="40" height="26" rx="12" fill="var(--sbn-bg, #2a241d)"/>' +
      '<circle cx="46" cy="48" r="4.5" fill="currentColor"/>' +
      '<circle cx="64" cy="48" r="4.5" fill="currentColor"/>' +
    '</g>' +
    '</svg>';

  var CSS = [
    // Espresso (default, dark) theme vars — the cream theme overrides them below.
    '#sideNav.sbn { --sbn-bg:#2a241d; --sbn-fg:#efe6d6; --sbn-muted:#a99e88; --sbn-accent:#c67139; --sbn-accent-hover:#b2622d; --sbn-item:#cfc3ad; --sbn-hover:rgba(255,255,255,.07); --sbn-soon:#867a63; --sbn-badge:rgba(239,230,214,.1); --sbn-line:rgba(239,230,214,.14); }',
    // Cream (light) theme — from the app design system\'s cream family.
    '#sideNav.sbn.sbn-cream { --sbn-bg:#f3eee3; --sbn-fg:#3a2e23; --sbn-muted:#8c7a6b; --sbn-accent:#c67139; --sbn-accent-hover:#b2622d; --sbn-item:#5c4a38; --sbn-hover:rgba(58,46,35,.07); --sbn-soon:#b3a693; --sbn-badge:rgba(58,46,35,.08); --sbn-line:rgba(58,46,35,.12); border-right:1px solid #d6ccbc; }',
    '#sideNav.sbn { background:var(--sbn-bg) !important; color:var(--sbn-fg) !important; overflow-x:hidden; overflow-y:auto; padding:0 !important; display:flex; flex-direction:column; }',
    // Geometry belongs to the rail, not to each page's markup. Every page
    // declared the same `fixed left-0 top-0 w-64` utilities, so this changes
    // nothing for them — but the element is persistent under spa_router.js,
    // and a page that styled it differently (Mind Maps) used to leave the rail
    // static and full-width on whatever page you navigated to next.
    '#sideNav.sbn { position:fixed; left:0; top:0; height:100%; width:256px; z-index:40; }',
    // Only the nav list gives up space when the viewport is short; everything
    // else keeps its natural height so nothing collapses into anything else.
    '#sideNav.sbn > * { flex:0 0 auto; }',
    '#sideNav.sbn .sbn-scroll { flex:1 1 0%; min-height:132px; overflow-y:auto; padding:8px 14px; }',
    '.sbn-head { padding:22px 22px 14px; display:flex; align-items:flex-start; gap:8px; }',
    '.sbn-logo { flex:0 0 auto; line-height:0; cursor:pointer; margin-top:1px; color:var(--sbn-fg); }',
    // Wider than the upright mark was (34px): the tilted viewBox carries
    // rotation slack, so the head reads the same optical size at 37px.
    '.sbn-logo svg { display:block; width:37px; height:auto; }',
    '.sbn-brand { font-size:27px; line-height:1; letter-spacing:-.01em; color:var(--sbn-fg); }',
    '.sbn-brandsub { font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--sbn-muted); margin-top:7px; }',
    '.sbn-newwrap { padding:4px 14px 12px; }',
    '.sbn-recentwrap { padding:0 14px 12px; }',
    '.sbn-recentlist { display:flex; flex-direction:column; gap:2px; max-height:150px; overflow-y:auto; }',
    '.sbn-foot { padding:12px 14px 16px; border-top:1px solid var(--sbn-line); }',
    '.sbn-avatar { width:38px; height:38px; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; flex-shrink:0; background:linear-gradient(135deg,#d67f48,#8c491a); color:#fff; font-size:15px; }',
    '.sbn-uname { font-size:14px; font-weight:700; color:var(--sbn-fg); }',
    '.sbn-urole { font-size:11px; color:var(--sbn-muted); margin-top:1px; }',
    '.sbn-label { font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--sbn-muted); padding:8px 12px 6px; font-weight:700; }',
    '.sbn-syslabel { padding-top:20px; }',
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
    // Scrollbars in the rail: the gutter is always reserved (so nothing shifts)
    // but the thumb only paints while the pointer/focus is in the rail, keeping
    // the chat page\'s clean look without hiding the fact that a region scrolls.
    '#sideNav.sbn, #sideNav.sbn [data-sbn-scroll] { scrollbar-width:thin; scrollbar-color:transparent transparent; }',
    '#sideNav.sbn:hover, #sideNav.sbn:focus-within, #sideNav.sbn:hover [data-sbn-scroll], #sideNav.sbn:focus-within [data-sbn-scroll] { scrollbar-color:var(--sbn-line) transparent; }',
    '#sideNav.sbn::-webkit-scrollbar, #sideNav.sbn [data-sbn-scroll]::-webkit-scrollbar { width:8px; height:0; }',
    '#sideNav.sbn::-webkit-scrollbar-track, #sideNav.sbn [data-sbn-scroll]::-webkit-scrollbar-track { background:transparent; }',
    '#sideNav.sbn::-webkit-scrollbar-thumb, #sideNav.sbn [data-sbn-scroll]::-webkit-scrollbar-thumb { background:transparent; border-radius:999px; }',
    '#sideNav.sbn:hover::-webkit-scrollbar-thumb, #sideNav.sbn:focus-within::-webkit-scrollbar-thumb, #sideNav.sbn:hover [data-sbn-scroll]::-webkit-scrollbar-thumb, #sideNav.sbn:focus-within [data-sbn-scroll]::-webkit-scrollbar-thumb { background:var(--sbn-line); }',
    // Persistent cue that a region has more content past its edge. The custom
    // properties are driven from JS (0px = no fade on that edge).
    '.sbn-faded { -webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 var(--sbn-ft,0px), #000 calc(100% - var(--sbn-fb,0px)), transparent 100%); mask-image:linear-gradient(to bottom, transparent 0, #000 var(--sbn-ft,0px), #000 calc(100% - var(--sbn-fb,0px)), transparent 100%); }',
    '.sbn-serif { font-family:"Caprasimo", serif; }',
    // Drawer behaviour on narrow screens (idempotent with pages that already
    // ship the same rules; pages without a #navToggle simply keep it closed,
    // which matches their previous hidden-below-md behaviour).
    '@media (max-width:767px) { #sideNav.sbn { transform:translateX(-100%); transition:transform .25s; z-index:60; } #sideNav.sbn.open { transform:translateX(0); box-shadow:0 20px 60px rgba(0,0,0,.45); } }',
    '@media (min-width:768px) { #sideNav.sbn { transform:none !important; } }',
    // Short viewports (a 768px laptop is ~720px once browser chrome is taken
    // out) — the full rail needs ~970px, so tighten the chrome around the nav
    // list and cap Recent, which claws back ~190px before scrolling has to
    // hide anything.
    '@media (max-height:860px) {',
    '  .sbn-head { padding:14px 18px 8px; }',
    '  .sbn-logo svg { width:31px; }',
    '  .sbn-brand { font-size:22px; }',
    '  .sbn-brandsub { font-size:9.5px; letter-spacing:.18em; margin-top:5px; }',
    '  .sbn-newwrap { padding:2px 12px 8px; }',
    '  .sbn-newchat { padding:9px; font-size:13px; }',
    '  .sbn-recentwrap { padding:0 12px 8px; }',
    '  .sbn-recentlist { max-height:108px; }',
    '  #sideNav.sbn .sbn-scroll { padding:4px 12px; }',
    '  .sbn-label { padding:5px 12px 3px; }',
    '  .sbn-syslabel { padding-top:12px; }',
    '  .sbn-item { padding:7px 12px; }',
    '  .sbn-foot { padding:8px 12px 10px; }',
    '  .sbn-avatar { width:32px; height:32px; font-size:13px; }',
    '}',
    '@media (max-height:640px) {',
    '  .sbn-brandsub { display:none; }',
    '  .sbn-recentlist { max-height:74px; }',
    '  .sbn-item { padding:6px 12px; font-size:13.5px; }',
    '}'
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
    return '<a class="sbn-item' + (act ? ' sbn-active' : '') + '" href="' + href + '" data-sbn-key="' + key + '"' +
      (act ? ' aria-current="page"' : '') + '>' +
      '<span class="material-symbols-outlined" style="font-size:20px;' + (act ? "font-variation-settings:'FILL' 1;" : '') + '">' + icon + '</span> ' + label + '</a>';
  }
  function soonItem(icon, label) {
    return '<div class="sbn-item sbn-soon"><span class="material-symbols-outlined" style="font-size:20px;">' + icon + '</span> <span style="flex:1;">' + label + '</span> <span class="sbn-soonbadge">SOON</span></div>';
  }

  function build() {
    var nav = document.getElementById('sideNav');
    if (!nav) return;

    // One <style> for the life of the page — build() re-runs on theme switch.
    var style = document.getElementById('sbnStyle');
    if (!style) {
      style = document.createElement('style');
      style.id = 'sbnStyle';
      document.head.appendChild(style);
    }
    style.textContent = CSS;
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
      '<div class="sbn-head">' +
        '<div class="sbn-logo" title="Home — Neural Space" onclick="location.href=\'finchat_neuralspace.html\'">' + MASCOT_HEAD + '</div>' +
        '<div style="flex:1; min-width:0;">' +
          '<div class="sbn-serif sbn-brand" style="cursor:pointer;" title="Home — Neural Space" onclick="location.href=\'finchat_neuralspace.html\'">FinChat</div>' +
          '<div class="sbn-brandsub">AI Operating System</div>' +
        '</div>' +
        '<button class="sbn-themebtn" id="sbnThemeBtn" title="Switch nav theme (espresso / cream)">' +
          '<span class="material-symbols-outlined" style="font-size:16px;">' + (navTheme === 'cream' ? 'dark_mode' : 'light_mode') + '</span>' +
        '</button>' +
      '</div>' +
      '<div class="sbn-newwrap">' +
        '<button class="sbn-newchat" onclick="location.href=\'finchat_chat.html\'">' +
          '<span class="material-symbols-outlined" style="font-size:18px;">add</span> New chat' +
        '</button>' +
      '</div>' +
      '<div class="sbn-recentwrap">' +
        '<div class="sbn-label" style="margin-bottom:2px;">Recent</div>' +
        '<div id="sbnRecent" class="sbn-recentlist" data-sbn-scroll>' +
          '<div style="padding:8px 12px; font-size:12px; color:var(--sbn-muted);">Loading…</div>' +
        '</div>' +
      '</div>' +
      '<div class="sbn-scroll" data-sbn-scroll>' +
        '<div class="sbn-label">Navigation</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          navItem('operations', 'finchat_dashboard.html', 'dashboard', 'Operations') +
          navItem('agents', 'finchat_agents.html', 'smart_toy', 'Agents') +
          navItem('chat', 'finchat_chat.html', 'chat', 'Chat') +
          navItem('groupchat', 'finchat_groupchat.html', 'forum', 'Group Chat') +
          navItem('neuralspace', 'finchat_neuralspace.html', 'scatter_plot', 'Neural Space') +
          navItem('neuralmap', 'finchat_neuralmap.html', 'hub', 'Neural Map') +
          navItem('brainmodel', 'finchat_brainmodel.html', 'travel_explore', 'Agent Map') +
          navItem('mindmap', 'finchat_mindmap.html', 'schema', 'Mind Maps') +
          navItem('reports', 'finchat_reports.html', 'assessment', 'Reports') +
          navItem('knowledge', 'finchat_knowledge.html', 'menu_book', 'Knowledge') +
          soonItem('account_balance', 'Governance') +
        '</div>' +
        '<div class="sbn-label sbn-syslabel">System</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          navItem('settings', 'finchat_settings.html', 'settings', 'Settings') +
          soonItem('help', 'Support') +
        '</div>' +
      '</div>' +
      '<div class="sbn-foot">' +
        // A real <a> so the SPA router intercepts it like any other nav item;
        // the #account hash opens Settings straight on Account & profile.
        '<a class="sbn-item" id="sbnProfile" href="finchat_settings.html#account" title="Account &amp; profile" style="padding:9px 10px; border-radius:14px;">' +
          '<div id="sbnAvatar" class="sbn-serif sbn-avatar">' + esc(initials) + '</div>' +
          '<div style="flex:1; overflow:hidden;">' +
            '<div class="sbn-truncate sbn-uname">' + esc(name) + '</div>' +
            '<div class="sbn-truncate sbn-urole">' + roleLabel + '</div>' +
          '</div>' +
        '</a>' +
      '</div>';

    wireScrollCues(nav);
    revealActive(nav);
    pendingReveal = true; // Recent renders async and shrinks the nav list.

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
    // links before we rebuilt the sidebar). The backdrop is looked up at click
    // time, not captured here: it lives inside the page's <main>, so an SPA
    // navigation replaces it and a reference taken at build time would go stale.
    nav.querySelectorAll('a[href]').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.classList.remove('open');
        var bd = document.getElementById('navBackdrop');
        if (bd) bd.classList.add('hidden');
      });
    });
  }

  // ── Short-viewport scroll cues ─────────────────────────────────────────
  // The full rail wants ~970px of height; on a 720px viewport the nav list has
  // to scroll. Fade whichever edge still has content past it so that is obvious
  // at rest, and keep it in sync as the rail's boxes resize (Recent loading in,
  // window resize, drawer opening).
  function wireScrollCues(nav) {
    [nav.querySelector('.sbn-scroll'), nav.querySelector('#sbnRecent'), nav].forEach(function (el) {
      if (!el || el.__sbnCues) return;
      el.__sbnCues = true;
      var sync = function () {
        // Ignore a few px of trailing padding — only fade when a real row is cut.
        var over = el.scrollHeight - el.clientHeight;
        if (over <= 10) { el.classList.remove('sbn-faded'); return; }
        el.classList.add('sbn-faded');
        el.style.setProperty('--sbn-ft', el.scrollTop > 4 ? '16px' : '0px');
        el.style.setProperty('--sbn-fb', el.scrollTop < over - 4 ? '18px' : '0px');
      };
      el.__sbnSync = sync; // so programmatic scrolls can refresh without waiting on the event
      el.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      if (window.ResizeObserver) new ResizeObserver(sync).observe(el);
      sync();
    });
  }

  // Re-apply the current-page highlight without rebuilding the rail. The SPA
  // router keeps #sideNav alive across navigations, so the highlight painted at
  // build() time would otherwise stay stuck on the page you came FROM. Matching
  // on the nav key (not the href) keeps aliases like Model Lab → Neural Map
  // pointing at the right row.
  function syncActive() {
    var nav = document.getElementById('sideNav');
    if (!nav) return;
    var key = activeKey();
    nav.querySelectorAll('.sbn-item[data-sbn-key]').forEach(function (a) {
      var act = a.getAttribute('data-sbn-key') === key;
      a.classList.toggle('sbn-active', act);
      if (act) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      var icon = a.querySelector('.material-symbols-outlined');
      if (icon) icon.style.fontVariationSettings = act ? "'FILL' 1" : '';
    });
    revealActive(nav);
  }

  // At short heights the current page's own link can start out below the fold.
  var pendingReveal = false;
  function revealActive(nav) {
    var sc = nav.querySelector('.sbn-scroll');
    var act = sc && sc.querySelector('.sbn-active');
    if (!sc || !act) return;
    var a = act.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (a.bottom > s.bottom) sc.scrollTop += (a.bottom - s.bottom) + 8;
    else if (a.top < s.top) sc.scrollTop -= (s.top - a.top) + 8;
    else return;
    if (sc.__sbnSync) sc.__sbnSync();
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

  // Per-tab cache of the Recent list. FinChat is a multi-page app, so without
  // this every navigation re-hits /api/ai-chat/sessions (a ~126ms Supabase
  // round-trip) and flashes "Loading…" before the same rows reappear. We stash
  // the list in sessionStorage — scoped to the tab, so it clears on tab close
  // and never leaks a previous user's conversations into a fresh sign-in — and
  // paint it instantly on the next page, then revalidate in the background.
  var RECENTS_CACHE_KEY = 'finchat_recents_cache';
  function readRecentsCache(token) {
    try {
      var c = JSON.parse(sessionStorage.getItem(RECENTS_CACHE_KEY) || 'null');
      if (!c || c.token !== token) return null; // stale token → different user
      return c.sessions || null;
    } catch (e) { return null; }
  }
  function writeRecentsCache(token, sessions) {
    try {
      sessionStorage.setItem(RECENTS_CACHE_KEY,
        JSON.stringify({ token: token, sessions: sessions }));
    } catch (e) {}
  }

  function refreshRecents(token) {
    // The cache is canonical at 10 (the chat page's list length); the rail only
    // shows 6, so slice on read and compare on the sliced view.
    var cached = readRecentsCache(token);
    var cached6 = cached ? cached.slice(0, 6) : null;
    // Paint whatever we saw last so the rail never starts on "Loading…".
    if (cached6) renderRecents(cached6, token);

    fetch(API + '/api/ai-chat/sessions', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var all = (d.sessions || []).slice(0, 10);
        var six = all.slice(0, 6);
        // Skip the repaint (and its scroll-cue reflow) when the visible rows are
        // unchanged — the common case once the cache is warm.
        if (JSON.stringify(six) === JSON.stringify(cached6 || [])) return;
        writeRecentsCache(token, all);
        renderRecents(six, token);
      }).catch(function () {});
  }

  function renderRecents(sessions, token) {
    var list = document.getElementById('sbnRecent');
    if (!list) return;
    // Recent settling to its real height resizes the nav list under it, so
    // re-check the active link once it has.
    var settled = function () {
      if (!pendingReveal) return;
      pendingReveal = false;
      var nav = document.getElementById('sideNav');
      if (nav) revealActive(nav);
    };
    if (!sessions.length) {
      list.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:var(--sbn-muted);">No conversations yet</div>';
      settled();
      return;
    }
    {
      list.innerHTML = sessions.map(function (s) {
          var av = agentBubble(s.persona)
            || '<span style="width:24px; height:24px; border-radius:999px; flex-shrink:0; background:#efe8de; display:inline-flex; align-items:center; justify-content:center; font-size:12px;">' + esc(s.personaAvatar || '🤖') + '</span>';
          return '<a class="sbn-recent" data-sid="' + esc(s.session_id) + '" data-title="' + esc(s.title) + '" href="finchat_chat.html?session=' + encodeURIComponent(s.session_id) + '" title="' + esc(s.title) + ' — ' + esc(s.personaName || s.persona) + '">' +
            av + '<span class="sbn-truncate" style="flex:1; min-width:0;">' + esc(s.title) + '</span>' +
            '<span class="sbn-ract">' +
              '<button data-act="copy" title="Copy conversation text"><span class="material-symbols-outlined" style="font-size:14px;">content_copy</span></button>' +
              '<button data-act="rename" title="Rename conversation"><span class="material-symbols-outlined" style="font-size:14px;">edit</span></button>' +
              '<button data-act="delete" title="Delete conversation"><span class="material-symbols-outlined" style="font-size:14px;">delete</span></button>' +
            '</span></a>';
        }).join('');
        settled();
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
                .then(function (r) { if (r.ok) { try { sessionStorage.removeItem(RECENTS_CACHE_KEY); } catch (e) {} refreshRecents(token); } });
            } else if (act === 'delete') {
              if (!confirm('Delete this conversation? This cannot be undone.')) return;
              fetch(API + '/api/ai-chat/sessions/' + sid, { method: 'DELETE', headers: H })
                .then(function (r) { if (r.ok) { try { sessionStorage.removeItem(RECENTS_CACHE_KEY); } catch (e) {} refreshRecents(token); } });
            } else if (act === 'copy') {
              fetch(API + '/api/ai-chat/history/' + sid, { headers: H })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                  if (!d) return;
                  var text = (d.messages || []).map(function (m) {
                    var who = m.role === 'user' ? 'You' : ((d.persona && d.persona.name) || m.persona || 'Agent');
                    return who + ': ' + (m.content || '').replace(/^\[(Plato|Aurelius|Atlas|Rasha|Nova|System)\]\s*/i, '');
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
    }
  }

  // The rail owns its own active-state contract; spa_router.js calls syncActive()
  // after a view swap rather than guessing at the class names.
  window.fcSidebarNav = { rebuild: build, syncActive: syncActive };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
