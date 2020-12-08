const { admin } = require("../util/admin");

async function sendNotifications(title, body, fcmTokens, data) {
  return await new Promise((res, rej) => {
    try {
      const notifications = [];

      if (fcmTokens !== undefined) {
        fcmTokens.map((token) => {
          notifications.push({
            notification: {
              title,
              body,
            },
            data,
            token,
          });
        });
      }

      if (notifications.length > 0) {
        admin.messaging().sendAll(notifications);
      }

      res();
    } catch (e) {
      rej(e.message);
    }
  });
}

module.exports = { sendNotifications };
