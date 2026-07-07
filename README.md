# FinChat — Governed Messaging System
### Prototype v0.2

A full-stack internal messaging system with:
- 🔐 Phantom wallet login + email/password auth
- 🤖 AI fraud detection via Qwen 2.5 3B (Ollama)
- 🧠 **Hybrid Zero-Knowledge Proofs** — Groth16 (audit) + SHA-256 (instant)
- 🔗 Proof of conversation (SHA-256 hash chaining)
- 📌 IPFS storage via Pinata
- ⛓️ Solana devnet blockchain anchoring
- 🪙 Token governance (spend, penalties, freeze)
- 📎 File attachments
- ✅ Read receipts

---

## Project Structure

```
finchat/
├── frontend/
│   ├── finchat_login.html   ← Login, register, wallet auth, onboarding
│   └── finchat_chat.html    ← Main chat UI
│
├── backend/
│   ├── server.js            ← Express + Socket.io
│   ├── database.js          ← SQLite schema
│   ├── package.json
│   ├── .env.example         ← Copy to .env
│   ├── routes/
│   │   ├── auth.js          ← Login, register, wallet
│   │   └── messages.js      ← Send, fetch, proof, fraud
│   ├── middleware/
│   │   └── auth.js          ← JWT verification
│   └── services/
│       ├── fraud.js         ← Qwen / fallback detection
│       ├── proof.js         ← Hash chaining
│       ├── ipfs.js          ← Pinata IPFS
│       └── solana.js        ← Solana devnet
│
└── README.md                ← This file
```

---

## Quick Start (5 steps)

### Step 1 — Install Node dependencies
```bash
cd backend
npm install
```

### Step 2 — Set up environment
```bash
cp .env.example .env
```
Open `.env` and change `JWT_SECRET` to any long random string.
Everything else works with defaults for local dev.

### Step 3 — Start the backend
```bash
# Still inside /backend
npm run dev
```
You should see:
```
╔══════════════════════════════════════╗
║   FinChat Backend  v0.2.0            ║
╠══════════════════════════════════════╣
║   REST API  →  http://localhost:3000 ║
║   Socket.io →  ws://localhost:3000   ║
╚══════════════════════════════════════╝
```

### Step 4 — Open the frontend
Open `frontend/finchat_login.html` in your browser.

**Easiest way:** Install the VS Code extension **"Live Server"**
→ Right-click `finchat_login.html` → **"Open with Live Server"**

Or just double-click the file to open it directly.

### Step 5 — Log in
Use these demo accounts or register a new one:

| Email | Password | Role |
|-------|----------|------|
| `admin@finchat.com` | `Admin123!` | Admin |
| `staff@finchat.com` | `Staff123!` | Staff |
| `auditor@finchat.com` | `Audit123!` | Auditor |

> **Note:** Demo accounts only exist in the frontend mock.
> To use the real backend, register a new account — it will be saved to `finchat.db`.

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

