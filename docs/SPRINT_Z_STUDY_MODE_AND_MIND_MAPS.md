# Sprint Z — Study Mode & Mind Map Studio

**Status:** Track B shipped (2026-08-09) · Track A not started
**Next migration number:** `023` — Track B took `022` (`ai_session_meta.study_mode`), so the mind-map migration moves from 022 to 023.

### Shipped in Track B (2026-08-09)

| Piece | File |
|---|---|
| Block parser + renderer, 9 types, XSS-safe, degrades on bad JSON | `frontend/study_blocks.js` |
| Card system in the warm palette + dark mirror + print stylesheet | `frontend/study_blocks.css` (self-installed by the JS) |
| Static design harness for all nine types | `frontend/study_blocks_demo.html` |
| `STUDY_MODE_DIRECTIVE` (block grammar + worked example + hard rules) | `backend/services/personas.js` |
| `studyMode` threaded route → service → orchestrator → agent → core → context | `routes/aiChat.js`, `services/aiChat.js`, `PlatoOrchestrator.js`, `BaseAgent.js`, `CognitiveCore.js`, `ContextBuilder.js` |
| Per-session persistence + restore on reopen | migration `022`, `GET /history` returns `studyMode` |
| Composer STUDY toggle, card rendering in both bubble renderers, Save-to-Knowledge + Export actions, prose-not-JSON copy | `frontend/finchat_chat.html` |
| Reports inherit the renderer | `frontend/finchat_reports.html` |
| 38 offline assertions (parser, degradation, injection, directive plumbing) | `backend/scripts/test_study_blocks.js` |

Deviation from the plan below: the plan claimed the reports page rendered markdown — it did not, it escaped `summary` as plaintext. B3 therefore also added `marked`/`DOMPurify` there.

---

**Original status:** proposed (2026-08-07)
**Supersedes as active roadmap:** `SPRINT_X_COGNITIVE_MEMORY_ENGINE.md` (Stages 1–4 done), `SPRINT_Y_KNOWLEDGE_AND_REPORTS.md` (done)

---

## Part 1 — Where we actually are

Audited against the repo on 2026-08-07 (branch `main`, HEAD `f151e99`), not against past reports.

### Shipped and real

| Layer | What exists | Evidence |
|---|---|---|
| **Cognitive loop** | Perceive→Plan→Reason→Act→Reflect with state machine, execution manager, budget guards | `services/cognitive/CognitiveCore.js` (22KB), `StateMachine.js`, `ExecutionManager.js` |
| **Memory (5 stores)** | Working (Redis), Episodic (executions/memories), Procedural (skill_recipes), Semantic+RAG (knowledge_embeddings), Graph (entities/entity_edges) | `MemoryService.js`, `EntityGraph.js`, `SkillRecipes.js` |
| **Cognitive Memory Engine** | Every chat exchange ingested → typed relations, dedup, contradiction detection, decay, dreaming every 6h, community detection | `MemoryEngine.js` (26KB), `Communities.js`, `DreamDigest.js`, migrations 019/021 |
| **Agents** | plato, aurelius, rasha, nova, sentinel, memory — each with scoped tools, per-agent model + risk temperature | `services/agents/*`, `personas.js` |
| **Multi-agent** | Debate orchestrator, group chat with @mention routing + task assignment | `DebateOrchestrator.js`, `GroupChatOrchestrator.js` |
| **Autonomy** | Scheduled missions (BullMQ job schedulers), watchlists, approval gate for sensitive tools | `MissionScheduler.js`, `routes/missions.js` |
| **Tools (22)** | search, news, paper, fetch, crawl, wikipedia, reddit, quora, stocks, crypto, commodities, jobs, resume, watchlist, apply_draft, notifications, neural_map, bash, file_read/write/edit, glob | `backend/tools/` |
| **Governance** | SHA-256 proof-of-conversation chain, Solana devnet anchoring, ZKP, Sentinel pre-checks, audit log | `proof.js`, `solana.js`, `zkp.js`, `SentinelAgent.js` |
| **Knowledge surfaces** | Neural Map (system graph, living memory, heatmap, activation pulses, dreaming), Neural Network lab, Knowledge Center, Reports engine | `finchat_neuralmap.html` (100KB), `finchat_knowledge.html`, `ReportEngine.js` |
| **Delivery** | Email (live), Telegram (live, polling), Web Push, in-app notifications | `notificationChannels.js` |
| **Tests** | 31 test scripts under `backend/scripts/` | verified by listing, not by a fresh run |

### Honest gaps

