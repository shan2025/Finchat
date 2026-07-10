# FinChat Cognitive Core — Sprint 1 Build Plan

**Build plan v1** — supersedes the original Implementation Plan doc + the two architecture review passes. This is the version to actually build from.

---

## How to Run This With Antigravity

- Save this file at the repo root or `legacy_prototype/SPRINT_1_PLAN.md` so it's inside Antigravity's project scope.
- Feed it **one phase at a time**, not all eleven at once: *"Read SPRINT_1_PLAN.md. Implement Phase 0 and Phase 1 only. Use Plan Mode. Stop and show me the migration files before running them against the database."*
- Use **Plan Mode** (not Fast Mode) for every phase here — this is exactly the "complex, multi-step task" case it's meant for, and you want the Plan Artifact to review before code gets written.
- For **Phases 0–2** (schema, budgets, state machine), stay in Agent-assisted or Review-driven mode — a bad migration or a wrong lifecycle transition is expensive to unwind. From **Phase 3 onward**, Autopilot is reasonable; mistakes there are cheaper to catch and redo.
- Each phase below ends in a **Definition of Done**. Literally hand that line to Antigravity as what you want its verification artifact to prove before you approve moving to the next phase.

## Milestones (for your own tracking, not Antigravity's)

- **M1 — end of Phase 3:** a raw Execution can run one full think → respond cycle and log it to Postgres. No tools, no memory yet.
- **M2 — end of Phase 7:** full cognitive loop end to end — tools, planning, memory, async reflection.
- **M3 — end of Phase 9:** real chat traffic flows through Cognitive Core instead of the old `aiChat.js` path.

---

## Decisions Locked for This Build

These resolve everything left open across both review passes. If you disagree with any of these, say so before Phase 1 — they're the ones that shape the schema.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Task vs. Execution | Drop `tasks` and `subtasks`. Add one slim `goals` table as the durable anchor. | `parent_execution_id` already covers delegation lineage. `goals` covers retry lineage and recurring schedules, which delegation alone can't represent. |
| 2 | Execution budget | Budget + usage columns live directly on `executions`. A breach forces one restricted "respond now" turn — never a silent hard failure. | A 3B model won't reliably self-limit. The OS has to own the ceiling, not the model. |
| 3 | State vs. phase | `current_state` = lifecycle only (`created/ready/running/waiting/completed/failed/cancelled`). Cognitive phases (thinking/planning/using_tool/reflecting) are logged per-row in `execution_logs.phase`, not in `current_state`. | Replaces three conflicting versions with one. Phases become timing data for free. |
| 4 | "Waiting" reason | Nullable `wait_reason` enum: `tool_response` / `human_approval` / `scheduled_trigger`. Only `tool_response` actually fires in Sprint 1. | "Waiting" meant three different things. Give it a slot now so adding human-in-the-loop or scheduling later isn't a breaking change. |
| 5 | Planning trigger | No separate complexity classifier. `ReasoningEngine`'s first turn can itself emit `action: "plan"`. | A pre-classifier costs a round-trip to save a round-trip. The same call that already runs can decide. |
| 6 | Reflection timing | Fires unawaited, right after the response is sent. Best-effort only — no redelivery queue this sprint. | Users shouldn't pay LLM latency for internal learnings they never see. |
| 7 | Capabilities | Add `capabilities JSONB` to `agent_configs` now. Routing stays simple if/else in `PlatoOrchestrator`. | Cheap to add to the schema. A resolver service solves a routing problem four agents (three of them stubs) don't have yet. |
| 8 | Agent registry | `agent_configs` **is** the registry for Sprint 1. No standalone service. | Same logic as capabilities — defer until enough real agents exist to make hardcoding actually painful. |
| 9 | Embedding model | `nomic-embed-text`, 768 dimensions, set in `config/embeddings.js`. `knowledge_embeddings.embedding` reads its width from there, not a hardcoded 1536. | You're already all-in on local Ollama; this keeps embeddings local too. One-line change in one file if you want something else later. |
| 10 | Migrations | `node-pg-migrate` from Phase 0. No raw `CREATE TABLE IF NOT EXISTS`. | 20+ tables. You'll be altering columns across them by Sprint 2 regardless. |
| 11 | JSON enforcement | Ollama's `format: "json"` param + one corrective retry + raw-text fallback. | Prompt wording alone isn't reliable enough on a 3B model to skip belt-and-suspenders. |

## Explicitly Deferred (not in this sprint — don't build these yet)

