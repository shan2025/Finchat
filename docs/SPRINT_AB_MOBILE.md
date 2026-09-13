# Sprint AB — FinChat on Mobile Phones

**Status:** Phase 1 shipped locally 2026-09-13 (verified at 375×812, not yet deployed) · Phases 2–4 open · Phase 5 optional
**Written:** 2026-09-13

---

## 0. Decision: responsive web + PWA, not a native app

FinChat is 19 HTML pages on one theme (`finchat_theme.css`), one shared rail
(`sidebar_nav.js`), one prebuilt Tailwind bundle, served by the same Express
process as the API. A React Native / Flutter client would duplicate that whole
surface and every future page, for no product gain.

The plan is instead:

1. make the existing pages work at phone width,
2. add a web app manifest so the site installs to the home screen with an icon
   and receives push (web push is already wired: `sw.js` + `backend/.vapid-keys.json`),
3. only if a store listing is wanted, wrap the same pages with **Capacitor**.

Step 3 needs steps 1–2 first, so nothing here is thrown away whichever way
that decision goes.

---

## 1. Audit (2026-09-10)

What already worked:

- `width=device-width` viewport meta on every real page.
- `sidebar_nav.js` already turns the rail into an off-canvas drawer below 768px.
- Dashboard, Agents, Knowledge, Blockchain, Settings carry `md:`/`lg:` variants.
- `sw.js` handles `push` and `notificationclick`.

What was broken or missing:

| # | Problem | Scope |
|---|---|---|
| 1 | Drawer hides the rail below 768px, but **Knowledge, Reports and Audit have no toggle** to open it again — a phone user on those pages cannot navigate anywhere | 3 pages |
| 2 | `h-screen` = `100vh`, which mobile browsers never shrink for the keyboard or URL bar — pinned layouts (chat composer) end up under the keyboard | 13 pages |
| 3 | No responsive rules at all: `brainmodel`, `mindmap`, `neuralspace`, `login`, `signup` | 5 pages |
| 4 | Canvas pages (Agent Map, Neural Space, Neural Map, Mind Maps) are mouse-driven — no pinch-zoom, no touch pan | 4 pages |
| 5 | Grids that never collapse (Dashboard 9 multi-col / 6 `md:`; Knowledge 7 / 5), fixed `w-64/w-80/w-96` panels on 12 pages, 6 tables without horizontal scroll | many |
| 6 | No manifest, no `theme-color`, `sw.js` has no `install`/`fetch` handler and is registered only from Settings when push is enabled → **not installable** | app-wide |

Notes that change how the work is done:

- **Tailwind is prebuilt.** A new `md:`/`sm:` class is a dead string until
  `npm run build:css` (in `legacy_prototype/backend`). The CSS output is
  gitignored and rebuilt by the Dockerfile on deploy.
- **SPA router pages** (Knowledge, Reports, Settings, Mind Maps) swap only
  `<main>`. Anything shell-level has to re-decide per view, not per document.
- Neural Space has its own menu button (`#nsMenu`) and `finchat_inbox.html` /
  `finchat_universe.html` are redirect stubs — none of the three needed a toggle.

---

## 2. Phases

| Phase | Outcome | Work | Effort |
|---|---|---|---|
| **1 — Reachable** | Every page can be navigated on a phone; keyboard never hides input | Shared mobile bar; dvh | ½ day · **done** |
| **2 — Readable** | Nothing needs sideways scrolling; everything tappable | Grid `md:` audit, table scroll wrappers, `w-full md:w-80` panels, 44px targets, login/signup | 1–2 days |
| **3 — Installable** | "Add to Home Screen" gives an app icon, splash, standalone window | `manifest.webmanifest`, icons, `theme-color` + apple meta, `install`/`fetch` in `sw.js`, register on every page | ½ day |
| **4 — Spatial pages** | Agent Map / Neural Space / Neural Map / Mind Maps usable by touch — **or** a deliberate desktop-first notice | Pointer events + pinch-zoom, or a mobile summary panel | 2–4 days, or ½ day for the notice |
| **5 — Store (optional)** | Play Store / App Store listing | Capacitor wrapper over the same pages | ~1 week |

**Open decision (Phase 4):** touch-enable the spatial pages, or show a
mobile summary and defer. They are the most distinctive screens and the most
expensive to make finger-driven, and a 375px-wide district map may be a worse
experience than a good summary however well the gestures work.

---

## 3. Phase 1 — shipped 2026-09-13

### 3.1 Shared mobile app bar — `sidebar_nav.js`

A 52px bar (menu button, mascot, wordmark) that exists only below 768px **and**
only when the page has no drawer toggle of its own (`#navToggle`, `#nsMenu`,
or `[data-nav-toggle]`). It:

- reserves its height with `padding-top` on `body` (plus
  `env(safe-area-inset-top)`), so it never covers a page header;
- owns its own backdrop (`#sbnMBackdrop`) and never touches a page's
  `#navBackdrop`, so page-driven drawers and bar-driven drawers cannot fight;
- closes on backdrop tap, Escape, nav-link tap, and rotation past 768px;
- follows the rail's espresso/cream theme;
- is re-decided in `syncActive()`, which the SPA router calls after every
  swap — Settings (own toggle) hides it, Knowledge/Reports show it.

Chosen over per-page toggle markup because this is the file that already
survives design-tool regenerations; three hand-pasted copies would not.

### 3.2 Dynamic viewport height — `tailwind.shared.js`

`height`, `minHeight`, `maxHeight` `screen` now emit a fallback pair:

```css
.h-screen{height:100vh;height:100dvh}
.min-h-screen{min-height:100vh;min-height:100dvh}
```

One config change covers all 13 pages and both stylesheets (main + audit).

### 3.3 Verified, not assumed

Local dev server, viewport 375×812, a dummy session object so pages render
(API calls 401, so this covers layout and behaviour only, not data):

| Check | Result |
|---|---|
| Knowledge: bar shown, body padded 52px, no horizontal overflow (scrollWidth 375) | ✅ |
| Bar button opens drawer; backdrop tap closes it | ✅ |
| Audit: header sits directly under the bar (52px), pinned body stays 812px | ✅ |
| Dashboard (own toggle): no bar, no padding | ✅ |
| **Real SPA swap** Knowledge → Settings: bar hides, Settings' toggle opens drawer | ✅ |
| **Real SPA swap** Settings → Reports: bar returns, drawer closed | ✅ |
| Escape does not close a drawer the page opened itself | ✅ |
| Theme rebuild: still exactly one bar and one backdrop; cream follows rail | ✅ |
| Nav-link tap closes the bar's drawer | ✅ |
| Desktop 1280×800: no bar, no padding, rail at left 0, main margin 256px | ✅ |
| Console: no JS errors (only the expected 401s) | ✅ |
| Built CSS contains the dvh pairs, main and audit | ✅ |

**Not yet verified:** a real phone (iOS Safari keyboard behaviour in
particular), and a signed-in session.

**Seen during verification, left for Phase 2:** Audit overflows by 1px at 375px
(`scrollWidth` 376) — its header search is a fixed `w-64`.
