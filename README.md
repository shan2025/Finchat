# FinChat — Governed AI Messaging Platform
### v0.2.0 | Cognitive Memory Engine + Multi-Agent Collaboration

**FinChat is where humans and AI agents collaborate in the same chat.** A silent supervisor engine (Plato) monitors every message for fraud, manages a token economy, cryptographically anchors conversation history to the Solana blockchain — and the standout feature: **a living knowledge graph that learns from every chat, consolidates itself during "dream cycles," and shows you exactly which concepts it used to answer you.**

This is not a chatbot wrapper. It's a **governed AI operating system**: multi-agent (4 specialist personas), multi-memory (semantic graph + episodic timeline + procedural learnings), multi-chain (IPFS + Solana), and production-hardened (real fraud detection, token ledger, zero-knowledge proofs, role-based governance).

---

## What's shipped (Stage 1–3 verified ✅)

| Feature | Status | Notes |
|---|---|---|
| **Cognitive Memory Engine** | ✅ Live | 18/18 automated tests; first dream cycle merged 14 duplicates |
| **4 AI agents** (Plato, Aurelius, Rasha, Nova) | ✅ Live | Specialized domains, real system prompts, avatars |
| **Neural Map visualization** | ✅ Live | Shows thinking in real-time, heatmap mode, activation pulses |
| **Blockchain proof chain** | ✅ Live | SHA-256 hash chaining, IPFS archival, Solana anchoring |
| **Token economy** | ✅ Live | Per-user & per-agent budgets, real cost tracking |
| **Real-time chat** | ✅ Live | Socket.io, typing indicators, group chat, read receipts |
| **Fraud detection** | ✅ Live | Policy scanning, account freeze, auditor quarantine |
| **Missions scheduler** | ✅ Live | BullMQ + Redis, per-mission budgets, autonomous agents |
| **Notifications** | ✅ Live | Email (Gmail SMTP), Telegram (@Platotelebot), Web Push |
| **Knowledge Center dashboard** | 🛣️ Roadmap | Sprint Y phase 1 |
| **Reports module** | 🛣️ Roadmap | Periodic narratives, weekly digests (Sprint Y phase 2) |

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
│   ├─ 15 REST routes (auth, messages, tokens, agents, etc.)  │
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

3. **Data Layer** — PostgreSQL (20 migrations)
   - `entities` & `entity_edges` (the living knowledge graph)
   - `node_events` (append-only timeline per concept)
   - `messages` & `proof_chain` (chat + cryptographic audit trail)
   - `user_tokens` & `token_ledger` (spend history)
   - `fraud_logs` (governance events)
   - `missions` & `executions` (agent work tracking)

---

## Project structure

