const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const Message = require('../models/Message');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const EMAIL_ERROR = 'User IDs must be used, not email addresses. Please use the user\'s ID instead of their email.'

// GET /admin/messages — list all messages with optional filters
router.get('/messages', requireAdmin, async (req, res) => {
  const { senderId, recipientId, page = 1, limit = DEFAULT_LIMIT } = req.query;

  if (senderId    && senderId.includes('@'))    return res.status(400).json({ error: EMAIL_ERROR });
  if (recipientId && recipientId.includes('@')) return res.status(400).json({ error: EMAIL_ERROR });

  const filter = {};
  if (senderId)    filter.senderId    = senderId;
  if (recipientId) filter.recipientId = recipientId;

  const cappedLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit)));
  const skip = (Math.max(1, Number(page)) - 1) * cappedLimit;

  const [messages, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(cappedLimit),
    Message.countDocuments(filter),
  ]);

  res.json({ total, page: Number(page), limit: cappedLimit, messages });
});

// DELETE /admin/messages/:id — hard-delete any message
router.delete('/messages/:id', requireAdmin, async (req, res) => {
  const message = await Message.findByIdAndDelete(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json({ deleted: true });
});

module.exports = router;
