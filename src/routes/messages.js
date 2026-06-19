const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const parsePagination = require('../utils/pagination');
const Message = require('../models/Message');

const PAGINATION = { defaultLimit: 20, maxLimit: 100 };

const EMAIL_ERROR = 'User IDs must be used, not email addresses. Please use the user\'s ID instead of their email.'

function containsEmail(value) {
  return typeof value === 'string' && value.includes('@');
}

// Rejects non-string ids/bodies before they reach a query — closes the NoSQL
// operator-injection surface (e.g. { "$ne": null }) on user-supplied fields.
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// POST /messages — send a message
router.post('/', auth, asyncHandler(async (req, res) => {
  const { recipientId, body } = req.body;
  if (!isNonEmptyString(recipientId) || !isNonEmptyString(body)) {
    return res.status(400).json({ error: '"recipientId" and "body" are required' });
  }
  if (containsEmail(recipientId)) {
    return res.status(400).json({ error: EMAIL_ERROR });
  }

  const message = await Message.create({
    senderId: req.user.userId,
    recipientId,
    body,
  });

  res.status(201).json(message);
}));

// GET /messages/unread-count — number of unread messages for the authenticated user
// Kept as a dedicated, index-backed query because it is called on every client startup
// and after every notification event from the PresenceService.
router.get('/unread-count', auth, asyncHandler(async (req, res) => {
  const count = await Message.countDocuments({
    recipientId: req.user.userId,
    readAt: null,
    deletedByRecipient: false,
  });
  res.json({ count });
}));

// GET /messages/inbox — received messages, newest first
router.get('/inbox', auth, asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, PAGINATION);
  const unreadOnly = req.query.unreadOnly === 'true';

  const filter = { recipientId: req.user.userId, deletedByRecipient: false };
  if (unreadOnly) filter.readAt = null;

  const [messages, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);

  res.json({ total, page, limit, messages });
}));

// GET /messages/sent — sent messages, newest first
router.get('/sent', auth, asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, PAGINATION);

  const filter = { senderId: req.user.userId, deletedBySender: false };

  const [messages, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);

  res.json({ total, page, limit, messages });
}));

// GET /messages/conversation/:userId — all messages between the caller and a specific user,
// in both directions, sorted chronologically (oldest first).
router.get('/conversation/:userId', auth, asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, PAGINATION);
  const me    = req.user.userId;
  const other = req.params.userId;

  if (containsEmail(other)) {
    return res.status(400).json({ error: EMAIL_ERROR });
  }

  const filter = {
    $or: [
      { senderId: me,    recipientId: other, deletedBySender:    false },
      { senderId: other, recipientId: me,    deletedByRecipient: false },
    ],
  };

  const [messages, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);

  res.json({ total, page, limit, messages });
}));

// PATCH /messages/:id/read — mark a single message as read (recipient only)
router.patch('/:id/read', auth, asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.recipientId !== req.user.userId) {
    return res.status(403).json({ error: 'Only the recipient can mark a message as read' });
  }

  message.readAt = message.readAt || new Date();
  await message.save();
  res.json(message);
}));

// PATCH /messages/read-all — mark all messages from a sender as read
router.patch('/read-all', auth, asyncHandler(async (req, res) => {
  const { senderId } = req.body;
  if (!isNonEmptyString(senderId)) return res.status(400).json({ error: '"senderId" is required' });
  if (containsEmail(senderId)) return res.status(400).json({ error: EMAIL_ERROR });

  const result = await Message.updateMany(
    { recipientId: req.user.userId, senderId, readAt: null },
    { $set: { readAt: new Date() } }
  );

  res.json({ updated: result.modifiedCount });
}));

// DELETE /messages/:id — soft-delete a message (sender or recipient).
// When both flags are set the document is hard-deleted immediately.
router.delete('/:id', auth, asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const me = req.user.userId;
  if (message.senderId !== me && message.recipientId !== me) {
    return res.status(403).json({ error: 'Not authorized to delete this message' });
  }

  if (message.senderId === me)    message.deletedBySender    = true;
  if (message.recipientId === me) message.deletedByRecipient = true;

  if (message.deletedBySender && message.deletedByRecipient) {
    await message.deleteOne();
    return res.json({ deleted: true });
  }

  await message.save();
  res.json({ deleted: true });
}));

module.exports = router;
