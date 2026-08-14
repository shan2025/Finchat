# FinChat — Governed AI Messaging Platform
### v0.2.0 | Cognitive Memory Engine · Multi-Agent Collaboration · Study Mode · Mind Map Studio

**FinChat is where humans and AI agents collaborate in the same chat.** A silent supervisor engine (Plato) monitors every message for fraud, manages a token economy, cryptographically anchors conversation history to the Solana blockchain — and the standout feature: **a living knowledge graph that learns from every chat, consolidates itself during "dream cycles," and shows you exactly which concepts it used to answer you.**

This is not a chatbot wrapper. It's a **governed AI operating-system prototype**: multi-agent (4 specialist personas), multi-memory (semantic graph + episodic timeline + procedural learnings), multi-chain (IPFS + Solana), and governance controls including fraud scanning, token accounting, zero-knowledge proofs, and role-based access. External services must be configured to use their live integrations; development fallbacks are explicitly marked in the UI and code.

---

## Implementation status

| Feature | Status | Notes |
|---|---|---|
| **Cognitive Memory Engine** | Implemented | Includes name-based deduplication, retrieval, activation, dream consolidation, and gap detection; run the verification commands before claiming a live result. |
| **4 chat agents** (Plato, Aurelius, Rasha, Nova) | Implemented | Specialized domains, real system prompts, avatars. Plus Sentinel + Memory as non-chat agents |
| **Neural Map visualization** | Implemented | Real-time thinking, heatmap mode, **neighborhoods mode**, activation pulses |
| **Community detection** | Implemented | Label propagation clusters the graph into named neighborhoods (LLM-named) |
| **Nightly dream digest** | Implemented | "While you were away: learned N, merged K, found G gaps" → your channels |
| **Blockchain proof chain** | Implemented | SHA-256 hash chain with optional IPFS archival and Solana devnet anchoring; unavailable services fall back to clearly marked simulation. |
| **Token economy** | Implemented | Per-user & per-agent budgets, real cost tracking |
| **Real-time chat** | Implemented | Socket.io, typing indicators, group chat, read receipts |
| **Fraud detection** | Implemented | Uses Ollama when configured; otherwise the prototype uses deterministic pattern-based fallback scanning. |
| **Missions scheduler** | Implemented | BullMQ + Redis, per-mission budgets, autonomous agents |
| **Notifications** | Implemented | In-app notifications are wired; email, Telegram, Web Push and WhatsApp require their respective service configuration. |
| **Knowledge Center dashboard** | Implemented | Four-quadrant memory view (Semantic/Episodic/Procedural/RAG) |
| **Reports module** | Implemented | Periodic narratives (growth, agent learning, dream digest, gaps, profile) |
| **Study Mode** | Implemented | Answers render as typed JSON blocks (9 card types) instead of plain markdown; per-session toggle. 1:1 chat only — group chat and missions ignore it |
| **Mind Map Studio** | Implemented | AI-generated radial maps from a topic, chat, document or a slice of the memory graph; node → scoped conversation |
| **Agent tools (23)** | Implemented | search, news, paper, fetch, crawl, wikipedia, reddit, quora, stocks, crypto, commodities, jobs, resume, watchlist, notifications, neural_map, bash, file/glob, … |
| **WhatsApp channel** | Code complete, unconfigured | Twilio + Meta paths, 24-hour-window logic, signed webhook. Awaiting credentials — see `docs/WHATSAPP_NOTIFICATIONS.md` |
| **Cluster summarization in dreams** | 🛣️ Roadmap | AI writes a paragraph per neighborhood (Stage 2 of the memory sprint) |
| **Embedding-based dedup** | 🛣️ Roadmap | Merge "LLM" ≈ "large language model" by vector similarity (Stage 3) |
| **Agent sandboxing** | 🛣️ Roadmap | `bash` and the file tools reach the host directly. See "Security posture" below and `docs/SECURITY_FOUNDATION_GAP_ANALYSIS.md` |

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser / Frontend                       │
│   React SPA + vanilla HTML (no build step for now)          │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTPS / WebSocket
┌───────────────────────▼─────────────────────────────────────┐
│              Node.js + Express + Socket.io                  │
│   ├─ 19 REST routes (auth, messages, tokens, agents, etc.)  │
│   ├─ Real-time events (chat, agent pulses, graph activation)│
│   └─ EventBus + StateMachine (cognitive coordination)       │
└───────────────────────┬─────────────────────────────────────┘
            ┌───────────┼───────────┬────────────────┐
            │           │           │                │
        ┌───▼──┐    ┌───▼──┐  ┌───▼───┐      ┌────▼─────┐
        │Postgres  Redis   │  Solana  │      IPFS/Pinata
        │(Supabase)Queue   │  Devnet  │      (encrypted)
        └───────┘    └──┬──┘  └────────┘      └───────────┘
                       │
              (Groq inference + Ollama-ready)
