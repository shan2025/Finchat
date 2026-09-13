# Sprint AB — FinChat on Mobile Phones

**Status:** Phases 1–2 committed locally 2026-09-13 (verified at 375×812, not yet deployed) · Phases 3–4 open · Phase 5 optional
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

~~Audit overflows by 1px at 375px~~ — not real: the emulated viewport is
375.2px wide, so the "overflow" is sub-pixel rounding (confirmed in Phase 2).

---

## 4. Phase 2 — shipped 2026-09-13

### 4.1 Measured, not eyeballed

Every non-spatial page was loaded at 375×812 and scanned by script for
elements past the viewport edge, content clipped by an `overflow:hidden`
ancestor, and tap targets under 36px. Then each page was screenshotted,
because the scan cannot see a layout that fits but reads badly (Settings).

| Page | Found | Severity |
|---|---|---|
| **Chat** | Composer toolbar needed 712px and can't wrap → **Send button off-screen**; the `flex-1` section had `min-width:auto`, so the whole conversation column stretched to 793px and was clipped | **Critical — could not send a message** |
| Chat | Header squeezed the agent name to "P…"; replies capped at ~220px wide; markdown tables crushed to one word per line | High |
| Dashboard | Header controls didn't shrink → page 521px wide (sideways scroll); menu button squashed to 26px | High |
| Agents | Same header pattern → 397px | Medium |
| Settings | Header bottom-aligned with the menu button stranded mid-row; each tab `width:100%` so "Bring Your Own AI" wrapped to 4 lines; two tables with ~354px of fixed columns inside a ~330px `overflow:hidden` card | High (layout fit, so only a screenshot caught it) |
| Blockchain | 4,814px drifting chain strip that pauses on *hover* — unreachable by touch | Medium |
| Login / Signup / Reports / Settings | "Forgot Password?" 20px tall; buttons/tabs 34px; switches 24px | Low |
| Group Chat, Knowledge, Reports, Audit, Login, Signup | Clean | — |

### 4.2 Fixes

| Fix | Where | Desktop impact |
|---|---|---|
| `min-w-0` on the chat section (the actual root cause of the stretch) | `finchat_chat.html` | none |
| Phone composer: Web/Study go icon-only with the chip colour carrying on/off; avatar-only agent picker; token hint, duplicate image button and handler-less mic dropped; input 16px so iOS doesn't zoom on focus; safe-area bottom padding | `finchat_chat.html` (`@media max-width:767px`) | none |
| Phone chat header (60px, tighter gaps, 40px buttons) and message rows (100% bot / 88% user, 30px avatar gutter) | `finchat_chat.html` | none |
| Markdown tables wrapped in `.md-table-scroll` by `renderMessageBody` — the table was its own scroll box, which capped its column layout at bubble width; now the wrapper scrolls and the table sizes naturally (up to 36em on phones, then long cells wrap) | `finchat_chat.html` | none — same 100% cap |
| Dashboard/Agents headers: short titles on phones ("Operations", "Agents"), `min-w-0` + `truncate`, icon-only Refresh, LIVE badge hidden below `sm`, `shrink-0` 40px menu button, `p-4 md:p-8` | `finchat_dashboard.html`, `finchat_agents.html` | none |
| Dashboard section title rows `flex-wrap` | `finchat_dashboard.html` | none (only wraps when it doesn't fit) |
| Settings phone header (one centred row), nowrap tabs, tables become wrapping rows below 640px | `finchat_settings.html` | none |
| Blockchain chain: on `(hover: none)` the drift stops and the strip swipes | `finchat_blockchain.html` | none |
| Touch-only hit areas via `(pointer: coarse)`: invisible padding/`::before` so what's drawn doesn't change | login, signup, settings, reports | none |

### 4.3 Verified

At 375×812 after the fixes: document width exactly 375 on Chat, Dashboard,
Agents, Blockchain, Settings. Chat Send at x 312–356, both toggles on-screen,
input 16px. A real `renderMessageBody` call with a 5-column table: rows 36px
(were ~100px), table 486px scrolling inside a 286px bubble; a sentence-length
table wraps at readable widths. Settings delivery table with sample rows: no
cell clipped, Target 318px wide. Blockchain strip `overflow-x:auto`, animation
none. At 1280×800 every changed page reads back its original desktop values
(labels, tracks, titles, paddings, 236px settings nav, bottom-aligned header,
coarse-pointer rules inactive). No JS exceptions.

**Not verified:** real devices (iOS keyboard + safe areas especially), and
pages populated with real data beyond the injected samples.

**Seen, not fixed:**
- Agents on a phone lists all six agents first; the configuration card for
  the one you tap is far below and nothing scrolls to it.
- Group Chat's header wraps its buttons onto a second, left-aligned row —
  usable, not tidy.
- Neural Map's toolbar wraps to three rows — held for the Phase 4 decision.
