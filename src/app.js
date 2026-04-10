const express = require('express');
const { refreshPublicKey } = require('./services/jwtService');
const requireAdmin = require('./middleware/requireAdmin');
const messagesRouter = require('./routes/messages');
const adminRouter = require('./routes/admin');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send("Hello World! i'm the MessageService");
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MessageService' });
});

// Force-refresh the cached JWT public key after key rotation
app.post('/refresh-key', requireAdmin, async (req, res) => {
  await refreshPublicKey();
  res.json({ refreshed: true });
});

app.use('/messages', messagesRouter);
app.use('/admin', adminRouter);

// Central error handler — keeps stack traces out of API responses
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
