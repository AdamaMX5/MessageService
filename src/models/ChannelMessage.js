const mongoose = require('mongoose');

const TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days — same retention as DMs

// Channel-scoped message. Unlike the DM Message model there is no recipientId
// and no readAt: channels are many-to-many and read-receipts are out of scope
// (see issue #1). For E2E channels `body` holds a Base64 envelope and the
// service never sees the plaintext or the group key.
const channelMessageSchema = new mongoose.Schema(
  {
    senderId:  { type: String, required: true }, // JWT `sub` of the author
    channelId: { type: String, required: true }, // ObjectService channel id
    body:      { type: String, required: true, maxlength: 5000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Primary access pattern: list a channel's messages ordered by time.
channelMessageSchema.index({ channelId: 1, createdAt: -1 });

// TTL index — MongoDB auto-deletes documents 180 days after createdAt.
channelMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

// Expose `id`, hide Mongo internals — matches the ServiceMessage contract.
channelMessageSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('ChannelMessage', channelMessageSchema);
