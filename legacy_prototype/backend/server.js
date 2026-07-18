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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend statically
app.use(express.static(path.join(__dirname, '../frontend')));

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

// Health check
app.get('/health', async (req, res) => {
  const { isReachable } = require('./services/solana');
  const solanaConnected = await isReachable();
  const resUsers = await query('SELECT COUNT(*) as c FROM users');
  const resMsgs = await query('SELECT COUNT(*) as c FROM messages');
  const userCount = resUsers.rows[0].c;
  const msgCount = resMsgs.rows[0].c;
  res.json({
    status: 'ok',
    service: 'FinChat Backend',
    version: '0.2.0',
    users: userCount,
    messages: msgCount,
    uptime: process.uptime().toFixed(1) + 's',
    solana_connected: solanaConnected
  });
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
