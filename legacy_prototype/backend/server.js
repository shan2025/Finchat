// server.js — FinChat Backend Server
// Express REST API + Socket.io real-time chat
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getDB, query } = require('./database');

// ── Boot guard ───────────────────────────────────────────────
// Every protected route and the Socket.io handshake verify against
// process.env.JWT_SECRET with no fallback, so a missing secret does not
// degrade — it makes every login mint a token nobody can verify. Fail here,
// loudly, instead of booting into a service where authentication silently
// rejects everyone.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET is missing or shorter than 32 characters. Refusing to start.');
  console.error('   Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── CORS allowlist ───────────────────────────────────────────
// Previously every origin was reflected back, which let any website on the
// internet call this API with a victim's bearer token. The allowlist is
// explicit: ALLOWED_ORIGINS (comma-separated) plus FRONTEND_URL. Outside
// production, localhost on any port is also accepted so the app can be opened
// from a dev server without editing env files.
const ALLOWED_ORIGINS = new Set(
  [...(process.env.ALLOWED_ORIGINS || '').split(','), process.env.FRONTEND_URL]
    .map(s => (s || '').trim().replace(/\/$/, ''))
    .filter(Boolean)
);

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * A request with no Origin header is same-origin, a native client, or a
 * server-to-server call — the browser only sends Origin on cross-origin
 * requests, so there is nothing to protect against here. The literal string
 * "null" is NOT in that category: it is what sandboxed iframes and file://
 * pages send, and it is rejected.
 */
function isOriginAllowed(origin) {
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, '');
  if (ALLOWED_ORIGINS.has(normalized)) return true;
  if (!IS_PRODUCTION && LOCALHOST_ORIGIN.test(normalized)) return true;
  return false;
}

function corsOriginCallback(origin, callback) {
  if (isOriginAllowed(origin)) return callback(null, true);
  console.warn(`🚫 CORS: rejected origin "${origin}"`);
  // Tagged so the error handler answers 403 instead of logging a rejected
  // origin as a server fault and returning 500.
  const err = new Error('Origin not allowed by CORS policy');
  err.status = 403;
  return callback(err);
}

const app = express();

// Render terminates TLS in front of the container, so the client IP arrives in
// X-Forwarded-For. Without this the rate limiters below bucket every request
// under the proxy's address and one busy user throttles everyone.
app.set('trust proxy', 1);

const server = http.createServer(app);

// ── Socket.io setup ──────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: corsOriginCallback,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ── Express middleware ───────────────────────────────────────
// Security headers. Tailwind is now a prebuilt stylesheet rather than a
// runtime compiler, and Socket.io is served from this origin, so 'unsafe-eval'
// and both of those CDN hosts are gone. 'unsafe-inline' has to stay until the
// inline <script> blocks on all 17 pages move into files.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      // jsdelivr is not listed here: the only things still loaded from it are
      // marked and DOMPurify, which are scripts.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  // Cross-origin isolation would block the CDN assets above.
  crossOriginEmbedderPolicy: false,
  // Match the CSP's frame-ancestors 'none' for browsers that only honour the
  // legacy header; helmet's default here is SAMEORIGIN.
  frameguard: { action: 'deny' }
}));

app.use(cors({
  origin: corsOriginCallback,
  credentials: true
}));

// ── Rate limiting ────────────────────────────────────────────
// Credential endpoints get a tight bucket keyed on IP: login, register and the
// password-reset pair were previously unthrottled, so credential stuffing and
// reset-code brute force were bounded only by network speed. Counting only
// failures keeps a legitimate user who logs in repeatedly from locking
// themselves out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' }
});

// A wide backstop for everything else. Sized well above what the UI does at
// rest (several pages poll) so it catches scripted abuse, not normal use.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
  // The external scheduler drives these with a shared secret and legitimately
  // bursts through the whole mission list on one tick.
  skip: (req) => req.path.startsWith('/api/cron')
});

// Gzip every text response. The chat page alone is ~200KB of HTML that
// compresses to roughly a seventh of that.
app.use(compression());

// `verify` stashes the unparsed body. Meta signs the exact bytes it sent
// (X-Hub-Signature-256), so routes/whatsappWebhook.js cannot re-serialise
// req.body to check it — key order and spacing would differ and every
// legitimate webhook would look forged.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend statically.
//
// HTML and JS keep Cache-Control: no-cache, which forces revalidation (cheap
// 304s via ETag) — without it browsers heuristically cache shared JS like
// sidebar_nav.js for hours, so new nav items (Group Chat, Blockchain,
// Settings) never appear.
//
// Images and fonts get the opposite treatment. They are content-stable and
// were costing a revalidation round-trip each, on every page of a multi-page
// app where every navigation is a fresh document. Rename the file to bust.
const IMMUTABLE_ASSET = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i;

