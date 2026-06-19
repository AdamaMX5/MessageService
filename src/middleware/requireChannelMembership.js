const { isMember, ChannelNotFoundError } = require('../services/channelService');

// Authorizes channel access. Must run after `auth` (needs req.user).
// The JWT `sub` must be present in the channel's memberIds.
//   - unknown channel  -> 404 (never reveals member-only metadata)
//   - non-member       -> 403
// Neither branch returns any channel content, so non-members learn nothing
// beyond existence (an explicit, accepted trade-off per issue #1).
async function requireChannelMembership(req, res, next) {
  try {
    const member = await isMember(req.params.channelId, req.user.userId);
    if (!member) {
      return res.status(403).json({ error: 'Channel membership required' });
    }
    next();
  } catch (err) {
    if (err instanceof ChannelNotFoundError) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    next(err);
  }
}

module.exports = requireChannelMembership;
