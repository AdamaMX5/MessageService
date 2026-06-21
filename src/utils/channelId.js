// A bounded, URL/Mongo-safe channel id. Validating before any ObjectService
// lookup keeps malformed/oversized ids out of the cache and the message store.
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const isValidChannelId = (value) => typeof value === 'string' && CHANNEL_ID_PATTERN.test(value);

module.exports = { CHANNEL_ID_PATTERN, isValidChannelId };