```

### Three layers working as one

1. **Orchestration Layer** — `services/cognitive/` (`CognitiveCore`, `ExecutionManager`, `ReasoningEngine`, `ReflectionEngine`, `MemoryEngine`, `DebateOrchestrator`)
   - Routes user messages → agents
   - Manages token deductions
   - Runs the governance pipeline
   - Builds, consolidates, and retrieves from the knowledge graph
   - Emits real-time "pulses" to the UI

2. **Agent Layer** — `services/agents/` & `services/personas.js`
   - 4 specialist AI personas with specialized system prompts
   - Can debate each other, run missions, collaborate
   - Isolated sandboxes with token budgets
   - Health checks + auto-restart on crash

3. **Data Layer** — PostgreSQL (28 migrations)
   - `entities` & `entity_edges` (the living knowledge graph)
   - `graph_communities` (named neighborhoods from community detection)
   - `node_events` (append-only timeline per concept)
   - `messages` & `proof_chain` (chat + cryptographic audit trail)
   - `user_tokens` & `token_ledger` (spend history)
   - `fraud_logs` (governance events)
   - `missions` & `executions` (agent work tracking)
   - `mind_maps`, `mind_map_nodes`, `mind_map_edges` (Mind Map Studio)

---

## Project structure

```
finchat/
├── docs/
│   ├── CURRENT_ARCHITECTURE.md             ← The system that actually exists (start here)
│   ├── SECURITY_FOUNDATION_GAP_ANALYSIS.md ← Honest security posture + open P0s
│   ├── system_architecture_document.md     ← Enterprise vision (FastAPI/Qdrant/K8s)
│   ├── WHATSAPP_NOTIFICATIONS.md           ← WhatsApp channel setup
│   ├── SPRINT_X_COGNITIVE_MEMORY_ENGINE.md ← Shipped (Stages 1–4)
│   ├── SPRINT_Y_KNOWLEDGE_AND_REPORTS.md   ← Shipped (Knowledge Center + Reports)
│   ├── SPRINT_Z_STUDY_MODE_AND_MIND_MAPS.md ← Shipped (Study Mode + Mind Map Studio)
│   └── adr/                                ← Architecture decision records
│
+-- legacy_prototype/                        ? The working Node.js/PostgreSQL prototype
│   ├── backend/
│   │   ├── server.js                        ← Express + Socket.io entry point
│   │   ├── database.js                      ← PostgreSQL connection
│   │   ├── migrations/                      ← 28 schema evolutions (node-pg-migrate)
│   │   │   ├── 1720000000001_core-governance-and-users.js
│   │   │   ├── 1720000000019_cognitive-memory-engine.js  ← The big one
│   │   │   ├── 1720000000028_entities-per-user.js        ← Graph ownership
│   │   │   └── ...
│   │   ├── routes/
│   │   │   ├── auth.js                      ← Login, wallet, JWT
│   │   │   ├── messages.js                  ← Chat, proof chain
│   │   │   ├── aiChat.js                    ← Agent requests
│   │   │   ├── agents.js                    ← Agent registry & status
│   │   │   ├── knowledge.js                 ← Graph API (nodes, activity, insights)
│   │   │   ├── blockchain.js                ← Proof explorer
│   │   │   ├── notifications.js             ← Bell push
│   │   │   ├── missions.js                  ← Autonomous agent work
│   │   │   ├── group-chat.js                ← Multi-party rooms
│   │   │   ├── tokens.js                    ← Ledger queries
│   │   │   ├── mindMaps.js                  ← Mind Map Studio API
│   │   │   ├── neuralMap.js                 ← System graph view
│   │   │   ├── reports.js                   ← Generated narratives
│   │   │   ├── search.js                    ← Knowledge search
│   │   │   ├── cron.js                      ← External-scheduler triggers
│   │   │   ├── whatsappWebhook.js           ← Inbound WhatsApp (signed)
│   │   │   └── ... (admin, executions, settings)
│   │   ├── services/
│   │   │   ├── cognitive/
│   │   │   │   ├── CognitiveCore.js         ← Main orchestrator
│   │   │   │   ├── MemoryEngine.js          ← Extract → dedupe → graph → dream
│   │   │   │   ├── EntityGraph.js           ← Graph queries & retrieval
│   │   │   │   ├── ContextBuilder.js        ← Prepare context for LLM
│   │   │   │   ├── ReasoningEngine.js       ← Think step-by-step
│   │   │   │   ├── PlanningEngine.js        ← Goal decomposition
│   │   │   │   ├── ReflectionEngine.js      ← Self-evaluation
│   │   │   │   ├── ExecutionManager.js      ← Task lifecycle
│   │   │   │   ├── DebateOrchestrator.js    ← Multi-agent debates
│   │   │   │   ├── EventBus.js              ← Pub/sub for real-time
│   │   │   │   ├── StateMachine.js          ← State transitions
│   │   │   │   ├── MindMapEngine.js         ← Mind map generation
│   │   │   │   ├── ToolManager.js           ← THE execution boundary: permission
│   │   │   │   │                               → rate limit → approval → audit
│   │   │   │   └── ToolRegistry.js          ← Tool definitions
│   │   │   ├── agents/
│   │   │   │   ├── MissionScheduler.js      ← Cron job orchestration
│   │   │   │   ├── GroupChatOrchestrator.js ← Multi-party logic
│   │   │   │   ├── BaseAgent.js             ← Agent base class
│   │   │   │   ├── MemoryAgent.js           ← Knowledge curator
│   │   │   │   └── ... (4+ more)
│   │   │   ├── queue/
│   │   │   │   └── WorkerPool.js            ← BullMQ worker orchestration
│   │   │   ├── personas.js                  ← Plato, Aurelius, Rasha, Nova
│   │   │   ├── notificationChannels.js      ← Email, Telegram, Web Push
│   │   │   ├── whatsapp.js                  ← Twilio + Meta WhatsApp
│   │   │   ├── solana.js                    ← Blockchain anchor calls
│   │   │   ├── ipfs.js                      ← Pinata archival
│   │   │   ├── inference.js                 ← LLM calls (Groq primary)
│   │   │   └── ... (10+ more)
│   │   ├── scripts/
│   │   │   ├── test_cognitive_memory_engine.js ← 18/18 checks
│   │   │   └── test_stage3_agent_cortex.js      ← 14/14 checks
│   │   ├── package.json
│   │   └── .env.example
│   │
│   └── frontend/
│       ├── finchat_login.html               ← Auth + wallet link
│       ├── finchat_chat.html                ← Main real-time chat
│       ├── finchat_neuralmap.html           ← Graph visualization + thinking
│       ├── finchat_agents.html              ← Agent roster & status
│       ├── finchat_groupchat.html           ← Multi-party chat
│       ├── finchat_blockchain.html          ← Proof explorer
│       ├── finchat_audit.html               ← Auditor panel (fraud logs)
│       ├── finchat_inbox.html               ← Notifications
│       ├── finchat_dashboard.html           ← Overview
│       ├── finchat_knowledge.html           ← Knowledge Center (memory quad)
│       ├── finchat_reports.html             ← Generated narratives
│       ├── finchat_mindmap.html             ← Mind Map Studio
│       ├── finchat_neuralnetwork.html       ← Neural network lab
│       ├── finchat_signup.html              ← Registration
│       ├── finchat_link_wallet.html         ← Wallet linking
│       ├── finchat_settings.html            ← Preferences
│       ├── finchat_theme.css                ← THE shared design layer (all pages)
│       ├── study_blocks.js / .css           ← Study Mode block renderer
│       ├── sidebar_nav.js                   ← Shared navigation
│       ├── knowledge_search.js              ← Graph search box
│       ├── notifications_widget.js          ← Live bell
│       ├── missions_widget.js               ← Agent missions panel
│       └── sw.js                            ← Service worker (Web Push)
│
├── _ARCHIVED_api/ & _ARCHIVED_backend_unused/  ← Dead ends. Not used, not built.
│                                               The live backend is the one above.
├── render.yaml                              ← Render deploy config (documentation
│                                               of the dashboard settings)
│
└── README.md                                ← This file
```

---

## Quick Start (5 minutes)

**Prerequisites:** Node.js 18+, PostgreSQL (or Supabase), Git

### Step 1 — Clone & install

```bash
git clone https://github.com/shan2025/Finchat.git
cd Finchat/finchat/legacy_prototype/backend
npm install
```

### Step 2 — Environment setup

```bash
cp .env.example .env
```

Open `.env` and set at minimum:
- `JWT_SECRET` — any long random string
- `DATABASE_URL` — PostgreSQL connection string (defaults to localhost)
- `GROQ_API_KEY` — get one free at https://console.groq.com

Everything else (Solana devnet, Pinata IPFS, Gmail, Telegram) works with defaults or is optional.

### Step 3 — Start the backend

```bash
# Still in /backend
npm run dev
```

You'll see:
```
╔══════════════════════════════════════╗
║   FinChat Backend  v0.2.0            ║
╠══════════════════════════════════════╣
║   REST API  →  http://localhost:3000 ║
║   Socket.io →  ws://localhost:3000   ║
╚══════════════════════════════════════╝
```

### Step 4 — Open the frontend

**Do not start a second server.** `server.js` serves `legacy_prototype/frontend`
statically on the same port, so the backend is the only thing that needs to run.

Open **http://localhost:3000/finchat_login.html** in your browser.

(Serving the frontend separately on another port is the usual cause of "I can't
log in" — the page loads, but every API call goes to the wrong origin.)

### Step 5 — Create an account & explore

Register a new account, then:
1. **Chat** — send a message, watch the AI respond
2. **Neural Map** — click to see what the AI just learned
3. **Agents** — view the 4 specialist personas
4. **Blockchain** — see the hash-chain proofs in real-time

---

## Deep dives: What makes FinChat different

### 🧠 The Cognitive Memory Engine

FinChat's AI doesn't just chat — it **learns and remembers**. Every message updates a living knowledge graph.

**What happens when you chat:**
1. Your message arrives
2. The AI generates an answer
3. **Fire-and-forget**: the Cognitive Memory Engine extracts entities, relationships, and reasoning in the background
4. It checks for duplicates (merge, don't fork), detects contradictions, and weaves everything into the graph
5. The learning never blocks your chat response — guaranteed

**What you see:**
- While the AI thinks: *"🧠 Recalling: Transformers → PyTorch → Knowledge graph"* (the real retrieval path, not canned)
- Under every answer: *"🧠 PyTorch → Transformers +1 more · 5 memories · view on map"* (the concepts used)
- On the Neural Map: nodes glow red (used today), orange (this week), gray (forgotten)
- Timeline per node: shows every chat, mention, activation, merge

**The dream cycle:**
Every 6 hours, the system consolidates: merges duplicates, decays unused links (dim them, never delete), reinforces recent ones, hunts for gaps, and **re-clusters the graph into named neighborhoods** (label propagation, e.g. *"DeFi"*, *"LLM Tooling"*, *"Precious Metals"*). **The first real run merged 14 duplicate nodes** that months of chats had accumulated; a live run clustered 86 of 95 concepts into 10 neighborhoods.

**The nightly digest:**
Once a day, after consolidating, the system tells each active user what changed — *"While you were away, I learned 12 new concepts, formed 5 links, merged 3 duplicates and found 2 knowledge gaps."* — delivered to their in-app bell and every channel they enabled (email, Telegram, Web Push), plus a snapshot on the Reports page. On the Neural Map, the **Neighborhoods** toggle (workspaces icon) colors every concept by its territory and turns the legend into the list of named clusters.

**Verification:**
- `npm run verify` performs a safe local configuration and component check; it makes no network or database calls.
- `scripts/test_cognitive_memory_engine.js` and `scripts/test_stage3_agent_cortex.js` are integration-style scripts. Run them only against a disposable test database and record their current results before presenting test counts.

---

### 🤖 Multi-Agent Governance

Four specialist AI personas, each with its own brain:

| Agent | Role |
|---|---|
| **Plato** | Chief AI Officer · system supervisor · the one admin agent |
| **Aurelius** | Finance & investment strategist |
| **Rasha** | Career strategist · job finder |
| **Nova** | Frontier science researcher |

Plus two non-chat agents in `services/agents/`: **Sentinel** (pre-execution safety checks)
and **Memory** (knowledge curation).

Each agent:
- Has a **system prompt** (immutable, stored in DB)
- Can **debate each other** — positions gathered, conflicts detected, resolution reached (all live-streamed to your chat)
- Runs **autonomous missions** (daily briefings, job scans) on a schedule with per-mission token budgets
- Has its own **cortex** — preferred knowledge. Finance retrieves tickers first; Research surfaces papers.

**Agents can:**
- Run in parallel (multi-agent request) or sequentially
- Call tools (web search, market data, document parsing)
- Reflect on their reasoning ("was that answer good?")
- Be paused / resumed / frozen if they overspend

---

### ⛓️ Governed Autonomy

Every AI action is constrained:

- **Token economy**: each user & agent has a daily budget. Every LLM call costs tokens. The ledger is immutable and exported.
- **Fraud detection**: messages scanned for policy violations (insider trading, phishing, etc.). If flagged, account freezes + auditor quarantine.
- **Role-based access**: Admin/Staff/Auditor/User with distinct permissions.
- **Zero-knowledge proofs** (`snarkjs`/`circom`): prove things without revealing details (e.g., admin unblock without showing why).
- **Blockchain proof chain**: every message includes the hash of the previous one; the final hash is anchored to Solana. If anyone tampers, the chain breaks.

---

### 📝 Real-Time Features

- **WebSocket chat**: typing indicators, read receipts, agent pulses
- **Multi-room chat**: group chats with role-based access
- **Agent status pulses**: watch in real-time as agents think (execution:created → waiting → completed)
- **Graph activation pulses**: watch nodes light up as the AI recalls them
- **Debate rounds**: see agent positions, conflicts, and consensus in real-time
- **Notifications**: in-app notifications are available; email, Telegram, and Web Push activate when their channels are configured.

---

### 🔐 Security & Privacy

- **Phantom wallet login** (Solana keystore-based auth)
- **JWT + bcrypt**: email/password also supported
- **GDPR/DPDP crypto-shredding**: delete a user → delete their decryption key. Raw IPFS records remain on-chain (immutable ledger) but become mathematically unreadable.
- **One execution boundary**: every tool call goes through `ToolManager.executeTool()` —
  permission check → rate limit → human-approval gate → cache → structured audit row.
  Agents never touch a tool implementation directly.
- **Host-access tools are deny-by-default**: `bash`, `file_write` and `file_edit` require an
  explicit grant (migration 026); a database outage fails *closed*, not open.

### Security posture — read this before deploying

This is a prototype, and the honest assessment lives in
[`docs/SECURITY_FOUNDATION_GAP_ANALYSIS.md`](docs/SECURITY_FOUNDATION_GAP_ANALYSIS.md).
The short version of what is **not** yet true:

- **Agents are not sandboxed.** `BashTool` calls `child_process.exec` on the host with only
  a timeout and a buffer cap — no container, no allowlist, no filesystem confinement. Access
  is restricted to one admin agent, which reduces *who* can reach the host; it does not make
  reaching the host safe.
- **Tool output carries no trust boundary.** Text from `crawl`, `fetch`, `reddit`, `quora`
  and `paper` is concatenated into the next prompt with no provenance envelope, so indirect
  prompt injection is an open surface.
- **Approval is a boolean, not a risk tier.** There is no LOW/MEDIUM/HIGH classification.
- **Memory has no ACL or provenance**, and the `dream()` loop consolidates it into
  persistent, trusted context.
- **There is no kill switch** for a running execution.

Do not deploy this in a position to reach anything you care about until those are closed.

---

### 📊 What's in the database

PostgreSQL (Supabase or local), 28 migrations:

- **Core**: `users`, `messages`, `channels`, `sessions`
- **Knowledge**: `entities`, `entity_edges`, `node_events`, `entity_links`, `graph_insights`, `graph_communities`
- **Reports**: `report_snapshots`, `inference_metrics`
- **Governance**: `fraud_logs`, `user_tokens`, `token_ledger`, `auditor_decisions`
- **Blockchain**: `proof_chain` (hash chains), `solana_anchors` (finalized tx hashes)
- **Agents**: `agent_registry`, `executions`, `execution_logs`, `missions`, `mission_runs`
- **Mind maps**: `mind_maps`, `mind_map_nodes`, `mind_map_edges`, `mind_map_chats`
- **Notifications**: `notification_preferences`, `notifications`, `notification_deliveries`

> Migrations are **not** run automatically — not on boot, not on deploy. Apply them
> yourself with `npm run migrate:up` before starting a version that expects new columns.

`proof_chain` and `node_events` are append-only by design — history is the feature there.
The graph tables (`entities`, `entity_edges`) are deliberately mutable: the dream cycle
merges duplicates, decays unused links and reinforces recent ones in place.

---

### 🛣️ Roadmap (sprints X & Y)

**Sprint X Stage 4** (shipped ✅):
- ✅ Nightly dream digests pushed to the bell + Telegram/email/Web Push
- ✅ Community detection on the graph (clusters → LLM-named neighborhoods, surfaced on the Neural Map)
- 🛣️ Cluster summarization during dreams — a paragraph per neighborhood
- 🛣️ Embedding-based (not just name) duplicate detection

**Sprint Y** (shipped ✅):
- ✅ **Knowledge Center dashboard** — four-quadrant memory view (Semantic/Episodic/Procedural/RAG)
- ✅ **Reports module** — periodic narratives (growth, agent learning, dream digest, gaps, user profile)
- ✅ Inference & context-reuse instrumentation (`inference_metrics`)

**Sprint Z** (shipped ✅):
- ✅ **Study Mode** — nine typed block types (card, flow, compare, steps, note, keyterms,
  formula, checkpoint, takeaway) rendered client-side from model-emitted JSON
- ✅ **Mind Map Studio** — generate from a topic, chat, document or memory-graph slice;
  radial/collapsible; each node opens a scoped conversation
- 🛣️ Study Mode in group chat and missions (currently 1:1 chat only)

**Open security work** (see `docs/SECURITY_FOUNDATION_GAP_ANALYSIS.md`):
- 🛣️ Sandbox `bash` and the file tools (P0-1c)
- 🛣️ Untrusted-content envelope on tool output (P0-2)
- 🛣️ Risk tiers on the tool registry (P0-3)
- 🛣️ Memory ACL + provenance (P0-4)
- 🛣️ Agent-to-agent authorisation (P0-5)

**Vision (in `docs/system_architecture_document.md`)**:
- FastAPI microservices (Python/async focus)
- Qdrant vector DB (distributed)
- Kubernetes + gVisor sandboxes
- Enterprise-grade HA/DR

---

## Optional: Connect Qwen 2.5 (local LLM)

For fully offline fraud detection:

```bash
# Terminal 1 — start Ollama
ollama serve