- **No mind map.** The Neural Map is a *force-directed system graph* — it shows the machine's state. It has no radial hierarchy, no collapse/expand, no AI generation from a topic or document, and nothing built for studying or planning. `NeuralMapTool.js` is read-only by design.
- **Chat output is plain markdown.** `marked.parse()` + DOMPurify at `finchat_chat.html:1369`. Personas are tuned for *analyst prose* ("Why it matters" blocks, numbered citations) — excellent for briefings, wrong for learning. There is no visual scaffolding: no cards, no diagrams, no comparison boxes, no recall checks.
- **Uncommitted working tree.** `database.js`, `ToolManager.js`, `ToolRegistry.js` modified; `NeuralMapTool.js`, `NotificationsTool.js` untracked. Commit before starting Sprint Z.
- **Infra caveat (from prior session):** Supabase is paused on egress quota; local PG17 fallback maps vector columns to `jsonb`, so RAG similarity is degraded locally. Verify before trusting any embedding-dependent result.

---

## Part 2 — Competitive position

| | **FinChat** | **NotebookLM** | **ChatGPT / Claude** | **Perplexity** | **Napkin / MyMap / Xmind AI** | **Obsidian + plugins** |
|---|---|---|---|---|---|---|
| Persistent knowledge graph across all conversations | ✅ auto, typed, decaying, self-merging | ❌ per-notebook only | ⚠️ flat memory notes | ❌ | ❌ | ⚠️ manual links |
| AI mind map from sources | ❌ **gap** | ✅ core feature | ❌ | ❌ | ✅ core feature | ⚠️ plugin |
| Click node → localized AI answer | ❌ **gap** | ✅ | ❌ | ❌ | ⚠️ partial | ❌ |
| Visual, study-formatted answers | ❌ **gap** | ❌ plain text | ❌ plain text | ⚠️ light cards | ✅ (but no chat) | ❌ |
| Multiple specialist agents | ✅ 6 | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| Autonomous scheduled missions | ✅ | ❌ | ⚠️ tasks | ❌ | ❌ | ❌ |
| Live financial/job/paper tools | ✅ 22 | ❌ | ⚠️ | ✅ web only | ❌ | ❌ |
| Cryptographic audit trail | ✅ chain + Solana | ❌ | ❌ | ❌ | ❌ | ❌ |
| Memory that *dreams* (consolidates, finds gaps/contradictions) | ✅ unique | ❌ | ❌ | ❌ | ❌ | ❌ |

**Read:** we are ahead of everyone on *memory depth, agency and provenance*, and behind NotebookLM and the mind-map tools on *how knowledge is presented back to the human*. Nobody in that table has both. That is the whole opportunity of this sprint.

**The differentiated pitch:** NotebookLM's mind map dies with the notebook. Ours is generated *from a memory graph that has been learning across every conversation, mission and document you have ever fed it* — so a map you generate today already knows what you studied last month, flags contradictions, and can be handed to an agent as a study plan or research mission.

