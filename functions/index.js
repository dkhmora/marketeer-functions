const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { firestore } = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

exports.keepOrderCount_sendOrderNotificationToMerchant = functions
  .region("asia-northeast1")
  .firestore.document("/orders/{orderId}")
  .onCreate((snap, context) => {
    return db
      .runTransaction(async (transaction) => {
        // Get the metadata document and increment the count.
        const orderData = snap.data();
        const { userId } = orderData;
        const { merchantId } = orderData.storeDetails;
        const orderRef = snap.ref;
        const userRef = db.collection("users").doc(userId);
        const merchantRef = db.collection("merchants").doc(merchantId);
        let userOrderNumberData = null;
        let merchantOrderNumberData = null;

        await transaction.getAll(userRef, merchantRef).then((documents) => {
          const userDoc = documents[0];
          const merchantDoc = documents[1];

          if (userDoc.exists) {
            transaction.update(userRef, {
              orderNumber: firestore.FieldValue.increment(1),
            });

            userOrderNumberData = userDoc.data();
          } else {
            transaction.update(userRef, { orderNumber: 1 });

            userOrderNumberData = { orderNumber: 0 };
          }

          if (merchantDoc.exists) {
            transaction.update(merchantRef, {
              orderNumber: firestore.FieldValue.increment(1),
            });

            merchantOrderNumberData = merchantDoc.data();
          } else {
            transaction.update(merchantRef, { orderNumber: 1 });

            merchantOrderNumberData = { orderNumber: 0 };
          }

          return null;
        });

        const userOrderNumber = userOrderNumberData.orderNumber
          ? userOrderNumberData.orderNumber + 1
          : 1;

        const merchantOrderNumber = merchantOrderNumberData.orderNumber
          ? merchantOrderNumberData.orderNumber + 1
          : 1;

        // Update order number fields
        transaction.update(orderRef, {
          orderNumber: userOrderNumber,
          ["storeDetails.orderNumber"]: merchantOrderNumber,
        });

        return merchantOrderNumber;
      })
      .then(async (orderNumber) => {
        // Send Order Notification to Merchant

        const orderData = snap.data();
        const { merchantId } = orderData.storeDetails;

        let fcmTokens = [];

        await db
          .collection("merchant_fcm")
          .doc(merchantId)
          .get()
          .then((document) => {
            return (fcmTokens = document.data().fcmTokens);
          })
          .catch((err) => console.log(err));

        const orderNotifications = [];

        fcmTokens.map((token) => {
          orderNotifications.push({
            notification: {
              title: "New Order!",
              body: `Order # ${orderNumber}; Total Amount: ${orderData.totalAmount}`,
            },
            token,
          });
        });

        return await admin.messaging().sendAll(orderNotifications);
      });
  });