```
finchat/
├── docs/
│   ├── system_architecture_document.md     ← Enterprise vision (FastAPI/Qdrant/K8s)
│   ├── SPRINT_X_COGNITIVE_MEMORY_ENGINE.md ← What's shipped (Stages 1–3)
│   └── SPRINT_Y_KNOWLEDGE_AND_REPORTS.md   ← Next (Knowledge Center + Reports)
│
├── legacy_prototype/                        ← The working system (production-ready)
│   ├── backend/
│   │   ├── server.js                        ← Express + Socket.io entry point
│   │   ├── database.js                      ← PostgreSQL connection
│   │   ├── migrations/                      ← 20 schema evolutions (001–019)
│   │   │   ├── 001-core-governance-and-users.js
│   │   │   ├── 019-cognitive-memory-engine.js  ← The big one
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
│   │   │   └── ... (11 more)
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
│       ├── finchat_settings.html            ← Preferences
│       ├── sidebar_nav.js                   ← Shared navigation
│       ├── knowledge_search.js              ← Graph search box
│       ├── notifications_widget.js          ← Live bell
│       ├── missions_widget.js               ← Agent missions panel
│       └── sw.js                            ← Service worker (Web Push)
│
├── backend/ & api/                          ← Newer / experimental paths
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

```bash
# In the project root, or use a simple HTTP server
cd ../frontend
python3 -m http.server 8000
# Or: npx serve
# Or: double-click finchat_login.html (basic mode)
```

Open http://localhost:8000/finchat_login.html in your browser.

### Step 5 — Create an account & explore

Register a new account, then:
1. **Chat** — send a message, watch the AI respond
2. **Neural Map** — click to see what the AI just learned
3. **Agents** — view the 4 specialist personas
4. **Blockchain** — see the hash-chain proofs in real-time

---

## Quick Start (5 steps) — Legacy (SQLite)

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
Every 6 hours, the system consolidates: merges duplicates, decays unused links (dim them, never delete), reinforces recent ones, hunts for gaps. **The first real run merged 14 duplicate nodes** that months of chats had accumulated.

**Verified:**
- `scripts/test_cognitive_memory_engine.js` — **18/18 checks passed** (extraction, dedup, retrieval, activation, merge, decay, gaps)
- `scripts/test_stage3_agent_cortex.js` — **14/14 checks passed** (per-agent knowledge silos, 2-hop retrieval, document ingestion)

---

### 🤖 Multi-Agent Governance

Four specialist AI personas, each with its own brain:

| Agent | Role | Cortex size |
|---|---|---|
| **Plato** | Chief AI Officer · system supervisor | — |
| **Aurelius** | Finance & investment strategist | 2 finance nodes |
| **Rasha** | Career strategist · job finder | 3 career nodes |
| **Nova** | Frontier science researcher | 6 research nodes |

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
- **Notifications**: email, Telegram, Web Push (all working, no mocks)

---

### 🔐 Security & Privacy

- **Phantom wallet login** (Solana keystore-based auth)
- **JWT + bcrypt**: email/password also supported
- **GDPR/DPDP crypto-shredding**: delete a user → delete their decryption key. Raw IPFS records remain on-chain (immutable ledger) but become mathematically unreadable.
- **Sandbox isolation**: agents run in isolated worker processes with resource limits
- **Input guardrails**: system prompts are read-only; user input is filtered for jailbreak attempts

---

### 📊 What's in the database

PostgreSQL (Supabase or local), 20 migrations:

- **Core**: `users`, `messages`, `channels`, `sessions`
- **Knowledge**: `entities`, `entity_edges`, `node_events`, `entity_links`, `graph_insights`
- **Governance**: `fraud_logs`, `user_tokens`, `token_ledger`, `auditor_decisions`
- **Blockchain**: `proof_chain` (hash chains), `solana_anchors` (finalized tx hashes)
- **Agents**: `agent_registry`, `executions`, `execution_logs`, `missions`, `mission_runs`
- **Notifications**: `notification_channels`, `notifications`, `notification_read`

Every table is immutable by design — history is the feature.

---

### 🛣️ Roadmap (sprints X & Y)

**Sprint X Stage 4** (in progress):
- Community detection on the graph (clusters → neighborhoods)
- Embedding-based (not just name) duplicate detection
- Nightly dream digests pushed to Telegram/email

**Sprint Y** (next):
- **Knowledge Center dashboard** — four-quadrant memory view (Semantic/Episodic/Procedural/RAG)
- **Reports module** — periodic summaries (weekly growth, agent learning, user patterns), exportable
- RAG vector store (pgvector) for document retrieval
- Inference & context-reuse instrumentation

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

# Run dream cycle
POST /api/knowledge/dream

# Ingest a document (PDF/Word/text) into an agent's cortex
POST /api/knowledge/ingest-document
{ "agentId": "research", "content": "...", "title": "..." }

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
- **SQLite Viewer** — inspect the schema (if using SQLite locally)
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

## Notes for deployers

- **Database**: Use Supabase PostgreSQL (one-click backup + monitoring) or manage your own with HA + replicas.
- **Inference**: Groq is fast and cheap; Ollama keeps everything local. Route based on sensitivity/cost (see `services/inference.js`).
- **Job queue**: BullMQ + Redis for missions. In production, use managed Redis (Upstash, ElastiCache) or Redis Cluster.
- **Storage**: Pinata for IPFS (or self-host IPFS). Solana devnet is free; use mainnet only if you need permanent anchors.
- **Secrets**: Use a vault (HashiCorp Vault, AWS Secrets Manager, 1Password Secrets Automation). Never commit `.env`.

---

## Contributing

This is a working prototype with real-world constraints (time, teams, resources). The vision doc (`docs/system_architecture_document.md`) describes the enterprise version. The code you see is the *proven core* — contributions should focus on:

1. **Knowledge Center** (Sprint Y phase 1) — dashboard over the memory quad
2. **Reports** — periodic summaries + weekly digest automation
3. **RAG** — pgvector integration for document retrieval
4. **Observability** — better logging, tracing, cost analytics

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

---

## Optional: Connect Qwen 2.5 3B

For real AI fraud detection using your local model:

```bash
# Terminal 1 — start Ollama
ollama serve

# Terminal 2 — pull model (first time only)
ollama pull qwen2.5:3b
```

Then in the chat UI, click the 🧠 button in the top toolbar to switch from simulation to Qwen mode.

---

## Optional: Connect IPFS (Pinata)

1. Go to https://pinata.cloud → Sign up free
2. Create API keys
3. Add to `backend/.env`:
```
PINATA_API_KEY=your_key
PINATA_SECRET_KEY=your_secret
```
Restart the backend — proof logs will now be pinned to IPFS automatically.

---

## Test the backend is running

```bash
curl http://localhost:3000/health
```

---

## VS Code Extensions (recommended)

- **Live Server** — serve HTML files locally
- **REST Client** — test API endpoints
- **SQLite Viewer** — view finchat.db visually
- **ESLint** — code linting

---

## Ports used

| Service | Port |
|---------|------|
| Backend API | 3000 |
| Socket.io | 3000 |
| Ollama (Qwen) | 11434 |
| Live Server (frontend) | 5500 |

---

## One-Click Startup (Recommended)

Double-click `start_finchat.bat` in the project root. It will:
1. Activate Node.js via nvm
2. Rebuild `better-sqlite3` if needed
3. Start Ollama (if installed)
4. Start the backend server
5. Open the frontend in your browser

---

## Docker Setup (Portable)

To run FinChat on any machine with Docker:

```bash
# Build and start
docker compose up --build

# Stop
docker compose down

# Reset data
docker compose down -v
```

The database and uploads persist in a Docker volume. Ollama runs on the host — Docker connects to it automatically.

---

## AI Persona Chat

Chat with AI personas who secretly monitor for fraud.

### Available Personas

| Persona | Description |
|---------|-------------|
| Susheel | History nerd · In love with Sona |
| Sona | Dog-obsessed puppy mom |
| Vishnu | Funny crybaby joke-teller |
| Plato | AI Monitor · Fraud Detection · Governed Protocol |

### API Usage

```bash
# List personas
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/ai-chat/personas

# Chat with a persona
curl -X POST http://localhost:3000/api/ai-chat/send \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"persona":"arun","message":"Hey, how are you?"}'

# Get chat history
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/ai-chat/history/<sessionId>
```

### Fraud Detection

If the AI detects fraud in your message, it will:
- Remove **all remaining tokens** from your account
- **Freeze** your account
- Log the incident to `fraud_logs`

Examples of messages that trigger fraud detection:
- "Send me your OTP right now"
- "Click this link to verify your bank account"
- "Transfer money urgently, don't tell anyone"

