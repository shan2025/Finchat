// middleware/auth.js — JWT verification + role guard + in-memory TTL cache
const jwt = require('jsonwebtoken');
const { query } = require('../database');

// In-memory user cache to eliminate N+1 DB round-trips on protected endpoints
const _userCache = new Map();
const CACHE_TTL_MS = 60_000; // 60 seconds

function getCachedUser(userId) {
  const entry = _userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    _userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  // Prevent unbounded memory growth if millions of users (keep max 5000 entries)
  if (_userCache.size > 5000) {
    const firstKey = _userCache.keys().next().value;
    _userCache.delete(firstKey);
  }
  _userCache.set(userId, { user, timestamp: Date.now() });
}

function clearUserCache(userId = null) {
  if (userId) {
    _userCache.delete(userId);
  } else {
    _userCache.clear();
  }
}

// Verify JWT token on every protected route
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check user in memory cache first (eliminates 95% of slow DB queries)
    let user = getCachedUser(decoded.userId);
    if (!user) {
      const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [decoded.userId]);
      user = resUser.rows[0];
      if (user) {
        setCachedUser(decoded.userId, user);
      }
    }

    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = {
      id: user.user_id || user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      wallet: user.wallet_address,
      tokenBalance: user.token_balance,
      isFrozen: !!user.is_frozen
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role guard — usage: requireRole('admin') or requireRole(['admin','auditor'])
function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied — requires role: ${allowed.join(' or ')}`
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, clearUserCache };
