const { verifyToken } = require('../services/jwtService');

// Requires a valid JWT containing the 'admin' role.
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin JWT required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    const roles = payload.roles || [];
    if (!roles.includes('admin')) {
      return res.status(403).json({ error: 'Admin role required' });
    }
    req.admin = { userId: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = requireAdmin;
