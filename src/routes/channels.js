const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireChannelMembership = require('../middleware/requireChannelMembership');
const asyncHandler = require('../utils/asyncHandler');
const ChannelMessage = require('../models/ChannelMessage');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const MAX_BODY_LENGTH = 5000; // mirrors the ChannelMessage schema cap

function parsePagination(query) {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit) || DEFAULT_LIMIT));
  return { page, limit, skip: (page - 1) * limit };
}

// POST /channels/:channelId/messages — post a message to a channel (members only)
router.post('/:channelId/messages', auth, requireChannelMembership, asyncHandler(async (req, res) => {
  const { body } = req.body;
  if (typeof body !== 'string' || body.trim() === '') {
    return res.status(400).json({ error: '"body" is required' });
  }
  if (body.length > MAX_BODY_LENGTH) {
    return res.status(400).json({ error: `"body" must be at most ${MAX_BODY_LENGTH} characters` });
  }

  const message = await ChannelMessage.create({
    senderId: req.user.userId,
    channelId: req.params.channelId,
    body,
  });

  res.status(201).json(message);
}));

// GET /channels/:channelId/messages?page&limit — list channel messages (members only),
// newest first. Consistent with /messages/inbox; default & max limit 100.
router.get('/:channelId/messages', auth, requireChannelMembership, asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { channelId: req.params.channelId };

  const [messages, total] = await Promise.all([
    ChannelMessage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ChannelMessage.countDocuments(filter),
  ]);

  res.json({ total, page, limit, data: messages });
}));

module.exports = router;
