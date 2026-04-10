const mongoose = require('mongoose');

const TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days

const messageSchema = new mongoose.Schema(
  {
    senderId:    { type: String, required: true },
    recipientId: { type: String, required: true },
    body:        { type: String, required: true, maxlength: 5000 },
    readAt:      { type: Date, default: null },

    // Soft-delete flags — message is hidden from the respective party's view.
    // When both are true the document is hard-deleted (or cleaned up by cron).
    deletedBySender:    { type: Boolean, default: false },
    deletedByRecipient: { type: Boolean, default: false },

    // TODO: recipientEmail is required to send email notifications via EmailService.
    // We only have recipientId (UID) here; there is currently no service call to resolve
    // a UID to an email address. Store it here once the caller can supply it,
    // then wire up emailService.sendUnreadNotification().
    recipientEmail: { type: String, default: null },
  },
  { timestamps: true }
);

// Primary performance index: unread-count is the most-called endpoint.
messageSchema.index({ recipientId: 1, readAt: 1 });

// TTL index — MongoDB auto-deletes documents 180 days after createdAt.
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

// Conversation lookup: both directions between two users.
messageSchema.index({ senderId: 1, recipientId: 1 });

module.exports = mongoose.model('Message', messageSchema);
