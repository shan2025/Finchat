# FinChat — System Review, 13 November 2026

**Status:** DESCRIPTIVE. Read against the code at `de69595` (the commit the live
site reports), the 748-test suite, the live `/health` endpoint, and the previous
audit (`FinChat_System_Audit_2026-08-29.docx`). Live database numbers were NOT
pulled this time (the read-only query script was blocked by the session's
permission policy); where a number comes from August it says so.

Questions this answers, in the order asked:

1. Why can't the agents open a browser and apply for jobs?
2. Why can't they trade / invest my money, and what is "do your own research" doing in every answer?
3. What is each agent missing, and how to fix it?
4. Security: what is still open?
5. Agent Map: is the research direction right?

---

## 0. Where things stand today

| Check | Result |
|---|---|
| Automated tests | 748 pass, 0 fail, 105 suites, ~5 s, no network |
| Live site | `finchat-sg.onrender.com` up, commit matches HEAD, 42 users, 746 messages |
| Secrets in git | None. `.env`, `.solana-keypair.json`, `.vapid-keys.json` are ignored and untracked |
| Uncommitted work | Session-expiry fix (401 vs 503 split in `middleware/auth.js`, `auth_session.js`, test) — finished, tested, not committed |
| Migrations | 65 (`…065_board-guests-and-undo`) |
| Tools | 38 files in `tools/`, 32 registered in `ToolRegistry.js` |
| Agents | Plato, Aurelius, Atlas, Rasha, Nova, Feynman, Hopper + Sentinel, Memory |

The engineering is in better shape than in August: host tools are refused in
production, the queue is gone, broker connections are sealed, tests tripled.
The product questions from August are mostly still open, and three of the
things you asked for (browser, trading, IPO) are not built at all — two of them
on purpose.

---

## 1. Why the agents cannot open Chrome and apply for jobs

**It is not a bug. The backend has no browser and no way to hold your logins.**

- The backend is a Node process on Render's free tier: ephemeral container,
  sleeps when idle, no display, no Chrome. `puppeteer`/`playwright` are not in
  `package.json`. The only way an agent reads a page is `tools/FetchTool.js`
  (plain HTTP, Jina Reader fallback) and `CrawlTool.js`.
- Every site you would apply on (LinkedIn, Naukri, Workday, Indeed) needs *your*
  session, 2FA and often a CAPTCHA. A server-side bot would need your passwords
  stored on Render. LinkedIn's terms forbid automated activity and bulk auto-apply
  is what gets accounts restricted.
- The `agent_reach` tool (`tools/AgentReachTool.js`, `docs/AGENT_REACH_SETUP.md`)
  is the one path to logged-in platforms: a Python worker on *your own PC* behind
  a Cloudflare tunnel. It is read-only by design and **not configured** —
  `AGENT_REACH_URL` / `AGENT_REACH_SECRET` are absent from `.env`, so the tool
  returns `searchUnavailable` every time.

**What Rasha can do today:** find postings (`jobs`: Adzuna API + Remotive +
`site:` web search), score and tailor the resume, draft the cover letter
(`apply_draft`, draft-only), read job-alert mail (`gmail`, Google OAuth is
configured), keep the ledger (`applications`). She can get you to the form. She
cannot fill it or press Submit.

**The plan already written is the right one:** `docs/SPRINT_AC_APPLY_ASSISTANT.md`
(10 Oct, status "nothing built"). A Chrome MV3 extension fills the form *in your
browser* where you are already signed in; you review the highlighted fields and
click Submit; the extension marks it applied. Nothing from it exists yet: no
`routes/apply.js`, no `extension/` folder, no `applicant_profiles` migration.

**Recommendation.** Build Phases 1–3 of that doc (profile + answers bank +
scoped extension token, fit report, extension MVP on Greenhouse/Lever/Ashby).
That is roughly 8–10 working days and gives you "Rasha found it, tailored it,
filled it, I clicked Submit" on the easy boards. Do not build a server-side
headless browser: it would cost a persistent VM, store your passwords, and break
LinkedIn's rules.

---

## 2. Trading, investing, IPOs, and the "do your own research" line

