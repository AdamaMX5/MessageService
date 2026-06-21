const { getChannelInfo, ChannelNotFoundError } = require('../services/channelService');
const { isValidChannelId } = require('../utils/channelId');

// Loads the channel and the caller's permissions, without authorizing on its own —
// each route decides which permission it needs. Must run after `auth`.
//   - malformed channelId -> 400
//   - unknown channel     -> 404
// Attaches:
//   req.channelInfo  = { memberIds, adminIds, createdBy }
//   req.channelPerms = { isMember, isChannelAdmin, isServiceAdmin }
//
// isChannelAdmin = caller in adminIds OR caller is the creator (createdBy).
// isServiceAdmin = JWT role `admin`. Service-admins may manage membership but are
// NOT granted message read access — that stays members-only.
async function loadChannel(req, res, next) {
  const { channelId } = req.params;
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: 'Invalid channelId' });
  }

  try {
    const info = await getChannelInfo(channelId);
    const uid = String(req.user.userId);
    req.channelInfo = info;
    req.channelPerms = {
      isMember: info.memberIds.includes(uid),
      isChannelAdmin: info.adminIds.includes(uid) || info.createdBy === uid,
      isServiceAdmin: (req.user.roles || []).includes('admin'),
    };
    next();
  } catch (err) {
    if (err instanceof ChannelNotFoundError) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    next(err);
  }
}

module.exports = loadChannel;
