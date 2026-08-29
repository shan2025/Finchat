/* mascot_nap.js — the FinChat robot dozing on the lip of the chat composer.
 *
 * Idle it sleeps (slow bob, drifting "zzz") with an apple hanging from the
 * branch above it. Call fcNap.bonk() and the apple drops on its head: squash,
 * sparks, antenna spring, eyes wide, a dazed shake, then it nods back off and
 * a new apple fades back onto the branch. One shot, ~2.4s, then idle again.
 *
 * Usage:
 *   <div id="fcNapMascot"></div>          <!-- just above the composer -->
 *   <script src="mascot_nap.js"></script>
 *   fcNap.bonk();                          // on send
 *
 * The robot is the same geometry as assets/mascot.svg (the login "peeking over
 * the edge" pose), so its hands rest on the composer's top edge; the composer
 * is lifted above it on the z axis so the body is cut off by the pill.
 */
(function () {
  'use strict';

  var MOUNT_ID = 'fcNapMascot';
  var BONK_MS = 2400;
  // it only naps until the first message: bonk, come round, then head off
  var WAKE_MS = 1450;          // point in the bonk where it stops being dazed
  var POKE_MS = 620;           // startle when someone prods it awake instead
  var LEAVE_MS = 1350;         // a few steps right, then down out of frame
  var COLLAPSE_MS = 450;       // giving the space back to the composer
  var GONE_KEY = 'fcnap_gone';

  var CSS = [
    /* the negative margin tucks just the hands behind the composer, so the
       robot reads as resting on its lip rather than sunk behind it */
    '#' + MOUNT_ID + '{max-width:860px;margin:0 auto -6px;display:flex;',
    '  justify-content:flex-end;padding-right:38px;pointer-events:none;',
    '  position:relative;z-index:1;overflow:hidden;max-height:82px;}',
    '#' + MOUNT_ID + ' svg{width:112px;height:82px;display:block;overflow:visible;}',
    /* the composer pill has to sit in front of the robot's waist */
    '#composerBox{position:relative;z-index:2;}',

    '.fcnap-ink{fill:#3a2b1c;}',
    '.fcnap-cream{fill:#f6f3eb;}',

    /* ---------- idle: asleep ---------- */
    '.fcnap .bot{transform-origin:94px 110px;animation:fcnapBreathe 3.4s ease-in-out infinite;}',
    '@keyframes fcnapBreathe{',
    '  0%,100%{transform:translateY(0) scaleY(1);}',
    '  50%{transform:translateY(1.5px) scaleY(.99);}}',

    '.fcnap .apple{transform-origin:94px 18px;animation:fcnapSway 3.4s ease-in-out infinite;}',
    '@keyframes fcnapSway{',
    '  0%,100%{transform:rotate(-2.5deg);}',
    '  50%{transform:rotate(2.5deg);}}',

    '.fcnap .eyes-open,.fcnap .bang,.fcnap .spark{opacity:0;}',
    '.fcnap .eyes-shut{opacity:1;}',

    '.fcnap .z{animation:fcnapZ 2.4s ease-out infinite;opacity:0;}',
    '.fcnap .z2{animation-delay:.8s;}',
    '.fcnap .z3{animation-delay:1.6s;}',
    '@keyframes fcnapZ{',
    '  0%{transform:translate(0,0) scale(.55);opacity:0;}',
    '  25%{opacity:1;}',
    '  70%{opacity:.75;}',
    '  100%{transform:translate(-15px,-26px) scale(1.1);opacity:0;}}',

    /* ---------- one shot: bonk ---------- */
    '.fcnap.is-bonk .zzz{animation:fcnapZzzHide ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapZzzHide{0%,84%{opacity:0;}100%{opacity:1;}}',

    '.fcnap.is-bonk .apple{animation:fcnapDrop ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapDrop{',
    '  0%{transform:translate(0,0) rotate(0deg);opacity:1;',
    '     animation-timing-function:cubic-bezier(.55,0,1,.55);}',
    '  12.5%{transform:translate(0,33px) rotate(9deg);',        /* impact */
    '     animation-timing-function:cubic-bezier(0,.5,.45,1);}',
    '  20%{transform:translate(-13px,17px) rotate(-45deg);',    /* bounce off */
    '     animation-timing-function:cubic-bezier(.55,0,1,.6);}',
    '  34%{transform:translate(-31px,94px) rotate(-125deg);opacity:1;}',
    '  40%{transform:translate(-36px,120px) rotate(-150deg);opacity:0;}',
    '  41%{transform:translate(0,0) rotate(0deg);opacity:0;}',
    '  88%{opacity:0;}',
    '  100%{transform:translate(0,0) rotate(0deg);opacity:1;}}',  /* new apple */

    '.fcnap.is-bonk .bot{animation:fcnapJolt ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapJolt{',
    '  0%,12.5%{transform:translateY(0) scaleY(1) rotate(0deg);}',
    '  15.5%{transform:translateY(5px) scaleY(.87) rotate(0deg);}',   /* squash */
    '  19.5%{transform:translateY(-2px) scaleY(1.05) rotate(0deg);}',
    '  23%{transform:translateY(0) scaleY(1) rotate(-4.5deg);}',      /* dazed */
    '  28%{transform:rotate(4.5deg);}',
    '  33%{transform:rotate(-2.5deg);}',
    '  38%{transform:rotate(1.5deg);}',
    '  43%,100%{transform:translateY(0) scaleY(1) rotate(0deg);}}',

    '.fcnap.is-bonk .antenna{transform-origin:55px 28px;',
    '  animation:fcnapAntenna ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapAntenna{',
    '  0%,12.5%{transform:rotate(0deg);}',
    '  15.5%{transform:rotate(-20deg);}',
    '  20%{transform:rotate(15deg);}',
    '  25%{transform:rotate(-9deg);}',
    '  30%{transform:rotate(4deg);}',
    '  35%,100%{transform:rotate(0deg);}}',

    '.fcnap.is-bonk .eyes-shut{animation:fcnapShut ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapShut{0%,12.4%{opacity:1;}12.5%,70%{opacity:0;}78%,100%{opacity:1;}}',
    '.fcnap.is-bonk .eyes-open{animation:fcnapOpen ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapOpen{0%,12.4%{opacity:0;}12.5%,70%{opacity:1;}78%,100%{opacity:0;}}',

    '.fcnap.is-bonk .bang{transform-origin:122px 62px;',
    '  animation:fcnapBang ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapBang{',
    '  0%,12.4%{opacity:0;transform:translateY(4px) scale(.4);}',
    '  17%{opacity:1;transform:translateY(-2px) scale(1.15);}',
    '  22%{opacity:1;transform:translateY(-4px) scale(1);}',
    '  50%{opacity:1;transform:translateY(-6px) scale(1);}',
    '  60%,100%{opacity:0;transform:translateY(-9px) scale(.9);}}',

    '.fcnap.is-bonk .spark{transform-origin:94px 68px;',
    '  animation:fcnapSpark ' + BONK_MS + 'ms linear 1 both;}',
    '@keyframes fcnapSpark{',
    '  0%,12.4%{opacity:0;transform:scale(.2);}',
    '  14%{opacity:1;transform:scale(.7);}',
    '  21%,100%{opacity:0;transform:scale(1.6);}}',

    /* ---------- poke: someone prodded it awake ---------- */
    /* only the robot itself is clickable; the rest of the strip stays inert */
    '.fcnap .bot{pointer-events:auto;cursor:pointer;}',

    '.fcnap.is-poked .zzz,.fcnap.is-poked .eyes-shut{opacity:0;animation:none;}',
    '.fcnap.is-poked .eyes-open{opacity:1;animation:none;}',

    '.fcnap.is-poked .bot{animation:fcnapStartle ' + POKE_MS + 'ms ease-out 1 both;}',
    '@keyframes fcnapStartle{',
    '  0%{transform:translateY(0) scaleY(1) rotate(0deg);}',
    '  10%{transform:translateY(2px) scaleY(.93) rotate(0deg);}',   /* flinch down */
    '  28%{transform:translateY(-7px) scaleY(1.07) rotate(0deg);}', /* jumps */
    '  48%{transform:translateY(0) scaleY(.97) rotate(-4deg);}',
    '  68%{transform:translateY(-1px) scaleY(1.01) rotate(4deg);}',
    '  100%{transform:translateY(0) scaleY(1) rotate(0deg);}}',

    '.fcnap.is-poked .antenna{transform-origin:55px 28px;',
    '  animation:fcnapAntenna ' + (POKE_MS * 2.4) + 'ms linear 1 both;}',

    '.fcnap.is-poked .bang{transform-origin:122px 62px;',
    '  animation:fcnapBangPoke ' + POKE_MS + 'ms ease-out 1 both;}',
    '@keyframes fcnapBangPoke{',
    '  0%{opacity:0;transform:translateY(4px) scale(.4);}',
    '  22%{opacity:1;transform:translateY(-3px) scale(1.15);}',
    '  40%{opacity:1;transform:translateY(-5px) scale(1);}',
    '  100%{opacity:1;transform:translateY(-7px) scale(1);}}',

    /* ---------- one shot: it clocks off ---------- */
    /* awake and on its way out — everything that belongs to the nap is off */
    '.fcnap.is-leaving .zzz,.fcnap.is-leaving .eyes-shut,',
    '.fcnap.is-leaving .bang,.fcnap.is-leaving .spark{opacity:0;animation:none;}',
    '.fcnap.is-leaving .eyes-open{opacity:1;animation:none;}',
    /* the apple only disappears if it already fell on its head */
    '.fcnap.no-apple .apple{opacity:0;animation:none;}',

    '.fcnap.is-leaving .bot{animation:fcnapLeave ' + LEAVE_MS + 'ms ease-in 1 both;}',
    '@keyframes fcnapLeave{',
    '  0%{transform:translate(0,0) rotate(0deg);}',
    '  12%{transform:translate(-2px,0) rotate(-5deg);}',     /* one last glance up */
    '  24%{transform:translate(0,0) rotate(0deg);}',
    /* a couple of steps sideways, a teeter on the edge, then straight down
       behind the composer — the drop is the exit, not a long walk offscreen */
    '  38%{transform:translate(9px,-2px) rotate(4deg);}',     /* step */
    '  52%{transform:translate(17px,0) rotate(-3deg);}',      /* step */
    '  62%{transform:translate(20px,-3px) rotate(2deg);',     /* teeter */
    '     animation-timing-function:cubic-bezier(.5,0,1,1);}',
    '  100%{transform:translate(23px,84px) rotate(9deg);}}',  /* drops */

    '@media (prefers-reduced-motion:reduce){',
    '  #' + MOUNT_ID + ' *{animation:none!important;}',
    '  .fcnap .z,.fcnap .eyes-open,.fcnap .bang,.fcnap .spark{opacity:0!important;}}'
  ].join('\n');

  /* The robot is assets/mascot.svg at scale .62, dropped so its hands land on
     the composer edge (svg bottom). Head centre ends up at (94, 82). */
  var SVG = [
    '<svg class="fcnap" viewBox="0 0 150 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',

    /* branch the apple hangs from */
    '<path d="M149 6 C 130 4, 110 9, 93 17" stroke="#4a3828" stroke-width="4.5"',
    '      stroke-linecap="round" fill="none"/>',
    '<ellipse cx="118" cy="4" rx="11" ry="6" fill="#6f8259" transform="rotate(-12 118 4)"/>',
    '<ellipse cx="137" cy="10" rx="9" ry="5" fill="#7f9367" transform="rotate(-16 137 10)"/>',

    /* the robot */
    '<g class="bot"><g transform="translate(60 51) scale(0.62)">',
    '  <path class="fcnap-ink" d="M25 80 C 25 65, 85 65, 85 80 L 85 95 L 25 95 Z"/>',
    '  <g class="antenna">',
    '    <circle class="fcnap-ink" cx="55" cy="12" r="5"/>',
    '    <line x1="55" y1="16" x2="55" y2="28" stroke="#3a2b1c" stroke-width="3"/>',
    '  </g>',
    '  <path class="fcnap-ink" d="M 23 48 Q 17 48 17 41 Q 17 34 23 34 Z"/>',
    '  <path class="fcnap-ink" d="M 87 48 Q 93 48 93 41 Q 93 34 87 34 Z"/>',
    '  <rect class="fcnap-ink" x="25" y="27" width="60" height="46" rx="22"/>',
    '  <rect class="fcnap-cream" x="35" y="37" width="40" height="26" rx="12"/>',
    '  <g class="eyes-shut" fill="none" stroke="#3a2b1c" stroke-width="3" stroke-linecap="round">',
    '    <path d="M41 47 q 5 5 10 0"/><path d="M59 47 q 5 5 10 0"/>',
    '  </g>',
    '  <g class="eyes-open">',
    '    <circle class="fcnap-ink" cx="46" cy="48" r="5.5"/>',
    '    <circle class="fcnap-ink" cx="64" cy="48" r="5.5"/>',
    '    <circle class="fcnap-cream" cx="47.5" cy="46.5" r="1.8"/>',
    '    <circle class="fcnap-cream" cx="65.5" cy="46.5" r="1.8"/>',
    '  </g>',
    '  <circle class="fcnap-ink" cx="22" cy="85" r="10"/>',
    '  <circle class="fcnap-ink" cx="88" cy="85" r="10"/>',
    '  <path d="M 18 80 Q 22 76 26 80" stroke="#f6f3eb" stroke-width="1.5"',
    '        stroke-linecap="round" fill="none" opacity=".5"/>',
    '  <path d="M 84 80 Q 88 76 92 80" stroke="#f6f3eb" stroke-width="1.5"',
    '        stroke-linecap="round" fill="none" opacity=".5"/>',
    '</g></g>',

    /* impact sparks, centred on the top of the head */
    '<g class="spark" stroke="#3a2b1c" stroke-width="2" stroke-linecap="round" fill="none">',
    '  <path d="M94 62 v-6"/><path d="M85 65 l-5 -4"/><path d="M103 65 l5 -4"/>',
    '  <path d="M80 71 l-6 -1.5"/><path d="M108 71 l6 -1.5"/>',
    '</g>',

    /* the startled "!" */
    '<g class="bang">',
    '  <path d="M120 52 h4.5 l-1 12 h-2.5 Z" fill="#3a2b1c"/>',
    '  <circle cx="121.8" cy="68.5" r="2.3" fill="#3a2b1c"/>',
    '</g>',

    /* zzz drifting off to the left */
    '<g class="zzz" fill="#3a2b1c" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-weight="700">',
    '  <text class="z z1" x="64" y="78" font-size="9">z</text>',
    '  <text class="z z2" x="58" y="72" font-size="11">z</text>',
    '  <text class="z z3" x="51" y="65" font-size="13">z</text>',
    '</g>',

    /* the apple */
    '<g class="apple">',
    '  <path d="M94 22 C 93 19, 93 16, 92 14" stroke="#4a3828" stroke-width="2"',
    '        stroke-linecap="round" fill="none"/>',
    '  <path d="M95 20 C 99 16, 105 17, 106 19 C 102 23, 97 23, 95 20 Z" fill="#6f8259"/>',
    '  <circle cx="94" cy="27" r="7.5" fill="#c0563f"/>',
    '  <path d="M90 24 a 5 5 0 0 1 3.5 -2" stroke="#f6f3eb" stroke-width="1.6"',
    '        stroke-linecap="round" fill="none" opacity=".55"/>',
    '</g>',
    '</svg>'
  ].join('\n');

  var mount = null;
  var timers = [];
  var busy = false;

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  function hasLeft() {
    try { return sessionStorage.getItem(GONE_KEY) === '1'; } catch (e) { return false; }
  }

  function init() {
    mount = document.getElementById(MOUNT_ID);
    if (!mount || mount.dataset.fcnapReady) return;

    var style = document.getElementById('fcnap-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'fcnap-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    mount.dataset.fcnapReady = '1';

    // it already clocked off earlier this session — don't bring it back
    if (hasLeft()) { mount.style.display = 'none'; return; }
    mount.innerHTML = SVG;

    // prod it awake — pointerdown so a tap reacts immediately, no 300ms wait
    var bot = mount.querySelector('.bot');
    if (bot) {
      bot.addEventListener('pointerdown', function (e) { e.preventDefault(); poke(); });
    }
  }

  /* Shared tail: it walks a few steps, drops out of frame, and the strip
     collapses. `wakeMs` is how long the wake-up it just had runs for. */
  function leave(svg, wakeMs, wakeClass) {
    later(function () {
      svg.classList.remove(wakeClass);
      svg.classList.add('is-leaving');
    }, wakeMs);

    later(function () {
      // give the height back to the composer once it's out of frame
      mount.style.transition = 'max-height ' + COLLAPSE_MS + 'ms ease, ' +
                               'margin-bottom ' + COLLAPSE_MS + 'ms ease, ' +
                               'opacity ' + Math.round(COLLAPSE_MS * 0.7) + 'ms ease';
      mount.style.maxHeight = '0px';
      mount.style.marginBottom = '0px';
      mount.style.opacity = '0';
    }, wakeMs + LEAVE_MS);

    later(function () {
      mount.style.display = 'none';
      mount.innerHTML = '';
      try { sessionStorage.setItem(GONE_KEY, '1'); } catch (e) {}
      busy = false;
    }, wakeMs + LEAVE_MS + COLLAPSE_MS);
  }

  // shared entry guard: returns the live <svg>, or null if it can't run
  function begin() {
    if (!mount) init();
    if (busy || hasLeft()) return null;
    var svg = mount && mount.querySelector('svg');
    if (!svg) return null;
    busy = true;
    return svg;
  }

  /* Wake it with the apple, then send it on its way. Only ever runs once:
     after the first message the mascot is gone for the rest of the session. */
  function bonk() {
    var svg = begin();
    if (!svg) return;
    svg.classList.add('is-bonk', 'no-apple');   // the apple fell; it doesn't come back
    leave(svg, WAKE_MS, 'is-bonk');
  }

  /* Someone prodded it. It startles awake and heads off — no apple involved,
     so that one stays hanging on the branch. */
  function poke() {
    var svg = begin();
    if (!svg) return;
    svg.classList.add('is-poked');
    leave(svg, POKE_MS, 'is-poked');
  }

  /* bring it back for a fresh nap (new chat session, or just to see it again) */
  function reset() {
    try { sessionStorage.removeItem(GONE_KEY); } catch (e) {}
    timers.forEach(clearTimeout);
    timers = [];
    busy = false;
    if (mount) {
      mount.style.cssText = '';       // drop the collapse/display-none from the exit
      mount.dataset.fcnapReady = '';
    }
    init();                            // re-resolves the mount if we never had one
  }

  window.fcNap = { init: init, bonk: bonk, poke: poke, reset: reset };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
