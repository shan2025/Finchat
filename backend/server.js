// server.js — FinChat Backend
// Express REST API + Socket.io real-time chat
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getDB } = require('./database');

const app = express();
const server = http.createServer(app);

// ── Socket.io setup ──────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:5500',
      'http://localhost:3000',
      'http://127.0.0.1:5500',
      'null' // for opening HTML files directly
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ── Express middleware ───────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5500',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'null'
  ],
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

// Health check
app.get('/health', async (req, res) => {
  const db = getDB();
  const { isReachable } = require('./services/solana');
  const solanaConnected = await isReachable();
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
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
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const user = db.prepare('SELECT id, name, role, token_balance FROM users WHERE id = ?').get(decoded.userId);
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

  // Init Solana devnet connection + auto-airdrop
  const { initSolana } = require('./services/solana');
  await initSolana();

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