# Terminal 2 — pull model (first time only)
ollama pull qwen2.5:7b
```

FinChat will auto-fall back to Ollama if Groq is down or for certain security levels.

---

## Optional: Connect to Pinata (IPFS)

For persistent decentralized proof archival:

1. Sign up free at https://pinata.cloud
2. Get your API + Secret keys
3. Add to `.env`:
```
PINATA_API_KEY=your_key
PINATA_SECRET_KEY=your_secret
```

Restart — proofs are now pinned to IPFS automatically.

---

## Optional: Connect Telegram bot

For mission alerts & dream digests:

1. Chat with `@Platotelebot` on Telegram
2. Message: `/start`
3. Note the returned user ID
4. Add to `.env`:
```
TELEGRAM_BOT_TOKEN=1234567890:ABCDEFghijklmnop
TELEGRAM_USER_ID=123456789
```

---

## Optional: Connect Gmail (for email notifications)

1. Enable 2FA on your Gmail account
2. Create an app password: https://myaccount.google.com/apppasswords
3. Add to `.env`:
```
GMAIL_USER=your-email@gmail.com
GMAIL_PASSWORD=your-16-char-app-password (no spaces)
```

---

## Test the backend

```bash
curl http://localhost:3000/health
```

Expected:
```json
{
  "status": "ok",
  "service": "FinChat Backend",
  "version": "0.2.0",
  "users": 5,
  "messages": 42,
  "uptime": "3600.5s",
  "solana_connected": true
}
```

---

## Docker (optional)

```bash
# Build & run everything (backend + Postgres + Redis)
cd legacy_prototype
docker compose up --build

