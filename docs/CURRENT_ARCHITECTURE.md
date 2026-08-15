# FinChat — Current Architecture (what actually runs)

**Status:** DESCRIPTIVE — this document records what is in the repository and running in
production as of **2026-08-13**. If the code and this document disagree, the code is
right and this document is a bug.

For where the system is *going*, see `system_architecture_document.md` — but read the
banner at the top of it first: it is a target/aspirational design, not a description.

---

## 1. Where the code lives

```
finchat/
  legacy_prototype/backend/    ← THE PRODUCTION BACKEND (misleading folder name)
  legacy_prototype/frontend/   ← THE PRODUCTION FRONTEND
  docs/                        ← this folder
  _ARCHIVED_api/               ← abandoned FastAPI attempt. Not built, not deployed.
  _ARCHIVED_backend_unused/    ← superseded copy of the backend. Dead.
```

`legacy_prototype` is a misnomer — it is the live system. Two archived trees still
contain near-identical copies of `proof.js`, `zkp.js`, `aiChat.js` and others; when
searching the repo, confirm which tree a file belongs to before editing it.

## 2. Stack, as built

| Layer | Actual |
|---|---|
| API | Node 18 + Express 4, single process (`server.js`) |
| Edge | `helmet` (CSP, HSTS, frame-deny), `cors` allowlist, `express-rate-limit`, `compression` |
| Realtime | Socket.io, JWT-authenticated, events routed per-user (`services/realtime.js`) |
| Database | PostgreSQL on Supabase via `pg` Pool (`DATABASE_URL`, session pooler) |
| Migrations | `node-pg-migrate`, 28 applied (`…001` → `…028_entities-per-user`) |
| Cache / queue | Redis + BullMQ (`services/queue/WorkerPool.js`) |
| Vectors | pgvector, `config/embeddings.js` (nomic-embed-text, 768-dim) |
| Inference | Groq-primary, via `services/inference.js` |
| Crypto | snarkjs + circom (Groth16); SHA-256 hash chain; Solana devnet; IPFS via Pinata |
| Notifications | Nodemailer (Gmail SMTP), Telegram polling, web-push (VAPID) |
| Frontend | Static HTML + vanilla JS, no framework, no build step |
| Hosting | Render (Docker), `finchat-6.onrender.com` |

**Not used, despite what older docs claim:** FastAPI, Qdrant, React, Kubernetes, MongoDB.

## 3. Request path

```
Browser (static HTML/JS)
   └─ Express (server.js) ── 18 route modules under /api/*
        └─ services/          domain logic
             └─ services/cognitive/   the agent runtime
                  └─ ToolManager.executeTool()   ← the single execution boundary
                       └─ tools/*.js (23 tools)
        └─ database.js  → pg Pool → Supabase Postgres
```

Routes are thin. Agent behaviour lives in `services/cognitive` and `services/agents`,
not in route handlers.

### Realtime delivery

`services/realtime.js` owns the EventBus → Socket.io map. Every socket joins
`user:<userId>` from its JWT-verified identity on connect, and each event is
addressed to that room. **An event carrying no `userId`/`user_id` is dropped,
not broadcast** — if a new pulse never reaches the UI, add the owner at the
emit site rather than widening delivery. `test/realtime.test.js` holds the
regression test, including a live two-client isolation check.

## 4. The cognitive layer (18 modules)

`CognitiveCore.run()` is the agent loop. Around it:

- `ExecutionManager` — create/update/complete executions, budget + usage accounting
- `StateMachine` — legal transitions, HITL wait states, `IllegalTransitionError`
- `ContextBuilder` — prompt assembly, trait directives
- `PlanningEngine` / `ReasoningEngine` — decomposition, `parseActionResponse`
- `ToolManager` / `ToolRegistry` — permissions, rate limits, approval gate, call logging
- `MemoryService` / `MemoryEngine` — working/episodic/semantic memory, embeddings, `dream()`
- `EntityGraph` + `Communities` — Graph-RAG over past executions
- `SkillRecipes` — reuse of learned procedures
- `ReflectionEngine`, `DreamDigest` — post-hoc evaluation and nightly consolidation
- `ReportEngine`, `MindMapEngine` — Sprint Y / Z output surfaces
- `EventBus` — cross-cutting pub/sub

## 5. Agents and tools

**Agents (8):** `PlatoOrchestrator` (router), `BaseAgent`, `AgentRegistry` (DB-backed via
`agent_configs`), `MemoryAgent`, `SentinelAgent` (fraud/governance), `DebateOrchestrator`,
`GroupChatOrchestrator`, `MissionScheduler`.