- Standalone Capability Resolver service — schema column only for now.
- Agent Registry as installable, versioned modules.
- Splitting the reasoning loop into six separate Perception/Reasoning/Decision/Action/Observation/Memory files — do it as phase-level timing/logging inside the existing services instead. Revisit as real files only if that logging genuinely can't keep up.
- Redis Pub/Sub EventBus — in-memory `EventEmitter` stays until Sprint 4, as originally scoped.
- Workers/queues.
- `human_approval` / `scheduled_trigger` wait states — the column exists; no code path fires them yet.
- **Sentinel vs. Finance naming** — still genuinely unresolved from the AADS doc. Sprint 1 builds `FinanceAgent.js` per the original file tree either way; reconcile whether Sentinel is a separate governance layer (most likely, given it reads as oversight rather than a domain-task agent) or folds into Finance when Sprint 3 agents get built for real.

---

## Phase 0 — Tooling & Config

**Goal:** repo is ready for schema work. Nothing agent-related yet.

**Files:**
- `legacy_prototype/backend/package.json` — modify
- `legacy_prototype/backend/migrations/` — new
- `legacy_prototype/backend/config/embeddings.js` — new
- `legacy_prototype/docker-compose.yml` — verify only, already spec'd

```js
// config/embeddings.js
module.exports = {
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimension: 768
};
```

**Tasks:**
- [ ] Add `pg`, `redis`, `node-pg-migrate` to `package.json`; remove `better-sqlite3`
- [ ] Initialize `node-pg-migrate`, pointed at `DATABASE_URL`
- [ ] Add `config/embeddings.js` as above
- [ ] Confirm `docker-compose.yml` matches the already-drafted spec (`pgvector/pgvector:pg15`, `redis:7-alpine`, env vars)

**Definition of Done:** `docker compose up -d` brings up Postgres + Redis cleanly. `npx node-pg-migrate up` runs against an empty database with zero migrations and exits 0.

---

## Phase 1 — Schema

**Goal:** every table Cognitive Core needs, as migrations. No `tasks`, no `subtasks`.

Carry over **unchanged**: `users`, `sessions`, `agents`, `tool_permissions`, `tool_calls`, `tool_results`, `memories`, `knowledge`, `reflections`, `channels`, `messages`, `proof_chain`, `fraud_logs`, `token_ledger`, `files`, `ai_conversations`, `zkp_proofs`, `documents`, `workflows`, `automations`, `notifications`, `audit_logs` — as originally specified.

**New:**

