// middleware/auth.js — JWT verification + role guard
const jwt = require('jsonwebtoken');
const { query } = require('../database');

// Verify JWT token on every protected route
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check user still exists
    const resUser = await query('SELECT *, user_id as id FROM users WHERE user_id = $1', [decoded.userId]);
    const user = resUser.rows[0];
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

module.exports = { requireAuth, requireRole };
