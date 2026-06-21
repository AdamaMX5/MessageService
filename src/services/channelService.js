const axios = require('axios');

// Channel state lives in the ObjectService `channels` collection:
//   data.memberIds[] — who may read/write messages
//   data.adminIds[]  — channel admins who may manage membership
//   createdBy        — object metadata; the creator is an implicit channel admin
// We read it via the internal X-API-Key auth and cache it briefly so the hot path
// (post / list messages) does not hammer the ObjectService.
//
// SECURITY TRADE-OFF: caching membership means a *removed* member keeps access
// until their cache entry expires. The window is therefore the TTL. It defaults
// to a short 10s and is operator-tunable via CHANNEL_MEMBERSHIP_TTL_MS; set it to
// 0 to disable caching entirely (strict, instant revocation). Every write below
// invalidates the affected channel's entry so changes take effect immediately
// for this instance regardless of the TTL.
const CACHE_TTL_MS = (() => {
  const raw = parseInt(process.env.CHANNEL_MEMBERSHIP_TTL_MS, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 1000;
})();

// Unknown channels are cached too (negative cache) so non-members cannot amplify
// load onto the ObjectService by hammering a missing/forbidden channel id.
const NEGATIVE_TTL_MS = Math.min(CACHE_TTL_MS, 10 * 1000);

const cache = new Map(); // channelId -> { info | notFound, expiresAt }

// Thrown when the channel does not exist. Mapped to 404 by the caller so that
// a missing channel is never confused with an authorization failure.
class ChannelNotFoundError extends Error {
  constructor(channelId) {
    super(`Channel not found: ${channelId}`);
    this.name = 'ChannelNotFoundError';
  }
}

function objectUrl(channelId) {
  return `${process.env.OBJECT_SERVICE_URL}/objects/channels/${encodeURIComponent(channelId)}`;
}

function apiHeaders() {
  return { 'X-API-Key': process.env.OBJECT_SERVICE_API_KEY };
}

// Maps ObjectService 404 (unknown) and 403 (private, not readable) to a single
// not-found signal so we never leak channel existence downstream.
function asChannelError(err, channelId) {
  if (err.response && (err.response.status === 404 || err.response.status === 403)) {
    return new ChannelNotFoundError(channelId);
  }
  return err;
}

async function fetchChannel(channelId) {
  try {
    const { data } = await axios.get(objectUrl(channelId), { headers: apiHeaders(), timeout: 5000 });
    return data;
  } catch (err) {
    throw asChannelError(err, channelId);
  }
}

function toStringArray(value) {
  // Coerce to strings so comparisons against the JWT `sub` (always a string) are exact.
  return Array.isArray(value) ? value.map(String) : [];
}

// Extracts the membership-relevant fields from an ObjectService channel document.
function extractChannelInfo(channel) {
  const data = (channel && channel.data) || {};
  return {
    memberIds: toStringArray(data.memberIds),
    adminIds:  toStringArray(data.adminIds),
    createdBy: channel && channel.createdBy != null ? String(channel.createdBy) : null,
  };
}

// Returns { memberIds, adminIds, createdBy } for a channel, or throws
// ChannelNotFoundError. Served from the short-lived cache when possible.
async function getChannelInfo(channelId) {
  const cached = cache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.notFound) throw new ChannelNotFoundError(channelId);
    return cached.info;
  }

  let info;
  try {
    info = extractChannelInfo(await fetchChannel(channelId));
  } catch (err) {
    if (err instanceof ChannelNotFoundError && NEGATIVE_TTL_MS > 0) {
      cache.set(channelId, { notFound: true, expiresAt: Date.now() + NEGATIVE_TTL_MS });
    }
    throw err;
  }

  if (CACHE_TTL_MS > 0) {
    cache.set(channelId, { info, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return info;
}

async function getMemberIds(channelId) {
  return (await getChannelInfo(channelId)).memberIds;
}

async function isMember(channelId, userId) {
  return (await getChannelInfo(channelId)).memberIds.includes(String(userId));
}

// A channel admin is anyone in data.adminIds plus the channel creator (createdBy),
// who is always an implicit admin.
async function isChannelAdmin(channelId, userId) {
  const { adminIds, createdBy } = await getChannelInfo(channelId);
  const id = String(userId);
  return adminIds.includes(id) || createdBy === id;
}

function invalidate(channelId) {
  cache.delete(channelId);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function withId(list, userId) {
  const id = String(userId);
  return list.includes(id) ? list : [...list, id];
}

function withoutId(list, userId) {
  const id = String(userId);
  return list.filter((x) => x !== id);
}

// Read-modify-write of one membership array on the channel object. Fetches the
// document fresh (bypassing the cache) to minimise lost updates, applies the
// transform, and PATCHes only when the list actually changed (so repeated
// add/remove is idempotent). Always invalidates the cache. Returns the resulting
// { memberIds, adminIds, createdBy }.
//
// NOTE: this is not atomic — concurrent membership edits on the same channel can
// race (last write wins). Membership changes are low-frequency, so this is an
// accepted trade-off.
async function mutateList(channelId, field, transform) {
  const current = extractChannelInfo(await fetchChannel(channelId));
  const nextList = transform(current[field]);

  if (sameSet(current[field], nextList)) {
    invalidate(channelId);
    return current;
  }

  try {
    await axios.patch(
      objectUrl(channelId),
      { data: { [field]: nextList }, merge: true },
      { headers: apiHeaders(), timeout: 5000 }
    );
  } catch (err) {
    throw asChannelError(err, channelId);
  }

  invalidate(channelId);
  return { ...current, [field]: nextList };
}

const addMember    = (channelId, userId) => mutateList(channelId, 'memberIds', (l) => withId(l, userId));
const removeMember = (channelId, userId) => mutateList(channelId, 'memberIds', (l) => withoutId(l, userId));
const addAdmin     = (channelId, userId) => mutateList(channelId, 'adminIds',  (l) => withId(l, userId));
const removeAdmin  = (channelId, userId) => mutateList(channelId, 'adminIds',  (l) => withoutId(l, userId));

function clearCache() {
  cache.clear();
}

module.exports = {
  getChannelInfo,
  getMemberIds,
  isMember,
  isChannelAdmin,
  addMember,
  removeMember,
  addAdmin,
  removeAdmin,
  invalidate,
  clearCache,
  ChannelNotFoundError,
};
