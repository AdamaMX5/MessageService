const { verifyToken } = require('../services/jwtService');

// Requires a valid Bearer JWT. Attaches decoded payload to req.user.
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    req.user = { userId: payload.sub, email: payload.email, roles: payload.roles || [] };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = auth;