```sql
CREATE TABLE goals (
  goal_id       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | completed | cancelled
  recurrence    JSONB,                              -- null for one-shot; {"cron": "...", "until": "..."} for recurring
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Modified — `executions`** (fields in original doc unchanged unless shown here):

```sql
CREATE TABLE executions (
  execution_id         TEXT PRIMARY KEY,
  goal_id              TEXT REFERENCES goals(goal_id),          -- NEW: retry/recurrence anchor
  user_id              TEXT NOT NULL,
  conversation_id      TEXT,
  goal                 TEXT NOT NULL,
  current_plan         JSONB,
  assigned_agent       TEXT,
  current_state        TEXT NOT NULL DEFAULT 'created',          -- created|ready|running|waiting|completed|failed|cancelled
  wait_reason          TEXT,                                      -- NEW: tool_response|human_approval|scheduled_trigger, nullable
  working_memory_key   TEXT,
  tool_history         JSONB,
  reflection           TEXT,
  result               TEXT,
  metrics              JSONB,                                     -- free-form telemetry (cost, per-tool breakdowns) — distinct from the hot-path counters below
  parent_execution_id  TEXT REFERENCES executions(execution_id),   -- delegation only. NOT retry lineage — that's goal_id.
  max_iterations       INT NOT NULL DEFAULT 8,                      -- NEW: budget
  max_tool_calls       INT NOT NULL DEFAULT 5,                      -- NEW: budget
  max_tokens           INT NOT NULL DEFAULT 5000,                    -- NEW: budget
  max_runtime_seconds  INT NOT NULL DEFAULT 60,                       -- NEW: budget — loosened from the 30s first floated; time a real multi-tool run in Phase 3 and adjust
  iterations_used      INT NOT NULL DEFAULT 0,                        -- NEW: usage counter, checked every loop
  tool_calls_used       INT NOT NULL DEFAULT 0,                        -- NEW
  tokens_used            INT NOT NULL DEFAULT 0,                        -- NEW
  completion_reason      TEXT,                                           -- NEW: natural|budget_exceeded|error|cancelled
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Modified — `execution_logs`:**

```sql
CREATE TABLE execution_logs (
  log_id        BIGSERIAL PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES executions(execution_id),
  phase         TEXT NOT NULL,        -- thinking|planning|using_tool|reflecting
  step_number   INT NOT NULL,
  content       JSONB,                 -- thought / tool input / tool output, etc.
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Modified — `agent_configs`:**

```sql
ALTER TABLE agent_configs ADD COLUMN capabilities JSONB DEFAULT '[]'::jsonb;
-- e.g. ["web_search", "summarization", "financial_analysis"]
```

**Modified — `knowledge_embeddings`:**

```sql
CREATE TABLE knowledge_embeddings (
  embedding_id  TEXT PRIMARY KEY,
  knowledge_id  TEXT NOT NULL REFERENCES knowledge(knowledge_id),
  embedding     VECTOR(768),   -- must match config/embeddings.js — regenerate this migration if that ever changes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Tasks:**
- [ ] Migrate all carried-over tables from the original doc
- [ ] Add `goals`
- [ ] Modify `executions`, `execution_logs`, `agent_configs`, `knowledge_embeddings` as above
- [ ] Do **not** create `tasks` or `subtasks`
- [ ] Seed one fresh admin + one test user (fresh start, no SQLite migration, as originally decided)

**Definition of Done:** migrations run clean top to bottom on an empty database. `\dt` shows the full table list minus `tasks`/`subtasks`. A manual insert into `executions` with only required fields succeeds and shows budget defaults (8 / 5 / 5000 / 60) populated automatically.

---

## Phase 2 — Redis Client, StateMachine, ExecutionManager

**Goal:** the substrate every cognitive service sits on. No reasoning yet — just lifecycle plumbing.

**Files:** `redis.js`, `services/cognitive/StateMachine.js`, `services/cognitive/ExecutionManager.js`

**Tasks:**
- [ ] `redis.js` — singleton `getRedis()`
- [ ] `StateMachine.js` — enforces only the seven lifecycle states from Decision #3. Rejects any transition outside the allowed map. Emits `execution:state_changed`.
- [ ] `ExecutionManager.js` — `createExecution`, `updateState`, `getExecution`, `completeExecution`, `failExecution`, plus two new methods: `checkBudget(executionId)` (returns whether any ceiling is breached) and `incrementUsage(executionId, { iterations, toolCalls, tokens })`

**Definition of Done:** a script can create an Execution, push it through every legal state transition, and gets rejected on an illegal one (e.g. `completed → thinking`). `checkBudget` returns true after manually setting `iterations_used` past `max_iterations`.

---

## Phase 3 — ContextBuilder + ReasoningEngine

**Goal:** first real end-to-end think cycle. No tools, no memory yet — a stubbed one-shot exchange is enough to prove the loop.

**Files:** `services/cognitive/ContextBuilder.js`, `services/cognitive/ReasoningEngine.js`

**The unified action schema** (replaces the old two-shape version — same idea, one discriminator key):

```json
{ "thought": "string", "action": "plan" }
{ "thought": "string", "action": "tool", "tool": "string", "input": "string" }
{ "thought": "string", "action": "respond", "response": "string" }
```

**Tasks:**
- [ ] `ContextBuilder` — agent system prompt + conversation history now; memory/tool-result sections wired properly in Phases 4 and 6, empty for now
- [ ] `ReasoningEngine` — call Ollama with `format: "json"`; parse against the schema above; on parse failure, one corrective re-prompt ("respond again with only JSON matching the schema"); if that also fails, treat the raw text as `response` and set `completion_reason: 'error'`
- [ ] Wire `ExecutionManager.checkBudget()` before every `ReasoningEngine` call. On breach, call `ReasoningEngine` with **only** the `respond` shape available in its schema, and set `completion_reason: 'budget_exceeded'`

**Definition of Done:** a trivial goal ("say hello") runs `created → running(thinking) → completed` with no tool involved. `execution_logs` has a `thinking` row with `duration_ms` populated. Manually forcing `iterations_used` above `max_iterations` before the call produces a forced response and `completion_reason = 'budget_exceeded'`.

**→ M1 lands here.**

---

## Phase 4 — ToolRegistry + ToolManager + Tools

**Goal:** the loop can actually do something.

**Files:** `services/cognitive/ToolRegistry.js`, `services/cognitive/ToolManager.js`, `tools/SearchTool.js`, `tools/StockTool.js`

**Tasks:**
- [ ] `ToolRegistry` — static metadata for `search` and `stocks` (name/description/inputSchema/outputSchema), no execution logic
- [ ] `ToolManager` — permission check (against `agent_configs`) → cache check (Redis, per-tool TTL) → rate limit (Redis sliding window) → execute (via registry) → normalize → log to `tool_calls` / `tool_results`
- [ ] `SearchTool.js`, `StockTool.js` — concrete implementations
- [ ] Wire the `tool` action shape from Phase 3 into `ToolManager.execute`, looping back to `thinking`

**Definition of Done:** a goal needing a live tool ("what's TSLA trading at") cycles `thinking → using_tool → thinking → respond → completed`. Matching rows exist in both `tool_calls` and `tool_results`. Calling the same tool input twice inside the TTL window hits cache instead of re-calling the real API.

---

## Phase 5 — PlanningEngine

**Goal:** multi-step goals get a plan. Simple ones never pay for one.

**Files:** `services/cognitive/PlanningEngine.js`

**Tasks:**
- [ ] `PlanningEngine.plan(execution)` — takes the goal, returns an ordered step list, stores it in `executions.current_plan`
- [ ] Invoked **only** when `ReasoningEngine`'s first turn returns `action: "plan"` — no separate gate or classifier in front of it

**Definition of Done:** "what's PostgreSQL" never triggers `action: "plan"`. "Research Tesla, compare to competitors, summarize" does, and `current_plan` is populated before the first tool call fires.

---

## Phase 6 — MemoryService

**Goal:** unified retrieve/store API. Embeddings wired to config, not hardcoded.

**Files:** `services/cognitive/MemoryService.js`

**Tasks:**
- [ ] Working memory — Redis hash per execution, `EXPIRE 86400`
- [ ] Episodic / semantic / procedural — `memories` table, typed
- [ ] `store()` / `retrieve()` read `config/embeddings.js` for model + dimension rather than assuming any fixed number
- [ ] `ContextBuilder` (Phase 3) now actually pulls relevant memories instead of leaving that section empty

**Definition of Done:** two turns in the same conversation share working memory — the second turn's context includes the first turn's scratchpad. A stored `semantic` memory is retrievable via an embedding matching the dimension in config.

---

## Phase 7 — ReflectionEngine + EventBus

**Goal:** async, best-effort learning. Every phase change is auditable via events.

**Files:** `services/cognitive/ReflectionEngine.js`, `services/cognitive/EventBus.js`

**Tasks:**
- [ ] `EventBus` — in-memory `EventEmitter`. Events: `execution:created`, `execution:state_changed`, `execution:completed`, `execution:failed`, `execution:delegated` (renamed from `task:delegated` — no more Task concept), `tool:invoked`, `tool:completed`, `memory:stored`, `reflection:completed`
- [ ] `ReflectionEngine.reflect(execution)` — summarizes goal + result, extracts learnings, stores in `reflections`
- [ ] Call `reflect()` unawaited, immediately **after** `completeExecution()` sends its result — never before

**Definition of Done:** timestamps prove the user-visible response returns before `reflections` gets a row for that execution. Confirmed and documented (not just silently true): killing the process right after the response is sent is an acceptable, known way to lose that reflection in Sprint 1.

**→ M2 lands here.**

---

## Phase 8 — Thin Agents

**Goal:** `BaseAgent` has zero cognitive logic. `PlatoOrchestrator` routes on capabilities, not hardcoded names.

**Files:** `services/agents/BaseAgent.js`, `services/agents/PlatoOrchestrator.js`, stub files for Research/Career/Finance agents

**Tasks:**
- [ ] `BaseAgent` — holds config, calls `CognitiveCore.run(execution)`, returns the result. Nothing else.
- [ ] `PlatoOrchestrator` — reads `capabilities` from `agent_configs`, matches the goal against them with simple keyword/if-else logic, delegates via `EventBus`, aggregates child results
- [ ] Stub the other three agents, each with a `capabilities` array and a placeholder response, per the original Sprint 3 scoping

**Definition of Done:** "review my resume" routes to the Career stub because its capability list matches, not because of a hardcoded agent-name check. An unmatched goal falls back to Plato responding directly instead of erroring.

---

## Phase 9 — Wire Into Real Traffic

**Goal:** replace the `aiChat.js` direct path for real.

**Files:** `services/aiChat.js` (modify), the relevant chat route

**Tasks:**
- [ ] The existing chat route creates an Execution and calls `CognitiveCore.run()` instead of calling the LLM directly
- [ ] Old direct path is removed or clearly dead-coded — not left running in parallel silently

**Definition of Done:** a message sent through the existing chat UI produces real rows in `executions` and `execution_logs`. Docker logs show state transitions for an actual user message, not just test scripts.

**→ M3 lands here.**

---

## Phase 10 — Verification

Same two automated tests as originally scoped, extended for what's new. Same manual checklist.

**Files:** `test_pg_redis.js`, `test_cognitive_core.js`

**Tasks:**
- [ ] `test_pg_redis.js` — PG pool connects, all tables exist (including `goals`, excluding `tasks`/`subtasks`), Redis SET/GET works, pgvector extension installed, `knowledge_embeddings` column width matches `config/embeddings.js`
- [ ] `test_cognitive_core.js` — original assertions (state cycling, working memory flush, tool logging, reflection stored, EventBus fires all expected events) **plus**: a forced budget breach produces `completion_reason = 'budget_exceeded'`; a retried goal shows two `executions` rows sharing one `goal_id`
- [ ] Manual — send a prompt through the chat UI, confirm it routes through Cognitive Core; check Docker logs for state transitions

**Definition of Done:** both test files pass. Manual checklist confirmed once, by hand.
