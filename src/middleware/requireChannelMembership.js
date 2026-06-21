const { isMember, ChannelNotFoundError } = require('../services/channelService');
const { isValidChannelId } = require('../utils/channelId');

// Authorizes channel access. Must run after `auth` (needs req.user).
// The JWT `sub` must be present in the channel's memberIds.
//   - malformed id     -> 400
//   - unknown channel  -> 404
//   - non-member       -> 403
async function requireChannelMembership(req, res, next) {
  const { channelId } = req.params;
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: 'Invalid channelId' });
  }

  try {
    const member = await isMember(channelId, req.user.userId);
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
