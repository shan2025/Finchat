// sidebar_collapse.js — shared "retract the left nav" control for every FinChat
// page. Adds a small toggle in the sidebar header (next to the theme button) and
// a floating re-open button that appears once the rail is hidden. The collapsed
// state is remembered across pages (localStorage) so the rail stays out of the
// way while you work.
//
// Shared-JS pattern (same as sidebar_nav.js): if a design-tool regen wipes the
// include, re-add <script src="sidebar_collapse.js"></script> at the end of body.
//
// Desktop only (>=768px). Below that the sidebar is already a drawer driven by
// #navToggle, so this script keeps its hands off.
(function () {
  var KEY = 'finchat_nav_collapsed';
  var CLS = 'nav-collapsed';
  var root = document.documentElement;

  function isCollapsed() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function store(v) {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {}
  }

  // Apply the class as early as possible so a collapsed rail never flashes in.
  root.classList.toggle(CLS, isCollapsed());

  var CSS = [
    '@media (min-width:768px) {',
    '  #sideNav { transition:transform .22s ease; }',
    // Higher specificity than the pages\' own `#sideNav { transform:none !important }`
    // desktop rule, so the retract wins.
    '  html.' + CLS + ' #sideNav { transform:translateX(-100%) !important; box-shadow:none !important; }',
    // Most pages lay their content out as a sibling with `md:ml-64`; reclaim it.
    '  html.' + CLS + ' [class*="ml-64"] { margin-left:0 !important; }',
    // Mind Maps keeps the rail in the flex flow instead of fixed-positioning it,
    // so sliding it away would leave its column behind — collapse the width too.
    '  #sideNav.nav-rail-inflow { transition:width .22s ease; }',
    '  html.' + CLS + ' #sideNav.nav-rail-inflow { width:0 !important; min-width:0 !important; padding:0 !important; border:none !important; overflow:hidden !important; transform:none !important; }',
    '  html.' + CLS + ' #navCollapseFab { display:inline-flex; }',
    '}',
    '#navCollapseFab { position:fixed; left:14px; top:14px; z-index:70; display:none; width:34px; height:34px; align-items:center; justify-content:center; padding:0; border:none; border-radius:10px; background:#2a241d; color:#efe6d6; box-shadow:0 8px 22px rgba(0,0,0,.28); cursor:pointer; }',
    '#navCollapseFab:hover { background:#3a322a; }',
    '@media (max-width:767px) { #navCollapseFab { display:none !important; } }',
    '.nav-collapse-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:none; border-radius:999px; background:rgba(127,127,127,.16); color:inherit; opacity:.72; cursor:pointer; }',
    '.nav-collapse-btn:hover { opacity:1; }'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('navCollapseStyle')) return;
    var s = document.createElement('style');
    s.id = 'navCollapseStyle';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function icon(name, size) {
    return '<span class="material-symbols-outlined" style="font-size:' + size + 'px;">' + name + '</span>';
  }

  function setCollapsed(v) {
    root.classList.toggle(CLS, v);
    store(v);
    var b = document.getElementById('navCollapseBtn');
    if (b) b.innerHTML = icon(v ? 'left_panel_open' : 'left_panel_close', 17);
  }
  function toggle() { setCollapsed(!root.classList.contains(CLS)); }

  // A fixed rail is slid off-screen; an in-flow one has to give up its column.
  function classifyRail() {
    var nav = document.getElementById('sideNav');
    if (!nav) return;
    nav.classList.toggle('nav-rail-inflow', getComputedStyle(nav).position !== 'fixed');
  }

  function mount() {
    var nav = document.getElementById('sideNav');
    if (!nav) return;
    ensureStyle();
    classifyRail();

    // In-nav toggle — sits beside the theme button when the page has one.
    if (!document.getElementById('navCollapseBtn')) {
      var btn = document.createElement('button');
      btn.id = 'navCollapseBtn';
      btn.className = 'nav-collapse-btn';
      btn.type = 'button';
      btn.title = 'Hide sidebar (Ctrl+B)';
      btn.innerHTML = icon(root.classList.contains(CLS) ? 'left_panel_open' : 'left_panel_close', 17);
      btn.addEventListener('click', function (e) { e.preventDefault(); toggle(); });

      var themeBtn = nav.querySelector('#sbnThemeBtn, #navThemeBtn, .nav-theme-btn, .sbn-themebtn');
      if (themeBtn && themeBtn.parentNode) themeBtn.parentNode.insertBefore(btn, themeBtn);
      else if (nav.firstElementChild) nav.firstElementChild.appendChild(btn);
      else nav.appendChild(btn);
    }

    // Floating re-open button, shown only while collapsed.
    if (!document.getElementById('navCollapseFab')) {
      var fab = document.createElement('button');
      fab.id = 'navCollapseFab';
      fab.type = 'button';
      fab.title = 'Show sidebar (Ctrl+B)';
      fab.innerHTML = icon('left_panel_open', 19);
      fab.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
      document.body.appendChild(fab);
    }
  }

  // sidebar_nav.js rebuilds #sideNav's innerHTML on a theme switch, which drops
  // our button — re-mount whenever the rail's children change.
  function observe() {
    var nav = document.getElementById('sideNav');
    if (!nav || !window.MutationObserver) return;
    new MutationObserver(function () {
      if (!document.getElementById('navCollapseBtn')) mount();
    }).observe(nav, { childList: true });
  }

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if ((e.key || '').toLowerCase() !== 'b') return;
    var t = e.target;
    if (t && t.isContentEditable) return;
    if (window.innerWidth < 768) return;
    e.preventDefault();
    toggle();
  });

  window.SidebarCollapse = { toggle: toggle, set: setCollapsed, isCollapsed: function () { return root.classList.contains(CLS); } };

  // Some pages fix the rail only below a breakpoint — re-check on resize.
  var rz;
  window.addEventListener('resize', function () {
    clearTimeout(rz);
    rz = setTimeout(classifyRail, 150);
  });

  function init() { mount(); observe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