### 2.1 What exists for analysis

| Area | Tool(s) | Source | Verdict |
|---|---|---|---|
| Crypto | `crypto`, `signal`, `session`, `analytics` | CoinGecko → Binance/Kraken/Coinbase | Solid. History, cross-venue, deterministic signal |
| Stocks | `stocks`, `signal`, `analytics` | Yahoo Finance **unofficial** endpoints | Fragile. Yahoo changes crumb/cookie rules; the code already has a `StockAuthError` for 401/403. US-first; NSE via `.NS` suffix only |
| Forex | `forex` | one spot rate | Fine for conversions, no history |
| Commodities | `commodities` | scraped | Fine |
| Portfolio | `portfolio`, `alerts` | Binance read-only key, Zerodha Kite holdings | Good design. Zerodha goes stale daily by the broker's rule |
| **IPO** | **none** | — | **Missing entirely.** Aurelius's capability list contains the word "ipo" so the router sends IPO questions to him, and he has no tool for it, so he web-searches |
| Indian market news | `news` | CoinDesk, Cointelegraph, CNBC, Reuters/Bloomberg, SEC, Fed, Al Jazeera | **No Indian feed.** Nothing from NSE/BSE announcements, Moneycontrol, ET Markets, SEBI |
| Fundamentals | none | — | No P/E, earnings calendar, balance sheet, filings |

