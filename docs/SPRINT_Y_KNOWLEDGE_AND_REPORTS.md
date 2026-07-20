# Sprint Y — Knowledge Center & Reports

> The Cognitive Memory Engine (Sprint X) made the AI *learn*. This sprint makes that
> learning **legible**: a Knowledge Center that shows every kind of memory the system
> holds — how much, how healthy, how fast it grew, and who learned what — plus a
> Reports module that turns those live vitals into periodic, shareable narratives.

Builds directly on migration 019 (`entities`, `entity_edges`, `node_events`,
`entity_links`, `graph_insights`) and the `/api/knowledge` routes. Decision on scope
(2026-07-19): **instrument all four memory types for real**, Knowledge module first,
Reports second.

---

## 0. The memory taxonomy (what we are actually measuring)

The core honesty rule: **never render a store that doesn't exist.** Every panel shows
a truthful status — `live`, `instrumented`, or `roadmap`. Here is what each of the four
requested memory types maps to in *this* codebase.

| Type | What it is here | Backing data | v1 status |
|---|---|---|---|
| **Semantic** | Facts & concepts — the living knowledge graph | `entities` + `entity_edges` | **live** (exists) |
| **Episodic** | What happened, when — chat turns, activations, learning events over time | `node_events` (+ chat sessions) | **live** (derive, no new store) |
| **Procedural** | Learned how-to — which tools/agents solved which task types, success rates | agent executions / tool-calls → new `procedure_stats` | **instrumented** (new capture) |
| **RAG** | Retrieval over embedded chunks | new `memory_chunks` + pgvector | **instrumented** (new store) |
| **KV / inference cache** | Token & context reuse at the model layer | `inference_metrics` (new capture in `inference.js`) | **instrumented** (measured, not persisted) |

### Honesty notes per type
- **KV cache**: Groq's OpenAI-compatible API (`inference.js`) returns `prompt_tokens` /
  `completion_tokens` but **no prompt-cache hit signal**. We do NOT fake a cache-hit rate.
  What we truthfully measure: total tokens in/out, tokens per feature, context-reuse rate
  (how often the same retrieved node set is re-sent), and cost proxy. Panel is labeled
  "Inference & Context Reuse," not "KV Cache Hits."
- **RAG**: no vector store today. We add one (pgvector via Supabase / the `vector`
  extension) and route document ingestion through it *alongside* the existing graph
  extraction. Until it has content, the panel shows `roadmap` with an "enable" action.
- **Procedural**: derived from agent tool/execution logs. If those logs are thin, the
  panel shows counts truthfully rather than inventing skills.

---

## 1. Schema — migration 020

`migrations/1720000000020_knowledge-instrumentation.js`

```
inference_metrics        -- one row per runInference() call
  metric_id      bigserial pk
  provider       text            -- groq | ollama
  model          text
  feature        text            -- chat | extraction | gap | report | ...
  prompt_tokens  int
  completion_tokens int
  latency_ms     int
  agent_id       text null
  user_id        text null
  created_at     timestamptz default now()
  index (created_at), (feature), (provider)

procedure_stats          -- procedural memory: task-type → approach outcomes
  procedure_id   bigserial pk
  agent_id       text
  skill          text            -- tool name / task category
  runs           int  default 0
  successes      int  default 0
  avg_latency_ms int  default 0
  last_run_at    timestamptz
  unique (agent_id, skill)

memory_chunks            -- RAG store (requires `vector` extension)
  chunk_id       text pk
  doc_id         text
  title          text
  content        text
  embedding      vector(384)     -- or provider dim; nullable until embedded
  entity_id      text null refs entities  -- optional link back to the graph
  user_id        text null
  agent_id       text null
  created_at     timestamptz default now()
  index ivfflat (embedding) -- after extension enabled

report_snapshots         -- Reports module (section 4)
  report_id      text pk
  kind           text            -- growth | agent_learning | dream_digest | gaps | user_profile
  period_start   timestamptz
  period_end     timestamptz
  summary        text            -- LLM-written narrative
  payload        jsonb           -- the numbers behind the narrative
  created_at     timestamptz default now()
  index (kind, created_at)
```

`vector` extension is enabled via Supabase MCP (`list_extensions` → enable `vector`)
before the `memory_chunks` embedding column / index are created. Migration guards the
ivfflat index behind extension availability so it never hard-fails a fresh DB.

---

## 2. Backend — new / extended endpoints

### Instrumentation (write path)
- **`inference.js`**: wrap the return of `runInference()` to insert one
  `inference_metrics` row (best-effort, non-blocking — same pattern as MemoryEngine
  writes: metrics must never break inference). Add an optional `feature` arg so callers
  tag the purpose (`chat`, `extraction`, `gap`, `report`).
- **Procedural capture**: a tiny `recordProcedure({agentId, skill, ok, latency})` helper
  called from the agent/tool execution path; upserts `procedure_stats`.
