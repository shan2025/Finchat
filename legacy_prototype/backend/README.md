# FinChat Backend — Setup Guide

## Stack
- **Node.js + Express** — REST API
- **Socket.io** — Real-time messaging
- **SQLite (better-sqlite3)** — Local database (zero setup)
- **IPFS via Pinata** — Decentralized proof storage
- **Solana devnet** — Blockchain anchoring
- **Qwen 2.5 7B via Ollama** — AI fraud detection
- **bcrypt + JWT** — Auth & sessions

---

## 1. Install dependencies

```bash
cd finchat-backend
npm install
```

---

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the only required change for local dev is JWT_SECRET.
Everything else works out of the box with defaults.

### For IPFS (optional but recommended):
1. Go to https://pinata.cloud and create a free account
2. Get your API Key and Secret Key
3. Add them to `.env`:
```
PINATA_API_KEY=your_key_here
PINATA_SECRET_KEY=your_secret_here
```

### For Qwen fraud detection:
```bash
# In a separate terminal:
ollama serve
ollama run qwen2.5:7b
```

---

## 3. Start the server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

Server starts at: **http://localhost:3000**

---

## 4. Test it's working

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "FinChat Backend",
  "version": "0.2.0",
  "users": 0,
  "messages": 0
}
```

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Email + password login |
| POST | `/api/auth/wallet` | MetaMask wallet login |
| GET  | `/api/auth/me` | Get current user |
| POST | `/api/auth/logout` | Logout |

### Messages
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/messages/channels` | List all channels |
| GET  | `/api/messages/:channelId` | Get message history |
| POST | `/api/messages/:channelId` | Send message + files |
| GET  | `/api/messages/:channelId/proof` | Get proof chain |
| GET  | `/api/messages/:channelId/fraud` | Get fraud logs (admin/auditor) |
| GET  | `/api/messages/tokens/ledger` | Get token balance + history |

### Register payload
```json
{
  "name": "Jane Doe",
  "email": "jane@company.com",
  "password": "SecurePass123!",
  "role": "staff",
  "walletAddress": "0x..." // optional
}
```

### Login payload
```json
{
  "email": "jane@company.com",
  "password": "SecurePass123!"
}
```

### Send message payload
```
POST /api/messages/general
Authorization: Bearer <jwt_token>
Content-Type: multipart/form-data

content: "Hello team"
files: [file1, file2]  // optional
```

---

## Socket.io Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `join_channel` | channelId | Join a channel room |
| `leave_channel` | channelId | Leave a channel room |
| `typing_start` | channelId | User started typing |
| `typing_stop` | channelId | User stopped typing |
| `broadcast_message` | {channelId, message} | Broadcast sent message |
| `read_receipt` | {channelId, messageId} | Mark message as read |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `new_message` | message object | New message received |
| `user_joined` | {userId, name, role} | User joined channel |
| `user_left` | {userId, name} | User left channel |
| `user_typing` | {userId, name} | Someone is typing |
| `online_users` | array | List of online users |
| `proof_confirmed` | {proofId, ipfsCid, solanaTx} | Async proof anchored |
| `message_read` | {messageId, readBy} | Read receipt |

---

## Database (SQLite)

File: `finchat.db` (auto-created on first run)

Tables:
- `users` — accounts, roles, token balances
- `channels` — general, compliance, audit-log
- `messages` — all messages
- `proof_chain` — SHA-256 hash chain + IPFS + Solana refs
- `fraud_logs` — AI scan results per message
- `token_ledger` — full token transaction history
- `files` — file attachments + IPFS refs
- `sessions` — JWT session tracking

---

## Role Permissions

| Feature | Admin | Staff | Auditor | User |
|---------|-------|-------|---------|------|
| Send messages | ✅ | ✅ | ❌ | ✅ |
| View messages | ✅ | ✅ | ✅ | ✅ |
| View fraud logs | ✅ | ❌ | ✅ | ❌ |
| View proof chain | ✅ | ✅ | ✅ | ✅ |
| Governance controls | ✅ | ❌ | ❌ | ❌ |

---

## Connect the frontend

In `finchat_login.html`, update `openChat()`:
```js
window.location.href = 'finchat_chat.html';
```

In `finchat_chat.html`, set the API URL at the top of the script:
```js
const API_URL = 'http://localhost:3000';
const SOCKET_URL = 'http://localhost:3000';
```

---

## Production checklist
- [ ] Change `JWT_SECRET` to a long random string
- [ ] Add real Pinata API keys
- [ ] Switch Solana to mainnet in `.env`
- [ ] Replace SQLite with PostgreSQL
- [ ] Add HTTPS (Let's Encrypt / nginx)
- [ ] Set `NODE_ENV=production`