# Stop
docker compose down

# Reset data (caution!)
docker compose down -v
```

---

## API Reference

### Authentication

```bash
# Register
POST /api/auth/register
{ "name": "Alice", "email": "alice@co.com", "password": "..." }

# Login
POST /api/auth/login
{ "email": "alice@co.com", "password": "..." }

# Wallet (Phantom)
POST /api/auth/wallet-challenge  → returns challenge
POST /api/auth/wallet-verify { challenge, signature } → returns JWT
```

### Chat & Messages

```bash
# Send a message (real-time + learns the graph)
POST /api/messages/general
Authorization: Bearer <jwt>
{ "content": "Hello Plato", "files": [...] }

# Get history
GET /api/messages/general
Authorization: Bearer <jwt>

# Get proof chain for a channel
GET /api/messages/general/proof
Authorization: Bearer <jwt>
```

### AI Chat (agent requests)

```bash
# List agents
GET /api/ai-chat/personas
Authorization: Bearer <jwt>

# Send a message to an agent (spawns execution, returns streaming response)
POST /api/ai-chat/send
Authorization: Bearer <jwt>
{ "agentId": "aurelius", "userMessage": "...", "sessionId": "..." }

# Get chat history
GET /api/ai-chat/history/{sessionId}
Authorization: Bearer <jwt>
```

### Knowledge Graph

```bash
# Get a node's profile
GET /api/knowledge/nodes/{entityId}

