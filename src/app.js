const express = require('express');
const { refreshPublicKey } = require('./services/jwtService');
const requireAdmin = require('./middleware/requireAdmin');
const asyncHandler = require('./utils/asyncHandler');
const messagesRouter = require('./routes/messages');
const channelsRouter = require('./routes/channels');
const adminRouter = require('./routes/admin');
const { ChannelNotFoundError } = require('./services/channelService');

const app = express();

// Request logging middleware — logs once per request, on completion.
// We log the path only (not the query string) to keep user ids out of the logs.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });
  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.send("Hello World! i'm the MessageService");
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MessageService' });
});

// Force-refresh the cached JWT public key after key rotation
app.post('/refresh-key', requireAdmin, asyncHandler(async (req, res) => {
  await refreshPublicKey();
  res.json({ refreshed: true });
}));

app.use('/messages', messagesRouter);
app.use('/channels', channelsRouter);
app.use('/admin', adminRouter);

// Central error handler — keeps stack traces out of API responses
app.use((err, req, res, next) => {
  // A channel can disappear between an authorization check and a write (TOCTOU);
  // surface that as 404 rather than a generic 500.
  if (err instanceof ChannelNotFoundError) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  console.error(`${new Date().toISOString()} - ERROR: ${err.message}`);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
