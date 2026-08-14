// server.js — FinChat Backend Server
// Express REST API + Socket.io real-time chat
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getDB, query } = require('./database');

const app = express();
const server = http.createServer(app);

// ── Socket.io setup ──────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      callback(null, true);
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ── Express middleware ───────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Allow all origins (including null for file://)
    callback(null, true);
  },
  credentials: true
}));

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
// Cache-Control: no-cache forces revalidation (cheap 304s via ETag) — without
// it browsers heuristically cache shared JS like sidebar_nav.js for hours,
// so new nav items (Group Chat, Blockchain, Settings) never appear.
app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// Redirect root to login
app.get('/', (req, res) => {
  res.redirect('/finchat_login.html');
});

// ── Routes ───────────────────────────────────────────────────
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
const { eventBus } = require('./services/cognitive/EventBus');
const { stateMachineEvents } = require('./services/cognitive/StateMachine');

stateMachineEvents.on('execution:created', (data) => {
  io.emit('agent_status_pulse', { type: 'created', ...data });
});

eventBus.on('execution:waiting', (data) => {
  io.emit('agent_status_pulse', { type: 'waiting', ...data });
});

eventBus.on('execution:completed', (data) => {
  io.emit('agent_status_pulse', { type: 'completed', ...data });
});

eventBus.on('execution:resumed', (data) => {
  io.emit('agent_status_pulse', { type: 'resumed', ...data });
});

eventBus.on('briefing:completed', (data) => {
  io.emit('agent_status_pulse', { type: 'briefing_completed', ...data });
});

// ── Sprint X · Cognitive Memory Engine — live graph pulses ───
// The neural map listens for these to make nodes glow while the AI thinks.
eventBus.on('graph:activation', (data) => {
  io.emit('graph_pulse', { type: 'activation', ...data });
});
eventBus.on('memory:ingested', (data) => {
  io.emit('graph_pulse', { type: 'learned', ...data });
});
eventBus.on('memory:dream_completed', (data) => {
  io.emit('graph_pulse', { type: 'dream', ...data });
});

// ── Sprint 5 · Phase 5A — Multi-Agent Debate pulses ──────────
eventBus.on('debate:started', (data) => {
  io.emit('agent_status_pulse', { type: 'debate_started', ...data });
});

eventBus.on('debate:positions_gathered', (data) => {
  io.emit('agent_status_pulse', { type: 'debate_positions', ...data });
});

eventBus.on('debate:conflict', (data) => {
  io.emit('agent_status_pulse', { type: 'debate_conflict', ...data });
});

eventBus.on('debate:round', (data) => {
  io.emit('agent_status_pulse', { type: 'debate_round', ...data });
});

eventBus.on('debate:completed', (data) => {
  io.emit('agent_status_pulse', { type: 'debate_completed', ...data });
});

// ── Live notification bell push ──────────────────────────────
eventBus.on('notification:new', (row) => {
  // Deliver to the owning user's sockets (fallback: broadcast so open tabs refresh)
  io.emit('notification:new', row);
});

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

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
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
  const { dream } = require('./services/cognitive/MemoryEngine');
  setInterval(() => dream({}).catch(e => console.error('Dream cycle failed:', e.message)), 6 * 60 * 60 * 1000);

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