- **RAG ingest**: extend `MemoryEngine.ingestDocument` to also embed each chunk and store
  it in `memory_chunks` (behind a `RAG_ENABLED` flag). A `retrieve(query, k)` helper does
  cosine search for the ContextBuilder to optionally use.

### Read path — extend `routes/knowledge.js`
- `GET /stats/growth?days=30` — daily counts from `node_events.created_at` (created /
  mentioned / activated) → the growth sparkline & "how fast is it growing."
- `GET /agents/overview` — loop `cortex` logic across all agents in one call: per-agent
  node count, activation share, top concepts. Powers "who knows what."
- `GET /memory/overview` — the four-quadrant summary: one number + status per type
  (semantic node/edge count, episodic event count + span, procedural skill count +
  success rate, RAG chunk count / enabled flag, inference tokens last 7d).
- `GET /inference/stats?days=7` — tokens in/out by feature, latency p50/p95, context-reuse
  rate. Powers the "Inference & Context Reuse" panel.
- `GET /patterns` — top `prefers` edges scoped to `user_id` → "what the system thinks you
  care about."

---

## 3. Knowledge Center — `finchat_knowledge.html`

New page; flip `soonItem('menu_book','Knowledge')` → `navItem` in `sidebar_nav.js`.
Uses the shared `sidebar_nav.js` / `knowledge_search.js` includes. Panels top-to-bottom:

1. **Memory vitals header** — total nodes / edges / events, a 30-day growth sparkline
   (`/stats/growth`), and net-new-this-week. One glance = size + momentum.
2. **Four-quadrant memory map** — Semantic · Episodic · Procedural · RAG cards, each with
   a live count, a status chip (`live` / `instrumented` / `roadmap`), and a health color.
   This is the direct answer to "show me all kinds of memory."
3. **Inference & Context Reuse** — tokens in/out (7d), by feature, latency, reuse rate
   (`/inference/stats`). Honestly labeled — the KV/cost panel.
4. **Agent cortex comparison** — bar/heat across agents (`/agents/overview`): how much each
   agent knows, its top concepts, activation share. "How much each agent learned / of each
   other and of the system."
5. **Recently learned & thinking feed** — `/activity` + `recentlyLearned`.
6. **Health & insights** — gaps / contradictions / dream reports (`/insights`) with the
   existing accept / dismiss / learn actions. The "condition of memory" panel.
7. **Your patterns** — top user preferences (`/patterns`).

Links out to the Neural Map (`finchat_neuralmap.html`) for the spatial view and to
`/api/knowledge/nodes/:id` profiles for drill-down. Knowledge Center = the *dashboard*;
Neural Map = the *territory*.

---

## 4. Reports — `finchat_reports.html`

Reports = periodic, exportable **narratives** over the same data. Flip
`soonItem('assessment','Reports')` → `navItem`.

- **Report kinds**: Memory Growth (weekly), Agent Learning, Dream-Cycle Digest,
  Contradictions & Gaps, User-Interest Profile.
- **Generation** — `POST /api/reports/generate {kind, period}`: query the graph for the
  period, then one LLM pass (tagged `feature:'report'` so it shows in inference stats) to
  write a plain-English summary. Store in `report_snapshots`.
- **List / view** — `GET /api/reports?kind=` and `GET /api/reports/:id`; page renders
  snapshot cards + full narrative + the numbers behind it.
- **Delivery** — reuse existing notification channels (email LIVE via Gmail SMTP; Telegram
  via @Platotelebot polling): a weekly digest pushed from the dream cycle. Hook: after
  `MemoryEngine.dream()` files its report, generate + send the weekly digest.

---

## 5. Build sequence

1. **Knowledge Center (read-only)** on the *existing* `/stats`, `/activity`, `/insights`,
   `/cortex` — fastest visible win, proves the layout.
2. **Migration 020** + `/stats/growth`, `/agents/overview`, `/memory/overview`,
   `/patterns` → fill quadrants 1, 2, 4, 7.
3. **Inference instrumentation** in `inference.js` + `/inference/stats` → quadrant 3.
4. **Procedural capture** in the agent/tool path → procedural quadrant goes `live`.
5. **RAG**: enable `vector`, embed on ingest, `retrieve()` helper → RAG quadrant goes `live`.
6. **Reports**: `report_snapshots` (already in 020) + generate/list endpoints + page.
7. **Weekly digest** wired into the dream cycle + notifications.

Steps 1–2 are shippable on their own and give you the "how much / how grown / who knows
what" view immediately. 3–5 upgrade each quadrant from `instrumented` to `live` without
rework. 6–7 are the Reports layer on top.

---

## 6. Open questions to resolve during build
- Embedding provider for RAG (Groq has no embeddings endpoint) — Ollama local
  (`nomic-embed-text`) vs. a hosted embeddings API. Local keeps the "no vision/embeddings
  on the Groq key" constraint intact.
- Whether procedural stats should backfill from historical execution logs or start fresh.
- Retention on `inference_metrics` (high write volume) — likely a rollup + prune job in
  the dream cycle.
