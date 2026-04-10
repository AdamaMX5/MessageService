const axios = require('axios');

// TODO: Email notifications for unread messages are only sent when recipientEmail
// is stored on the Message document. We have the recipientId (UID) but no way to
// resolve it to an email address without a lookup service. Once that lookup is
// available, populate recipientEmail at message creation time and call this function
// from the scheduled job / cron.
async function sendUnreadNotification(recipientEmail, senderName, messageCount) {
  await axios.post(
    `${process.env.EMAIL_SERVICE_URL}/emails`,
    {
      to: recipientEmail,
      subject: 'Neue Nachrichten',
      body: `Du hast ${messageCount} ungelesene Nachricht${messageCount !== 1 ? 'en' : ''} von ${senderName}.`,
      isHtml: false,
    },
    {
      headers: { 'X-API-Key': process.env.EMAIL_SERVICE_API_KEY },
    }
  );
}

module.exports = { sendUnreadNotification };