# Get recently activated nodes (what the AI just used)
GET /api/knowledge/activity

# Get gaps & contradictions
GET /api/knowledge/insights

# Run dream cycle (consolidate + re-cluster neighborhoods)
POST /api/knowledge/dream

# Run the nightly digest now (consolidate + notify active users)
POST /api/knowledge/dream/digest

# Named neighborhoods (community detection)
GET  /api/knowledge/communities
POST /api/knowledge/communities/detect

# Ingest a document (PDF/Word/text) into an agent's cortex
POST /api/knowledge/ingest-document
{ "agentId": "nova", "content": "...", "title": "..." }

# Graph stats
GET /api/knowledge/stats
```

### Governance & Tokens

```bash
# Get user token balance & history
GET /api/tokens/balance
Authorization: Bearer <jwt>

# Get fraud logs (admin/auditor only)
GET /api/admin/fraud-logs
Authorization: Bearer <jwt>
```

### Blockchain

```bash
# Get all proofs pinned to IPFS + anchored to Solana
GET /api/blockchain/proofs?limit=50
Authorization: Bearer <jwt>

# Get one proof's full audit trail
GET /api/blockchain/proofs/{proofId}
Authorization: Bearer <jwt>
```

---

## VS Code Extensions (recommended)

- **REST Client** — test API calls inline
- **PostgreSQL** (ms-ossdata.vscode-pgsql) — inspect the schema
- **Thunder Client** or **Postman** — API testing

---

## Ports & Services

| Service | Port | Notes |
|---|---|---|
| Backend API | 3000 | Express + Socket.io |
| Ollama (if running) | 11434 | Local LLM inference |
| PostgreSQL | 5432 | DB (default) |
| Redis | 6379 | Job queue (default) |

---

## Deployment (Render)

A live instance runs at **https://finchat-6.onrender.com** — a free-plan Docker service
that deploys automatically from `main`.

Two things about the free plan that will bite you:

- **The instance sleeps when idle**, which stops the in-process mission scheduler. Scheduled
  briefings and missions are therefore driven by an *external* cron hitting
  `POST /api/cron/tick` with the `CRON_SECRET` bearer token. Without that, nothing fires.
- **"Live" in the dashboard can mean crash-looping.** Check `/health` — it returns `degraded`
  with a 503 when the database is unreachable, rather than killing the process.

`render.yaml` documents the intended configuration but does **not** control the existing
service, which was created through the dashboard. If you change one, change the other.

Migrations do not run on deploy. Apply them against the database yourself first.

---

## Notes for deployers

- **Database**: Use Supabase PostgreSQL (one-click backup + monitoring) or manage your own with HA + replicas.
- **Inference**: Groq is fast and cheap; Ollama keeps everything local. Route based on sensitivity/cost (see `services/inference.js`).
- **Job queue**: BullMQ + Redis for missions. In production, use managed Redis (Upstash, ElastiCache) or Redis Cluster.
- **Storage**: Pinata for IPFS (or self-host IPFS). Solana devnet is free; use mainnet only if you need permanent anchors.
- **Secrets**: Use a vault (HashiCorp Vault, AWS Secrets Manager, 1Password Secrets Automation). Never commit `.env`.

---

## Contributing

This is a working prototype with real-world constraints (time, teams, resources). The vision doc (`docs/system_architecture_document.md`) describes the enterprise version. The code you see is the *proven core* — contributions should focus on:

1. **Agent sandboxing** — containerise `bash` and the file tools (the top open P0)
2. **Untrusted-content boundary** — provenance envelope on tool/web output
3. **Risk tiers + memory ACLs** — replace the boolean approval gate
4. **Observability** — better logging, tracing, cost analytics

(Knowledge Center, Reports and pgvector RAG have shipped — don't start there.)

---

## License

FinChat is proprietary. Reach out to **shan20192020@gmail.com** for licensing inquiries.

---

## Questions?

- **Setup issues?** Check `.env.example` and ensure PostgreSQL is reachable.
- **Agent not responding?** Check Groq API key and rate limits.
- **Blockchain anchor stuck?** See `legacy_prototype/backend/services/solana.js` for devnet airdrop logic.
- **Memory isn't learning?** Run `POST /api/knowledge/dream` to force a consolidation cycle.

**Reach out:** issues, feature requests, or just want to see it in action → email or open a GitHub issue.