Sources for competitor behaviour: [NotebookLM interactive mind maps](https://learnprompting.org/blog/notebooklm-interactive-mind-maps), [mind map usage patterns](https://www.makeuseof.com/notebooklms-mind-map-tool-powerful-tips/), [alternatives landscape 2026](https://www.atlasworkspace.ai/blog/notebooklm-mind-maps).

---

## Part 3 — The plan

Two tracks. **Track B ships first** — it is smaller, touches the surface the user sees every day, and its output format becomes the input format for Track A.

---

## Track B — Study Mode (visual, study-friendly answers)

**Goal:** when Study Mode is on, an answer comes back as a sequence of designed cards — display-serif title, small-caps kicker line, structured body, a mini diagram where the content has structure, a "HOW TO USE IT" action list, a "USEFUL FOR" footer — matching the reference carousel aesthetic. Not decoration: each block type maps to a real learning device (chunking, dual coding, worked example, contrast, retrieval practice).

### B0 — Design contract (do this first, it de-risks everything)

The model must **never emit HTML**. It emits typed JSON blocks inside a fenced code block; the frontend renders them. Malformed JSON degrades to a normal markdown code block instead of breaking the message.

````
```studyblock
{"type":"card","title":"End With Forward Pull",
 "kicker":"THE LAST LINE OF EACH BEAT SHOULD DRAG THE NEXT ONE FORWARD",
 "body":"...", "howToUse":["End sections on tension, not closure","..."],
 "usefulFor":"Carousels, reels, scripts, long-form"}
```
````

**Block types (v1 — nine, deliberately small):**

| type | renders as | learning purpose |
|---|---|---|
| `card` | title + kicker + body + `howToUse[]` + `usefulFor` | the atomic concept card (the reference style) |
| `flow` | horizontal boxes joined by `→`, optional caption | process / pipeline (Hook → Mini answer → Twist) |
| `compare` | two-column ✗ / ✓ boxes with a `→` between | contrast pairs (Low stakes vs High stakes) |
| `steps` | numbered vertical list with connectors | ordered procedure |
| `note` | taped index-card look, handwriting-style font | examples, quotes, "the twist" lines |
| `keyterms` | definition chips, click to expand | vocabulary |
| `formula` | boxed expression + variable legend | quantitative concepts |
| `checkpoint` | 2–3 recall questions, answers hidden until tapped | retrieval practice — the thing NotebookLM lacks |
| `takeaway` | full-width closing panel | consolidation |

**Deliverables**
- `frontend/study_blocks.js` — parser + renderer, self-contained, exposes `window.StudyBlocks.render(container, markdown)`. Renders into the existing `.markdown-body` pipeline: split on ` ```studyblock ` fences, `marked.parse()` the prose between them, render blocks natively. DOMPurify still applies to prose.
- `frontend/study_blocks.css` — the card system, in the app's warm palette (`#efe8de` cream, `#3a2e23` espresso, gold `#d4af37` accents), with a dark-mode mirror matching the neural map's `data-nm-theme` convention.
- All SVG/CSS — no chart or diagram library, no CDN (matches existing constraints).

### B1 — Backend: the Study Mode instruction

- `services/personas.js`: add an exported `STUDY_MODE_DIRECTIVE` — the block grammar, a worked example, and hard rules (*use `flow` only when there is a real sequence; use `compare` only for genuine contrast; always end with `checkpoint` then `takeaway`; never more than 8 blocks; prose between blocks stays short*).
- `ContextBuilder.js`: append the directive when `studyMode` is true, exactly the way the existing `allowWeb` flag threads through.
- `routes/aiChat.js`: accept `studyMode` in the `/send` body → `chatWithPersona` → `route()` → `CognitiveCore` → `ContextBuilder`. Persist per session in `ai_session_meta` so reopening a study chat stays in study mode.
- Applies to **all** personas — Aurelius explaining a valuation model, Rasha explaining an interview loop, Nova explaining a paper. Study Mode is a rendering contract, not a new agent.

### B2 — Frontend wiring

- Composer toggle next to the existing Web toggle (`localStorage['finchat_study_mode']`, same pattern as `finchat_web_access`).
- Bubble renderer at `finchat_chat.html:1369` and `:1829`: if the text contains a `studyblock` fence, hand it to `StudyBlocks.render`.
- Per-message actions: **Save to Knowledge** (POST `/api/knowledge/ingest-document` — endpoint already exists), **Make mind map** (Track A), **Export** (print stylesheet → PDF).
- Mobile-first: cards stack, `flow` scrolls horizontally in its own container.

### B3 — Reuse

Point `finchat_reports.html` at the same renderer so generated reports inherit the card system for free.

**Test:** `scripts/test_study_blocks.js` — parser unit tests (well-formed, malformed, nested fences, unknown type, empty arrays), a real Groq round-trip asserting valid JSON for each of the nine types, and an XSS case proving injected markup in a block field is escaped.

---

## Track A — Mind Map Studio

**Goal:** a real mind map page — AI-generated from a topic, a chat, a document or a slice of the memory graph; radial and collapsible; every node clickable into a scoped conversation; editable and persistent.

### A1 — Data model (migration `023_mind-maps`)

Deliberately **separate tables from `neural_maps`**. The neural map answers *"what does the system know and do"*; a mind map answers *"how should I understand this topic"*. Different shape (tree, not mesh), different lifecycle. Sharing tables would force one to lie about the other — the same principle behind derived nodes being hideable but not deletable on the neural map.

```
mind_maps        id, user_id, title, topic, source_type(topic|chat|document|graph|mission),
                 source_ref, layout(radial|tree|freeform), theme, created_at, updated_at
mind_map_nodes   id, map_id, parent_id, label, summary, detail, node_type(root|branch|leaf|question|task),
                 color, icon, collapsed, x, y, order_index, entity_id (FK → entities, nullable),
                 source_meta jsonb, created_at
mind_map_edges   id, map_id, from_node, to_node, label, style      -- cross-links only; hierarchy lives in parent_id
mind_map_chats   id, map_id, node_id, session_id                    -- node ↔ scoped conversation
```

`entity_id` is the bridge: a mind-map node that corresponds to a real memory-graph entity links to it, so studying a topic **activates** it (`MemoryEngine.recordActivation`) and it lights up on the neural map heatmap. That crossover is the moat — no competitor can do it.

### A2 — Generator service

`services/cognitive/MindMapEngine.js`:

- `generateFromTopic(userId, topic, opts)` — LLM produces a strict hierarchy JSON (root → 4–7 branches → 3–5 leaves each, depth ≤ 4), enriched with any matching entities already in the user's graph.
- `generateFromChat(userId, sessionId)` — map an existing conversation.
- `generateFromDocument(userId, attachmentId)` — reuses `services/attachments.js` extraction (pdf/docx/text already supported).
- `generateFromGraph(userId, entityId, depth)` — project the *real* memory graph outward. This is the one nobody else has.
- `expandNode(mapId, nodeId)` — grow a branch on demand, NotebookLM-style, using the node's ancestor chain as context.
- `suggestGaps(mapId)` — reuse `MemoryEngine.detectGaps` to mark what the map is missing (dotted "?" nodes). A study tool that tells you what you *don't* know yet is a genuinely new behaviour.

Every generation records `report_snapshots`-style provenance and respects the existing token budget guards.

### A3 — API — `routes/mindMaps.js` → `/api/mind-maps`

```
GET    /                        list
POST   /generate                {sourceType, topic|sessionId|attachmentId|entityId}
GET    /:id                     full tree
POST   /:id/nodes               add node
PATCH  /:id/nodes/:nodeId       rename / move / recolor / collapse
DELETE /:id/nodes/:nodeId       delete subtree
POST   /:id/nodes/:nodeId/expand    AI-grow this branch
POST   /:id/nodes/:nodeId/chat      scoped conversation about this node
POST   /:id/layout              bulk position save (the unnest INSERT pattern from neuralMap.js — do NOT loop awaits)
GET    /:id/export              markdown | opml | png
POST   /:id/to-mission          hand the map to an agent as a study/research plan
```

Ownership guards mirror `neuralMap.js` (`requireOwnedMap`, 404 not 401 on someone else's map).

### A4 — UI — `frontend/finchat_mindmap.html`

Not design-tool-managed, so it is safe from regeneration — same as the neural map and neural network pages.

- Canvas radial layout, curved branch strokes, colour-by-branch, zoom/pan.
- Collapse/expand chevrons per node; `Ctrl/Cmd+A` select-all and marquee drag (port from `finchat_neuralmap.html`).
- **Node click → right panel:** summary, detail, **Ask about this** (scoped chat), **Expand**, **Add child**, **Open in Neural Map** if `entity_id` is set.
- Generate modal: topic / this chat / upload document / from my knowledge graph.
- **Study Mode crossover:** the node panel's answers render through `study_blocks.js`. One design language across both surfaces.
- Toolbar: layout switch, theme (warm/dark, `localStorage['finchat_mm_theme']`), export, present mode (walk branches one at a time — a study review flow).
- Sidebar: add to `sidebar_nav.js` `PAGE_KEYS` **and** to the inline sidebar in `finchat_chat.html` (it has its own copy — a known trap).

### A5 — Agent tool

`tools/MindMapTool.js` — read + create, wired to plato and nova, so *"make me a mind map of everything you know about transformer attention"* works from chat. Unlike `NeuralMapTool`, creation is allowed here; mind maps are user artifacts, not system state.

**Tests:** `scripts/test_mind_maps.js` (CRUD, tree integrity, cascade delete, cross-user isolation, bulk layout, export formats) and `scripts/test_mind_map_generation.js` (live Groq: valid hierarchy, depth bounds, entity linking, expand keeps ancestor context, gap nodes appear).

---

## Part 4 — Sequencing

| Stage | Scope | Size |
|---|---|---|
| **0** | Commit the working tree; confirm DB (Supabase vs local PG) and re-run a smoke suite | XS |
| **B0–B2** | Study Mode: block contract, renderer, persona directive, composer toggle | M |
| **B3** | Reports reuse the renderer | XS |
| **A1–A2** | Migration 023 + MindMapEngine (topic + chat sources) | M |
| **A3** | `/api/mind-maps` routes | S |
| **A4** | Mind Map Studio page | L |
| **A5** | Document + graph sources, MindMapTool, gap nodes, `to-mission` | M |
| **Polish** | Export/present mode, mobile pass, mojibake sweep (recurring after any design-tool regen) | S |

**Ship order rationale:** B first means the very next thing the user sees is different. A then lands on top of a rendering system that already exists, instead of inventing its own.

## Part 5 — Risks

- **Design-tool regeneration** clobbers `finchat_chat.html` and shared JS includes. Mitigation: keep every new capability in standalone files (`study_blocks.js`, `finchat_mindmap.html`); after any regen, re-add `<script>` includes and diff shared JS.
- **LLM emitting invalid block JSON.** Mitigation: strict grammar in the directive, one worked example, a lenient parser, and graceful degradation to a code block. Test with the 8B fallback model, not just 70B — Ollama `qwen2.5:3b` will be the worst case.
- **Mind maps that are just prettier bullet lists.** Mitigation: enforce breadth/depth bounds in the generator, and make `expandNode` + gap detection the primary interaction rather than one-shot generation.
- **Local `jsonb` vector fallback** degrades entity matching for `generateFromGraph`. Build it against Supabase, or accept reduced linking locally and say so.
