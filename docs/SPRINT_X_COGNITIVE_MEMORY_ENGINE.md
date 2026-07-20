# Sprint X — Cognitive Memory Engine

> The Neural Map stops being a visualization and becomes the operating system of the AI.
> FinChat's differentiator: **persistent intelligence** — an AI that builds, evolves,
> reasons over, and explains its own knowledge.

This sprint replaces the old Sprint 9/10/11 numbering. Work is split into two tracks:

- **Track A (70%) — Cognitive Memory Engine**: the living knowledge graph (this doc).
- **Track B (30%) — AI Operations Center**: evolving the Neural Network page into a
  model registry / training / monitoring hub. Sequenced *after* Track A Stage 2,
  because it needs the memory data to be interesting.

Everything else (Governance, Model Lab, Blockchain expansion, Next.js migration) is
paused until the engine is the product's spine.

---

## Stage 1 — SHIPPED ✅ (migration 019)

A full vertical slice: every chat now teaches the graph, nodes are alive, and the
map shows the AI thinking.

### What exists now

**Schema (`1720000000019_cognitive-memory-engine.js`)**
| Piece | What it adds |
|---|---|
| `entities` (upgraded) | summary, importance (0-10), confidence (0-1), activation_count, last_activated_at, owner_agent, merge status |
| `entity_edges` (upgraded) | strength (decays), confidence, **reason** ("why this link exists"), source, agent_id, activation stats |
| `node_events` (new) | append-only per-node timeline — created / mentioned / activated / merged. Git for knowledge. |
| `entity_links` (new) | provenance — which chat sessions / agents / documents a node was learned from |
| `graph_insights` (new) | machine-found gaps, contradictions, duplicates, dream reports |

**The pipeline (`services/cognitive/MemoryEngine.js`)**
```
Chat exchange
  ↓ LLM extraction (entities + summaries + importance + confidence)
  ↓ Relationship detection (typed edges: uses / part_of / prefers / causes… each with a reason)
  ↓ Duplicate detection (case-insensitive canonical + alias match → grow, don't fork)
  ↓ Contradiction detection (→ graph_insights for the user to resolve)
  ↓ Merge into graph + timeline events + provenance links
```
Wired fire-and-forget into `POST /api/ai-chat/send` — memory can never break chat.

**Activation loop** — when ContextBuilder retrieves graph context for an answer,
those nodes are *activated* (count + timestamp + timeline event + socket.io
`graph_pulse`). This is the raw data for the heatmap and thinking visualization.

