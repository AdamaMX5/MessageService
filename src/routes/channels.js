const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireChannelMembership = require('../middleware/requireChannelMembership');
const loadChannel = require('../middleware/loadChannel');
const asyncHandler = require('../utils/asyncHandler');
const parsePagination = require('../utils/pagination');
const channelService = require('../services/channelService');
const ChannelMessage = require('../models/ChannelMessage');

const PAGINATION = { defaultLimit: 100, maxLimit: 100 };
const MAX_BODY_LENGTH = 5000; // mirrors the ChannelMessage schema cap

// User ids must be plain, bounded, non-empty strings, never email addresses
// (consistent with the DM routes) and never query-operator objects.
const MAX_USER_ID_LENGTH = 128;
function invalidUserId(value) {
  return typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_USER_ID_LENGTH
    || value.includes('@');
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
  const { page, limit, skip } = parsePagination(req.query, PAGINATION);
  const filter = { channelId: req.params.channelId };

  const [messages, total] = await Promise.all([
    ChannelMessage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ChannelMessage.countDocuments(filter),
  ]);

  res.json({ total, page, limit, data: messages });
}));

// ── Membership management ──────────────────────────────────────────────────
// Read access to messages stays members-only; the routes below manage *who* the
// members/admins are. Management requires a channel admin (in adminIds or the
// creator) or a service-admin (JWT role `admin`); a service-admin need not be a
// member. Self-leave is allowed for any member.
//
// By design, admins need not be members: promoting a non-member to admin and a
// member leaving while staying admin are both valid states. The one hard rule is
// that the creator (createdBy) can never be removed/demoted, so they can always
// recover access to their own channel.

function canManage(perms) {
  return perms.isChannelAdmin || perms.isServiceAdmin;
}

// The creator is immutable channel metadata and must never be locked out.
function isCreator(req, userId) {
  return req.channelInfo.createdBy != null && userId === req.channelInfo.createdBy;
}

// GET /channels/:channelId/members — list members and admins.
// Visible to members, channel admins, and service-admins.
router.get('/:channelId/members', auth, loadChannel, asyncHandler(async (req, res) => {
  const { isMember } = req.channelPerms;
  if (!isMember && !canManage(req.channelPerms)) {
    return res.status(403).json({ error: 'Channel membership or admin rights required' });
  }
  const { memberIds, adminIds } = req.channelInfo;
  res.json({ memberIds, adminIds });
}));

// POST /channels/:channelId/members { userId } — add a member.
router.post('/:channelId/members', auth, loadChannel, asyncHandler(async (req, res) => {
  if (!canManage(req.channelPerms)) {
    return res.status(403).json({ error: 'Channel admin rights required' });
  }
  const { userId } = req.body;
  if (invalidUserId(userId)) {
    return res.status(400).json({ error: '"userId" must be a non-email user id' });
  }
  const { memberIds, adminIds } = await channelService.addMember(req.params.channelId, userId);
  res.json({ memberIds, adminIds });
}));

// DELETE /channels/:channelId/members/:userId — remove a member.
// Channel admins / service-admins may remove anyone; a member may remove themselves.
router.delete('/:channelId/members/:userId', auth, loadChannel, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (invalidUserId(userId)) {
    return res.status(400).json({ error: '"userId" must be a non-email user id' });
  }
  const isSelfLeave = req.channelPerms.isMember && userId === String(req.user.userId);
  if (!canManage(req.channelPerms) && !isSelfLeave) {
    return res.status(403).json({ error: 'Channel admin rights required' });
  }
  if (isCreator(req, userId)) {
    return res.status(409).json({ error: 'The channel creator cannot be removed' });
  }
  const { memberIds, adminIds } = await channelService.removeMember(req.params.channelId, userId);
  res.json({ memberIds, adminIds });
}));

// POST /channels/:channelId/admins { userId } — promote a user to channel admin.
router.post('/:channelId/admins', auth, loadChannel, asyncHandler(async (req, res) => {
  if (!canManage(req.channelPerms)) {
    return res.status(403).json({ error: 'Channel admin rights required' });
  }
  const { userId } = req.body;
  if (invalidUserId(userId)) {
    return res.status(400).json({ error: '"userId" must be a non-email user id' });
  }
  const { memberIds, adminIds } = await channelService.addAdmin(req.params.channelId, userId);
  res.json({ memberIds, adminIds });
}));

// DELETE /channels/:channelId/admins/:userId — demote a channel admin.
// The creator (createdBy) is a permanent admin and cannot be demoted.
router.delete('/:channelId/admins/:userId', auth, loadChannel, asyncHandler(async (req, res) => {
  if (!canManage(req.channelPerms)) {
    return res.status(403).json({ error: 'Channel admin rights required' });
  }
  const { userId } = req.params;
  if (invalidUserId(userId)) {
    return res.status(400).json({ error: '"userId" must be a non-email user id' });
  }
  if (isCreator(req, userId)) {
    return res.status(409).json({ error: 'The channel creator cannot be demoted' });
  }
  const { memberIds, adminIds } = await channelService.removeAdmin(req.params.channelId, userId);
  res.json({ memberIds, adminIds });
}));

module.exports = router;