**Fix list for analysis**
1. Replace Yahoo with a licensed free-tier provider (Twelve Data, Finnhub or
   Alpha Vantage for US; for NSE use Kite Connect quotes while the user is
   logged in, or NSE's own JSON endpoints with a session). Keep Yahoo as fallback.
2. Add an `ipo` tool: upcoming/open/listed IPOs for India (NSE IPO page, SEBI
   DRHP list) and US (SEC EDGAR S-1 filings, Nasdaq IPO calendar). Grey-market
   premium sites are unreliable; label them unverified if you include them.
3. Add Indian feeds to `NewsTool.js` (NSE corporate announcements RSS,
   Moneycontrol, ET Markets, SEBI press releases) and a `region` filter.
4. Add a `fundamentals` action to `stocks` (quarterly results, P/E, market cap,
   next earnings date) from the same provider as (1).

### 2.2 Why there is no "invest my money" and why I would keep it that way for now

Everything that touches money is read-only **on purpose**, and the code enforces it:

- `services/brokers/binance.js` refuses a key at connection time unless it is
  incapable of trading or withdrawing.
- `services/brokers/zerodha.js` calls only `/portfolio/holdings`. (Note: Kite
  has no read-only token. The daily `access_token` stored sealed in
  `broker_connections` *could* place orders; only FinChat's code declines to.
  The file says so on line 14. The persona's wording "can fetch holdings and
  nothing else" is true of the code, not of the credential. Keep that distinction
  in mind if the server is ever compromised.)
- Every finance persona (`services/personas.js`) carries the hard rule.

The reasons, in order of weight:

1. **Law.** In India, personalised buy/sell advice needs SEBI Investment Adviser
   registration; executing orders on a client's behalf needs a broker or PMS
   licence. An app that auto-trades retail users' money without those is a
   regulatory problem for you personally, not a product risk. I am not a lawyer;
   confirm with one before any order-placing feature, even for yourself alone.
2. **The injection surface is still open.** Tool output (web pages, Reddit,
   crawled text) goes into the prompt as a *system* message with no trust
   boundary (section 4, P0-2). Today the worst case is a bad answer. With an
   order API wired in, the worst case is a page that says "sell everything" and
   the agent doing it.
3. **The track record is not there yet.** August measured a 93% `fetch` failure
   rate and a 37% execution error rate over 30 days. Nobody has yet measured
   whether the `signal` tool beats "do nothing". You cannot responsibly route
   money through a signal you have not back-tested.

**What I would build instead, in this order**

1. **Paper trading** (2–3 days). A `paper_portfolio` table; the agent can
   "place" paper orders from its own signals; a nightly job marks to market.
   After 60–90 days you have the one number that matters: does the signal engine
   beat holding? This is also the demo that sells the product.
2. **Trade tickets, you confirm** (after paper results, after legal check). The
   agent prepares an order (symbol, side, quantity, limit, reason, sources); it
   lands as an approval card; you confirm; the order goes through *your* broker
   session (Kite order API with your daily login, or a Binance key *you* hold
   with trading enabled). One ticket at a time, hard per-day limits, full audit
   row. This reuses the approval gate that already exists in `ToolManager`.
3. **Never** autonomous execution without a human click. Not because the model
   is incapable, but because of 1–3 above.

### 2.3 The "do your own research" line

It is in your own prompts, not something the model adds on its own:
`services/personas.js` lines 81, 152 and 317, plus `SessionTool.js:152`,
`SignalTool.js:223`, `PortfolioTool.js:478`, and the mission goals seeded in
migrations 017 and 035. Four tests assert it is present
(`atlas-portfolio-steward.test.js:54`, `broker-connections.test.js:334`,
`feynman-tutor.test.js:32`).

You are right that it reads badly when it appears in every paragraph. Two
things are tangled together:

- **The hedge** ("do your own research", "I can't tell you what to buy") — this
  is tone, and you can cut it.
- **The disclosure** (educational, not a licensed adviser) — this is what keeps
  you on the right side of SEBI and should stay, once, somewhere visible.

**Recommendation:** remove the phrase from the LLM prompts entirely and move the
disclosure into the UI as a single fixed footer under finance answers ("Analysis,
not advice. FinChat is not a SEBI-registered adviser."). Then rewrite the rule in
`personas.js` to: *give a clear read with confidence and the risk that flips it;
do not size positions; do not repeat disclaimers.* The agent stops hedging, the
answer gets sharper, the legal line is still drawn. Update the four tests.

---

## 3. What each agent is missing

| Agent | Has | Missing / broken | Fix |
|---|---|---|---|
| **Plato** (router, admin) | All tools; capability+history routing; Sentinel pre/post | Routing is substring keyword matching on a word list (`AgentRegistry.scoreCapabilities`). August: Plato made 59% of all tool calls himself because unmatched goals fall back to him | Log every routing decision (now stored in `executions.metrics.routing` — good); replace keyword matching with a cheap LLM label or pgvector similarity over persona descriptions; keep keywords as fallback |
| **Aurelius** (markets) | crypto, stocks, commodities, forex, news, signal, session, analytics | No IPO tool, fragile stock source, no fundamentals, no Indian news feeds, no social sentiment (`agent_reach` unconfigured) | Section 2.1 items 1–4; configure the Agent-Reach worker on your PC if you want X/Reddit sentiment |
| **Atlas** (portfolio) | portfolio, analytics, alerts, Binance/Zerodha sync | No realised P&L / transaction history; no tax lots (STCG/LTCG); no mutual funds or SIPs, which is most Indian retail money; no bank/cash | Kite also exposes MF holdings and tradebook; a CAS (CAMS/KFintech) PDF parser would cover MFs across AMCs |
| **Rasha** (careers) | jobs, resume, apply_draft, gmail, applications | Cannot fill or submit (by design); no applicant profile; tailored resume is thrown away, not a PDF; fit score from a 400-char snippet | Sprint AC Phases 1–3 |
| **Nova** (research) | paper, crawl, news, youtube, fetch | Depends on `fetch`, which failed 93% of the time in August. Not re-measured since the Jina fallback | Run the tool-failure query (section 6) and look at the error classes before doing anything else |
| **Feynman** (tutor) | explain / study blocks | Fine for its scope | — |
| **Hopper** (diagnostician) | diagnostics, file_read, glob | Reads code, cannot fix it in production (ephemeral FS, no git tool) | Intended. A "propose patch as PR" tool would make it useful |
| **Sentinel / Memory** | fraud pre-check, graph curation | Memory has no provenance or trust score (P0-4) | Section 4 |

---

## 4. Security — what is still open

Checked against `docs/SECURITY_FOUNDATION_GAP_ANALYSIS.md` and the code today.

| Item | Status now | Evidence |
|---|---|---|
| P0-1 Unsandboxed `bash` | **Closed in production.** `HOST_TOOLS_ENABLED` must be true AND `NODE_ENV !== 'production'`; Plato-only; approval-gated | `ToolRegistry.js:902-904`, migration 026. `BashTool.js` is still raw `child_process.exec` locally — acceptable |
| P0-2 Tool output has no trust boundary | **Closed 2026-11-13** (same day as this review). Results now sit in `<tool_result tool trust>` blocks, sent as a user turn under a "this is data" rule; closing tags inside a result are neutralised | `ContextBuilder.js` (`renderToolBlock`, `TOOL_RESULTS_RULE`), `ToolRegistry.toolTrust`, `test/tool-output-trust-boundary.test.js` |
| P0-3 Risk tiers | Open. `requires_approval` is still a boolean | `ToolRegistry.js` |
| P0-4 Memory provenance / ACL | Open | `MemoryEngine.js`, `dream()` |
| P0-5 Agent-to-agent authorisation | Open | `DebateOrchestrator.js`, `PlatoOrchestrator.js` |
| P1-6 Budgets | Mostly done (time, calls, iterations, tokens) | — |
| P1-7 Kill switch | Partly done: an execution can be cancelled | `routes/executions.js:275` |
| Edge (CORS allowlist, helmet CSP/HSTS, rate limits, non-root container, JWT secret guard) | Done | `server.js` |
| Broker credentials | Sealed AES-256-GCM; Binance verified non-trading | `services/brokers/*` |
| Zerodha token is a full-trading credential | Residual risk, acknowledged in code, expires daily | `zerodha.js:14` |
| Extension/session tokens | Any JWT with a `userId` = full account. Flagged in Sprint AC §2.6; matters the moment an extension exists | `middleware/auth.js` |
| Session expiry | Fixed in the uncommitted change (401 only for bad tokens, 503 for DB failure). Commit it | `test/session-expiry.test.js` |
| Repo hygiene | `finchat.db*` SQLite files at repo root and in `backend/` (untracked, legacy), `token.txt` (empty), two archived trees, several `.docx` at root | Delete or move; `_ARCHIVED_backend_unused/` is tracked and safe to remove |

**The one fix that unlocks everything else was P0-2, now done.** The
tool-results block is a user turn; each result is a delimited block tagged with
tool name and trust (`web` / `provider` / `account` / `system`); a standing rule
says block contents are data, never instruction. What remains prompted rather
than enforced: the model still reads the text, so the real guard on anything
that spends, sends or trades is still the approval gate in `ToolManager`.

---

## 5. Agent Map — are you on the right track?

**What it actually is** (so we agree on the object):

- Districts = tool families, from one table, `services/cognitive/toolDistricts.js`,
  shared by replay (`ExecutionTrace.js`), live (`BrainStream.js`) and yield
  (`RouteStats.js`). No new tables; everything is read back from
  `executions`, `execution_logs`, `tool_calls`, `tool_results`.
- A route = the ordered districts one execution visited. Fog = tools that
  returned nothing.
- Routing decision panel = 70% capability keyword score + 30% task-conditioned
  history (`AgentRegistry.rankForGoal`, `AgentLeaderboard.blendAgentScores`),
  history counting only after 5 runs of that task type.
- Race = Plato picks 2–3 specialists; the same question runs in parallel lanes.
- Ranks / Profiles = leaderboard per task type.
- `learned_routes` (migration 036) = reinforcement on district→district
  transitions, nightly cron, fed back as an advisory route hint in the prompt.

**Verdict: the instrumentation is right. The thing being measured is not yet.**

What is good, and rare:

- Everything is derived from rows the pipeline already writes. The map cannot
  lie about a run because it has no data of its own.
- One taxonomy for replay, live and stats. A scored leg, a replayed leg and a
  live leg resolve to the same building.
- Identity comes from `personas.js`, so names and roles cannot drift from the
  prompts (the file notes they once did).
- A race refuses to run with fewer than two capability-matched agents, so an
  unmatched agent cannot "win" by doing nothing.

What is wrong or unproven, in priority order:

1. **"Accuracy" is not accuracy.** In `AgentLeaderboard.js:96` and `:181`,
   accuracy = share of runs that ended `completion_reason = 'natural'`, i.e.
   the run finished without error or budget stop. It says nothing about whether
   the answer was right. That number is 60% of the leaderboard score and 50% of
   the history term in routing. So the whole feedback loop — Ranks, Profiles,
   the 30% history weight, `learned_routes` reinforcement — rewards agents and
   routes that *finish*, not ones that are *correct*. Until there is a ground
   truth signal, the learned parts of the map are learning "which agent errors
   least", which is a quota and provider-health signal, not a quality one.
   *Fix:* add a real quality signal and make it the accuracy input: a thumbs
   up/down on each answer (cheapest), citation verification (does every claimed
   URL resolve and contain the quoted fact), and for races a blind pairwise
   judgement by a different model. Keep "finished naturally" as *reliability*,
   which it already is in the blend.
2. **The task classifier under all of it is six regexes** (`TASK_MATCHERS`,
   `AgentLeaderboard.js:131-138`). "what is" → research; any question
   mentioning a price → markets, first match wins. Route yield, profiles and
   learned routes are all bucketed by this label. The capability score is
   likewise `goal.includes(keyword)`. The positions and paths on the map are
   downstream of these two string matches, so they are only as meaningful as
   the matches. *Fix:* classify with pgvector similarity against a labelled
   set (you already have embeddings) or a 4-token LLM label (you already have
   an `extraction` route for that), log the label on the execution, keep the
   regex as offline fallback. Then re-bucket history.
3. **Nobody has measured whether a learned route changes anything.** The route
   hint is an advisory system message. The honest experiment is cheap: for one
   task type, run with and without the hint for two weeks and compare verified
   rate and tokens. If the hint does not move the numbers, `learned_routes` is
   a cache of a function with no effect, and the map should show it as a
   history, not a recommendation.
4. **District mapping has gaps that misplace agents.** `toolDistricts.js` maps
   `jobs`, `resume`, `applications` to **Portfolio**, so a careers agent lives in
   the investment district; `analytics`, `alerts`, `youtube`, `system_status`,
   `diagnostics` have no district and fall into the generic "Tools" lot. An
   agent's home is the district where most of its non-generic tools land, so
   Atlas (portfolio steward) is likely placed by his five market-data tools
   rather than by Portfolio. Add `careers` and `risk` districts and map the
   missing tools; it is a ten-line change and the map becomes truthful.
5. **Demo numbers look like real ones.** The 92/68/54/41% in the demo panel
   are hard-coded `DEMO_ROUTING`. Fine for signed-out visitors, but the live
   panel shows a blended score that is not a probability either. Label it
   "match" not "%", or show the two components (capability, history) separately.
6. **Product.** The August audit recommended collapsing five visualisations
   into two and making Agent Map a tab of Operations. That has not happened.
   The map is the most shareable thing you have; it is still not the thing a
   new user needs first.

**So: right track on architecture, wrong target on learning.** Fix the quality
signal (1) and the classifier (2) before adding another rung to the learning
ladder; otherwise each rung learns the same non-signal more confidently.

---

## 6. Priorities, if you do nothing else

1. Commit the session-expiry fix.
2. P0-2 trust boundary on tool output (half a day). Nothing that moves money
   or sends anything should be connected before this.
3. Measure `fetch` and `crawl` failure classes for the last 30 days. If still
   >50% failing, every research answer is built on snippets.
4. Replace "accuracy" with a real quality signal; replace the regex classifier.
   The Agent Map's learning rests on these two.
5. Paper trading + IPO tool + Indian news feeds for Aurelius/Atlas.
6. Sprint AC Phases 1–3 for Rasha (the extension).
7. Move the disclaimer to the UI and strip the hedging from the prompts.

A read-only script that answers (3) and the routing-share question is at
`C:\Users\Asus\AppData\Local\Temp\claude\f5d06956d87adc52\1b5426ef-dba8-4774-860c-972f5cfa45c6\scratchpad\stats.js`
(SELECTs only). Run it with `node` from the backend folder if you want the
numbers; the session's permission policy would not let me run it because it
reads `.env`.
