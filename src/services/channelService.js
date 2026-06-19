const axios = require('axios');

// Membership lives in the ObjectService `channels` collection (`data.memberIds`).
// We fetch it via the internal X-API-Key auth and cache it briefly so that the
// hot path (post / list messages) does not hammer the ObjectService.
//
// SECURITY TRADE-OFF: caching membership means a *removed* member keeps access
// until their cache entry expires. The window is therefore the TTL. It defaults
// to a short 10s and is operator-tunable via CHANNEL_MEMBERSHIP_TTL_MS; set it to
// 0 to disable caching entirely (strict, instant revocation) when ObjectService
// cannot push membership-change events.
const CACHE_TTL_MS = (() => {
  const raw = parseInt(process.env.CHANNEL_MEMBERSHIP_TTL_MS, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 1000;
})();

// Unknown channels are cached too (negative cache) so non-members cannot amplify
// load onto the ObjectService by hammering a missing/forbidden channel id.
const NEGATIVE_TTL_MS = Math.min(CACHE_TTL_MS, 10 * 1000);

const cache = new Map(); // channelId -> { memberIds | notFound, expiresAt }

// Thrown when the channel does not exist. Mapped to 404 by the caller so that
// a missing channel is never confused with an authorization failure.
class ChannelNotFoundError extends Error {
  constructor(channelId) {
    super(`Channel not found: ${channelId}`);
    this.name = 'ChannelNotFoundError';
  }
}

async function fetchChannel(channelId) {
  const base = process.env.OBJECT_SERVICE_URL;
  const url = `${base}/objects/channels/${encodeURIComponent(channelId)}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'X-API-Key': process.env.OBJECT_SERVICE_API_KEY },
      timeout: 5000,
    });
    return data;
  } catch (err) {
    // ObjectService returns 404 for unknown objects and 403 for private objects
    // we are not allowed to read. Either way the channel is "not available" to
    // us — treat both as not-found so we never leak existence downstream.
    if (err.response && (err.response.status === 404 || err.response.status === 403)) {
      throw new ChannelNotFoundError(channelId);
    }
    throw err;
  }
}

// Normalises the member-id list out of an ObjectService document. The list is
// stored under `data.memberIds`; we coerce to strings so comparisons against the
// JWT `sub` (always a string) are exact.
function extractMemberIds(channel) {
  const data = (channel && channel.data) || {};
  const ids = data.memberIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

// Returns the channel's member user-id list, or throws ChannelNotFoundError.
async function getMemberIds(channelId) {
  const cached = cache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.notFound) throw new ChannelNotFoundError(channelId);
    return cached.memberIds;
  }

  let memberIds;
  try {
    memberIds = extractMemberIds(await fetchChannel(channelId));
  } catch (err) {
    if (err instanceof ChannelNotFoundError && NEGATIVE_TTL_MS > 0) {
      cache.set(channelId, { notFound: true, expiresAt: Date.now() + NEGATIVE_TTL_MS });
    }
    throw err;
  }

  if (CACHE_TTL_MS > 0) {
    cache.set(channelId, { memberIds, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return memberIds;
}

// True if userId is a member of the channel. Throws ChannelNotFoundError when
// the channel is unknown.
async function isMember(channelId, userId) {
  const memberIds = await getMemberIds(channelId);
  return memberIds.includes(String(userId));
}

function clearCache() {
  cache.clear();
}

module.exports = { getMemberIds, isMember, clearCache, ChannelNotFoundError };