**Tools (23),** uniform `execute()` contract: Search, News, Paper, Fetch, Crawl,
Wikipedia, Reddit, Quora, Stock, Crypto, Forex, Commodities, Jobs, Resume, Watchlist,
Notifications, NeuralMap, ApplyDraft, FileRead/Write/Edit, Glob, Bash.

> `Bash`, `FileWrite` and `FileEdit` run against the real host with no sandbox. See
> `SECURITY_FOUNDATION_GAP_ANALYSIS.md` item P0-1.

## 6. Trust / audit subsystem

Message content is SHA-256 hash-chained (`services/proof.js`); checkpoints are pinned to
IPFS (Pinata) and anchored on Solana devnet. `SentinelAgent` + `services/fraud.js` do LLM
fraud classification with a regex fallback, penalties and account freeze. ZKP unblock
proofs (Groth16) let a frozen account be unblocked without disclosing the reason.
Documented split: fast path ~15 ms user-visible, audit path ~1.8 s async.

This is an **audit-evidence layer**. It is not on the authorization path — permissions are
enforced in `ToolManager`, not on-chain.

## 7. Frontend

17 static pages sharing one design layer, `finchat_theme.css` (added 2026-08-13). All
pages resolve identical `--bg` / `--accent` / `--chrome` / `--text` and body font; colours
are authored as RGB channels so Tailwind opacity modifiers work. Shared behaviour lives
in `sidebar_nav.js`, `sidebar_collapse.js`, `knowledge_search.js`, `notifications_widget.js`,
`missions_widget.js`, `system_panels.js`, `study_blocks.js`, `nn_core.js`, `sw.js`.

`finchat_chat.html` deliberately keeps its own inline sidebar (it wires Recents to the
live conversation) — do not add `sidebar_nav.js` to it.

## 8. Background work

Started inside `server.listen`: Solana init → `sweepStaleExecutions` → BullMQ
`startWorkerPool` → `syncMissionSchedules` → `dream()` → `runNightlyDigest`.

Scheduled delivery is driven by an **external cron** hitting `/api/cron/tick` with
`CRON_SECRET`, because Render free-tier spin-down kills in-process schedulers.

## 9. Known structural weaknesses

1. **Data-access layer (migration in progress).** `query()` has ~191 graph edges; most
   services still issue raw SQL. Two boundaries exist so far:

   - `repositories/ExecutionRepository.js` — all `executions` SQL, including
     `findCompletedEpisodes` for episodic recall. `ExecutionManager` now holds lifecycle
     policy only and is unit-testable without a database.
   - `repositories/MemoryRepository.js` — all `memories`, `knowledge` and
     `knowledge_embeddings` SQL. `MemoryService` no longer references `query()` or
     `database` at all.

   **Ownership rule: a repository owns a table, and the repository that owns the table
   owns the query** — episodic recall reads `executions`, so it lives in
   `ExecutionRepository` even though only `MemoryService` calls it.

   Pattern to follow for the next one:

   - repository owns the SQL and returns `null` for "absent"; the caller decides whether
     that is an error
   - the service keeps its flat exports (bound to a default instance) so call sites do
     not change, and additionally exports a `createXManager({ repository })` factory
   - pure policy (e.g. `evaluateBudget`) is extracted as a plain function and tested directly
   - the `query` dependency is resolved lazily inside the call, never at module load, so
     importing a repository in a test never opens a pool

   Next candidates by coupling: `AgentRegistry`, `ToolManager`, `MemoryEngine`
   (31 `query()` calls — the largest single remaining consumer), `proof.js`.
2. **Duplicated code.** Two dead trees shadow the live one: `_ARCHIVED_backend_unused/`
   (65 files, tracked in git — safe to delete) and `_ARCHIVED_api/` (5,725 files, almost
   entirely untracked — deleting it would be unrecoverable, so check before removing).
   `finchat/backend/` no longer exists; it was renamed to `_ARCHIVED_backend_unused`.
3. **Test coverage is thin, but no longer absent.** `npm test` now runs Node's built-in
   runner (`node --test test/`) over `backend/test/`:
   182 assertions covering the LLM-output parser (`ReasoningEngine.parseActionResponse`),
   the execution `StateMachine` transition matrix, the proof-chain hash contract,
   `ExecutionManager` lifecycle/budget policy, and the `executions` / `memories` /
   `knowledge` SQL contracts — including every filter combination of the
   dynamically-built `WHERE` clauses, where a mis-numbered placeholder returns wrong
   rows rather than raising.
   The remaining ~35 `scripts/test_*.js` and 16 loose root scripts are still hand-run
   integration checks against live Supabase/Groq, and nothing runs in CI yet.
4. **Unsandboxed shell/file tools.** See the security gap analysis.