app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res, filePath) => {
    if (IMMUTABLE_ASSET.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Redirect root to login
app.get('/', (req, res) => {
  res.redirect('/finchat_login.html');
});

// ── Routes ───────────────────────────────────────────────────
app.use('/api', apiLimiter);

// Credential and account-recovery endpoints, before the router that serves
// them. `/wallet` is included because it mints the same session token.
for (const p of ['/api/auth/login', '/api/auth/register', '/api/auth/forgot', '/api/auth/reset', '/api/auth/wallet']) {
  app.use(p, authLimiter);
}

app.use('/api/auth', require('./routes/auth'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/ai-chat', require('./routes/aiChat'));
app.use('/api/tokens', require('./routes/tokens'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/executions', require('./routes/executions'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/neural-map', require('./routes/neuralMap'));
app.use('/api/search', require('./routes/search'));
app.use('/api/missions', require('./routes/missions'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/group-chat', require('./routes/groupChat'));
app.use('/api/blockchain', require('./routes/blockchain'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/mind-maps', require('./routes/mindMaps'));
// External-scheduler triggers (shared-secret auth, not user JWT) — lets missions
// and briefings fire on a host that sleeps when idle. See routes/cron.js.
app.use('/api/cron', require('./routes/cron'));
// Inbound WhatsApp (provider-signed, no user JWT). Carries the link
// confirmations and the 24-hour-window clock. See routes/whatsappWebhook.js.
app.use('/api/whatsapp', require('./routes/whatsappWebhook'));

// ── EventBus → Socket.io Real-Time Agent Pulse ───────────────
// Each event is addressed to one user's room rather than broadcast. The event
// map and the routing rule live in services/realtime.js so they can be tested
// without booting the server — see test/realtime.test.js.
const { eventBus } = require('./services/cognitive/EventBus');
const { stateMachineEvents } = require('./services/cognitive/StateMachine');
const { userRoom, attachEventBridges } = require('./services/realtime');

attachEventBridges({ io, eventBus, stateMachineEvents });

// ── Sprint 8 — Group chat relays (room = group:<groupId>) ────
eventBus.on('group:message', (msg) => {
  io.to(`group:${msg.group_id}`).emit('group:message', msg);
});
eventBus.on('group:typing', (info) => {
  io.to(`group:${info.group_id}`).emit('group:typing', info);
});

// Health check.
// Must never throw: an unhandled rejection here takes down the whole process,
// which turns a transient DB blip into a permanent crash-loop (the platform
// health probe restarts the container, probes again, and kills it again).
// Degrade to 503 with a diagnosis instead.
app.get('/health', async (req, res) => {
  const base = {
    service: 'FinChat Backend',
    version: '0.2.0',
    uptime: process.uptime().toFixed(1) + 's'
  };

  let solanaConnected = false;
  try {
    const { isReachable } = require('./services/solana');
    solanaConnected = await isReachable();
  } catch (err) {
    solanaConnected = false;
  }

  try {
    const resUsers = await query('SELECT COUNT(*) as c FROM users');
    const resMsgs = await query('SELECT COUNT(*) as c FROM messages');
    res.json({
      ...base,
      status: 'ok',
      users: resUsers.rows[0].c,
      messages: resMsgs.rows[0].c,
      solana_connected: solanaConnected
    });
  } catch (err) {
    console.error('❌ Health check: database unreachable:', err.message);
    res.status(503).json({
      ...base,
      status: 'degraded',
      database: 'unreachable',
      error: err.message,
      solana_connected: solanaConnected
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// Error handler.
// `err.status` lets middleware reject a request on its own terms — a blocked
// CORS origin is a 403 the client caused, not a 500 the server suffered. The
// message is only echoed for those deliberate 4xx rejections; unexpected
// errors still surface as a generic 500 so internals do not leak.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('Server error:', err.message);
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message
  });
});

// ── Socket.io — Real-time events ────────────────────────────
const onlineUsers = new Map(); // socketId → { userId, name, role, channelId }

// JWT auth for socket connections
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const resUser = await query('SELECT user_id as id, name, role, token_balance FROM users WHERE user_id = $1', [decoded.userId]);
    const user = resUser.rows[0];
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;

  // Private room for this account, joined from the JWT-verified identity and
  // never from anything the client sends. Every notification, agent pulse and
  // graph pulse is addressed here, so a user's tabs — and only theirs —
  // receive their own events.
  socket.join(userRoom(user.id));

  console.log(`🔌 Connected: ${user.name} (${user.role}) — ${socket.id}`);

  // ── Join channel ─────────────────────────────────────────
  socket.on('join_channel', (channelId) => {
    socket.join(channelId);
    onlineUsers.set(socket.id, { ...user, channelId });

    // Notify channel of new user
    socket.to(channelId).emit('user_joined', {
      userId: user.id,
      name: user.name,
      role: user.role
    });

    // Send current online users to the joiner
    const inChannel = [...onlineUsers.values()].filter(u => u.channelId === channelId);
    socket.emit('online_users', inChannel);

    console.log(`📢 ${user.name} joined #${channelId}`);
  });

  // ── Group chat rooms (Sprint 8) ──────────────────────────
  socket.on('join_group', (groupId) => {
    if (typeof groupId === 'string' && groupId.startsWith('grp_')) socket.join(`group:${groupId}`);
  });
  socket.on('leave_group', (groupId) => {
    if (typeof groupId === 'string') socket.leave(`group:${groupId}`);
  });

  // ── Leave channel ────────────────────────────────────────
  socket.on('leave_channel', (channelId) => {
    socket.leave(channelId);
    socket.to(channelId).emit('user_left', { userId: user.id, name: user.name });
  });

  // ── Typing indicators ────────────────────────────────────
  socket.on('typing_start', (channelId) => {
    socket.to(channelId).emit('user_typing', { userId: user.id, name: user.name });
  });

  socket.on('typing_stop', (channelId) => {
    socket.to(channelId).emit('user_stopped_typing', { userId: user.id });
  });

  // ── Broadcast new message to channel ─────────────────────
  // (Called by the REST route after saving — keeps REST as source of truth)
  socket.on('broadcast_message', ({ channelId, message }) => {
    socket.to(channelId).emit('new_message', message);
  });

  // ── Proof update (IPFS / Solana confirmed) ───────────────
  socket.on('proof_update', ({ channelId, proofId, ipfsCid, solanaTx }) => {
    io.to(channelId).emit('proof_confirmed', { proofId, ipfsCid, solanaTx });
  });

  // ── Read receipt ─────────────────────────────────────────
  socket.on('read_receipt', ({ channelId, messageId }) => {
    socket.to(channelId).emit('message_read', {
      messageId,
      readBy: { userId: user.id, name: user.name }
    });
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const info = onlineUsers.get(socket.id);
    if (info?.channelId) {
      socket.to(info.channelId).emit('user_left', { userId: user.id, name: user.name });
    }
    onlineUsers.delete(socket.id);
    console.log(`🔌 Disconnected: ${user.name}`);
  });
});

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  // Init DB on startup
  getDB();

  // Ensure avatar_url column exists in users table
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;');
  } catch (err) {
    console.error('Note: could not ensure avatar_url column:', err.message);
  }

  // Ensure system persona rows exist to satisfy foreign key constraints on messages table
  const personasToSeed = ['PLATO', 'AURELIUS', 'RASHA', 'NOVA', 'SYSTEM', 'plato', 'aurelius', 'rasha', 'nova', 'system'];
  for (const pid of personasToSeed) {
    try {
      await query(`
        INSERT INTO users (user_id, email, name, role, token_balance)
        VALUES ($1, $2, $3, 'system', 999999)
        ON CONFLICT (user_id) DO NOTHING
      `, [pid, `${pid}_${Date.now()}_sys@system.finchat.local`, pid.toUpperCase()]);
    } catch (e) {}
  }

  // Init Solana devnet connection + auto-airdrop
  const { initSolana } = require('./services/solana');
  await initSolana();

  // Sweep executions orphaned in 'running'/'ready' (e.g. by a crash) so agent
  // status doesn't report WORKING forever; repeat every 5 minutes.
  const { sweepStaleExecutions } = require('./services/cognitive/ExecutionManager');
  try { await sweepStaleExecutions(); } catch (e) { console.error('Stale-execution sweep failed:', e.message); }
  setInterval(() => sweepStaleExecutions().catch(e => console.error('Stale-execution sweep failed:', e.message)), 5 * 60 * 1000);

  // Sprint 7: start the BullMQ worker (missions + briefings + queued chats) and
  // register one repeatable job per ENABLED mission. Seeds ship disabled, so
  // nothing burns tokens until the user flips a mission on.
  try {
    const { startWorkerPool } = require('./services/queue/WorkerPool');
    startWorkerPool();
    const { syncMissionSchedules } = require('./services/agents/MissionScheduler');
    const sync = await syncMissionSchedules();
    console.log(`🗓️ Mission scheduler ready — ${sync.scheduled} enabled mission(s) scheduled`);
  } catch (e) {
    console.error('⚠️ Mission scheduler init failed (missions will not fire until restart):', e.message);
  }

  // Sprint X: dream cycle — consolidate the knowledge graph every 6 hours
  // (merge duplicates, decay stale edges, surface knowledge gaps).
  // Per-user: the graph-wide consolidation runs once, then each user's graph
  // gets its own gap/community pass and its own live neural-map pulse. A single
  // ownerless dream() cannot be delivered to anyone without broadcasting one
  // user's entity names to every browser.
  const { dreamAllUsers } = require('./services/cognitive/MemoryEngine');
  setInterval(() => dreamAllUsers().catch(e => console.error('Dream cycle failed:', e.message)), 6 * 60 * 60 * 1000);

  // Sprint X · Stage 4: nightly dream digest — consolidate, then tell each
  // active user what changed ("While you were away: merged 3, learned 12…")
  // via their configured notification channels + a Reports snapshot.
  const { runNightlyDigest } = require('./services/cognitive/DreamDigest');
  setInterval(
    () => runNightlyDigest({}).catch(e => console.error('Dream digest failed:', e.message)),
    24 * 60 * 60 * 1000
  );

  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   FinChat Backend  v0.2.0            ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║   REST API  →  http://localhost:${PORT}  ║`);
  console.log(`║   Socket.io →  ws://localhost:${PORT}    ║`);
  console.log(`║   Health    →  /health               ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});

module.exports = { app, io };