**Dream mode** — `MemoryEngine.dream()`: merges duplicate nodes (survivor absorbs
mentions/summary/aliases), decays edges unused for 14+ days (never below 0.05 —
memories dim, don't vanish), reinforces edges used in the last day, hunts knowledge
gaps, and files a dream report. Runs every 6h in the server + on-demand.

**API (`/api/knowledge`)**
- `GET /nodes/:id` — living-node profile (vitals, reasoned connections, provenance, timeline)
- `GET /activity` — recently activated nodes (thinking feed)
- `GET /insights` · `POST /insights/:id/resolve` — gaps / contradictions
- `POST /dream` · `POST /gaps` — run consolidation / gap-hunt now
- `GET /stats` — graph vitals

**Neural Map UI (`finchat_neuralmap.html`)**
- Click a learned concept → **Living Memory** panel: summary, importance/confidence
  meters, mentions/recalls/last-used, "why it's linked" (edge reasons), "learned
  from" (provenance), full timeline.
- 🔥 **Heatmap mode**: red = used today, orange = this week, green = sometimes, gray = forgotten.
- ⚡ **Activation pulses**: nodes the AI just used glow (6s polling of `/activity`).
- 💡 **Insights panel**: gaps & contradictions with accept/dismiss.
- 🌙 **Dream button**: run a consolidation cycle, see the report as a toast.

### Verified (2026-07-19)
- `scripts/test_cognitive_memory_engine.js` — **18/18 checks passed** against live
  Supabase + Groq (extraction, dedup, reasoned edges, activation, retrieval ids,
  duplicate merge, decay, gap detection, dream report).
- First dream cycle merged **14 real duplicate nodes** the old pipeline had accumulated.
- Real chat test: one message about "FinChat OS" → **6 nodes + 8 reasoned links**
  learned, visible on the map, pulsing in the activity feed.
- Gap detection on the real graph found genuinely missing concepts
  (e.g. *Smart Contracts* near Ethereum ↔ Blockchain).

---

## Stage 2 — Thinking made visible — SHIPPED ✅ (2026-07-19)

Phases 4 + 10 of the vision.

1. **Chat-side thinking strip** ✅ — while an answer generates, the typing bubble
   swaps its canned phrase for the real retrieval path via socket.io `graph_pulse`:
   *"🧠 Recalling: Transformers → PyTorch → PostgreSQL → Knowledge graph"*.
   (`recordActivation` now emits entity names, not just ids.)
2. **Explainability line** ✅ — every answer that used graph memory gets
   *"🧠 PyTorch → Transformers → Knowledge graph +1 more · 5 memories · view on map"*
   under the bubble. Powered by `memoryTrace` threaded from CognitiveCore's
   retrieval loop → `route()` → `/api/ai-chat/send` response
   (`{concepts:[{entityId,name,type,viaEdge}], memories, recipes, agent}`).
3. **Retrieval-path animation** ✅ — `/api/knowledge/activity` now groups by
   `source_id`; nodes activated by the same chat turn light their connecting
   edges with a traveling glow (`flowAt` in the map's draw loop) — the AI's
   visible train of thought.
4. **"Learn it" on gaps** ✅ — `POST /api/knowledge/insights/:id/learn` creates
   the missing concept as a real node (source `gap_fill`), wires it to the
   neighbors the gap sat between, accepts the insight. One click in the
   insights panel. Verified: "Learned Machine Learning — linked to LLM
   inference, AI engineer."

Also fixed on the way: chat page's hardcoded `SOCKET_URL`/`API_URL`
(`127.0.0.1:3000`) → same-origin, so sockets and API work on any port.

## Stage 3 — Agent Cortex + graph-native retrieval — SHIPPED ✅ (2026-07-19)

Phase 9 + deepening Phase 2.

1. **2-hop strength×confidence retrieval** ✅ — `EntityGraph.findRelatedForText()`
   replaced with a CTE walk: hop-1 score = `strength × confidence × weight`;
   hop-2 score multiplies along the second edge; nodes reachable via multiple
   paths sum their scores. Falls back gracefully for pre-engine edges (no
   `strength` column yet).
2. **Agent-ownership bias** ✅ — nodes whose `owner_agent` matches the current
   agent get a 1.5× score multiplier in both hops. Finance retrieves tickers
   and economy concepts first; Research surfaces papers and technology topics.
   `owner_agent` is already written on every `upsertLivingEntity` call (Stage 1).
3. **Per-agent cortex subgraph** ✅ — `GET /api/knowledge/cortex/:agentId` returns
   the agent's owned nodes (sorted by importance + activation) plus a
   most-connected summary. Live: Finance cortex = 2 nodes, Research cortex =
   6 nodes (RAG, LLMs, LangChain, LlamaIndex, Pinecone, Enterprise KM) after
   one ingestion.
4. **Document ingestion** ✅ — `POST /api/knowledge/ingest-document` + `MemoryEngine.ingestDocument()`:
   splits text into 1 000-char overlapping chunks (750-char step), runs each
   chunk through the same extraction pipeline as chat, writes `owner_agent` from
   the request's `agentId`. One RAG overview doc → 6 nodes + 7 reasoned links
   in a single call. Agent cortex isolation verified: finance (2 nodes) ≠
   research (6 nodes), both populated from separate ingest calls.

### Verified (2026-07-19)
- `scripts/test_stage3_agent_cortex.js` — **14/14 passed** against live Supabase + Groq
  (doc ingestion, ownership, 2-hop retrieval, agent bias, cortex query, multi-agent isolation).

## Stage 4 — Dream mode grows up

- Community detection (clusters → named neighborhoods on the map).
- Cluster summarization during dreams ("Your DeFi knowledge in one paragraph").
- Semantic (embedding-based) duplicate detection, not just name matches.
- Nightly dream digest → notifications ("While you were away: merged 3, learned 12, found 2 gaps").

## Then, in order
1. **Track B — AI Operations Center** (model registry, experiment tracking, cost
   dashboard) — now interesting because memory generates real data.
2. **Model Lab / fine-tuning** — you have memories to train on.
3. **Governance** — multiple specialized agent cortexes exist to govern.
4. **Blockchain** — anchoring memories that now actually matter.
5. **Scaling / Next.js migration** — port pages once the product is proven.

---

## Notes for future work
- `mergeDuplicates` repoints edges best-effort; a unique-constraint collision on a
  user-scoped edge can leave one loser un-merged until the next cycle (harmless,
  self-healing).
- The activity poll pauses when the tab is hidden (`document.hidden`) — intended.
- Frontend pages now use `location.origin` for the API base (was hardcoded
  `localhost:3000` in login/signup/chat/inbox) — the backend can run on any port
  (`npm run start:3100` exists for a second instance).
