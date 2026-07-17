# FinChat Cognitive Core — Sprint 2 Build Plan

This document outlines the architecture and execution plan for **Sprint 2**, transitioning FinChat from a solid foundation to a fully distributed, dynamic, and specialized multi-agent operating system.

## Architectural Notes from Sprint 1 Codebase

> [!TIP]
> **Regarding Procedural Memory:** I reviewed the existing database schema (`1720000000006_memories-and-knowledge.js`), and we actually **already have a `memories` table** with a `memory_type` column that explicitly accepts `episodic`, `semantic`, and `procedural`. We can use this existing table for Procedural Memory instead of creating a new `agent_procedures` table, just by scoping queries to `memory_type = 'procedural'` and the specific `agent_id`! 

---

## Proposed Changes

### Phase 1 — Agent Registry & Thick Agents (Dual-Entry)

**Goal**: Move from thin stubs to **Thick Agents**, each with their own instantiation of the Cognitive Core, capabilities, memory namespaces, and tool manifests. Support both Plato-routed (indirect) and direct-to-agent interactions.

#### [NEW] `services/agents/AgentRegistry.js`
- Database-backed registry fetching `agent_configs`.
- Stores configurations for: capability mapping, tool manifests, direct-addressability flags, and memory namespaces (e.g., `rasha::career`).

#### [MODIFY] `services/agents/BaseAgent.js`
- Upgraded to a **Thick Agent** factory.
- Instantiates a full Cognitive Core loop (`ReasoningEngine`, `PlanningEngine`, `ToolManager`) specifically scoped to the agent's persona and memory namespace.
- Allows inter-agent calling (e.g., calling Memory Agent as a sub-agent vs. direct DB query).

#### [MODIFY] `services/aiChat.js` & `PlatoOrchestrator.js`
- Support **Dual-Entry**:
  - **Path 1 (Routed):** User -> PlatoOrchestrator -> Plato assigns Specialist -> Specialist Cognitive Core.
  - **Path 2 (Direct):** User -> `@rasha` -> Rasha's Cognitive Core (bypassing Plato).

---

### Phase 2 — Sentinel Middleware & Governance

**Goal**: Implement Sentinel as a dedicated, cross-cutting governance layer that intercepts ALL executions, rather than a domain specialist.

#### [NEW] `services/agents/SentinelAgent.js`
- Acts as **Execution Middleware** wrapping both Plato-routed and direct-addressed paths.
- `Sentinel.preCheck(message)`: Evaluates fraud score and budget constraints before allowing an agent's Cognitive Core to start.
- `Sentinel.postLog(result)`: Intercepts the final result for blockchain anchoring (Hyperledger/Solana) and audit logging.

---

### Phase 3 — Full Memory Taxonomy (The Memory Agent)

**Goal**: Build the retrieval and embedding pipelines to bring Episodic, Semantic, and Procedural memory to life.

#### [NEW] `services/agents/MemoryAgent.js`
- Dedicated Thick Agent for complex memory synthesis and retrieval.

#### [MODIFY] `services/cognitive/MemoryService.js`
- **Episodic Recall**: Add semantic search / chronological filtering over the raw `executions` and `execution_logs` tables.
- **Semantic Pipeline**: Auto-embed significant exchanges via `nomic-embed-text` and write to `knowledge_embeddings` (pgvector).
- **Procedural Load**: On task start, Agents fetch `memory_type = 'procedural'` from the `memories` table to load their learned workflows into context.

---

### Phase 4 — BullMQ Background Workers

**Goal**: Offload the Cognitive Core event loop to a dedicated, production-ready queue system.

#### [NEW] `services/queue/WorkerPool.js`
- Implement **BullMQ** connected to a separate, persistent Redis instance (not the serverless Upstash instance).
- Define job processors for `cognitive_execution` jobs, handling concurrency, dead-letters, and exponential backoff.

#### [MODIFY] `routes/aiChat.js`
- Enqueue the user request to BullMQ and return a job ID immediately.

---

### Phase 5 — Human-in-the-Loop (Wait States)

**Goal**: Allow executions to pause for human compliance or user approval.

#### [MODIFY] `services/cognitive/ReasoningEngine.js` & `CognitiveCore.js`
- Allow the LLM to emit `action: "wait", reason: "human_approval"`.
- Execution halts, state updates to `WAITING`, and UI is notified via EventBus/WebSockets.

#### [NEW] `routes/executions.js`
- `POST /api/executions/:id/resume`
- Accepts payload: `{ action: "approve" | "reject", reviewer_id, comment, modified_parameters }`.
- Validates the REST payload, updates context, and resumes the execution job in BullMQ.
