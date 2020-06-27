const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { firestore } = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

exports.keepUserOrderCount_copyOrderToMerchant = functions
  .region("asia-northeast1")
  .firestore.document("/users/{userId}/orders/{orderId}")
  .onCreate((snap, context) => {
    return db.runTransaction(async (transaction) => {
      // Get the metadata document and increment the count.
      const { userId, orderId } = context.params;
      const orderData = snap.data();
      const { merchantId } = orderData;
      const orderRef = snap.ref;
      const userRef = db.collection("users").doc(userId);

      const orderNumberData = await transaction
        .get(userRef)
        .then((document) => {
          if (document.exists) {
            transaction.update(userRef, {
              orderNumber: firestore.FieldValue.increment(1),
            });

            return document.data();
          } else {
            transaction.update(userRef, { orderNumber: 1 });

            return { orderNumber: 0 };
          }
        })
        .catch((err) => console.error(err));

      const orderNumber = orderNumberData.orderNumber
        ? orderNumberData.orderNumber + 1
        : 1;

      console.log("1", orderNumber, orderNumberData.orderNumber);

      const merchantOrderRef = db
        .collection("merchants")
        .doc(merchantId)
        .collection("orders")
        .doc(orderId);
      const merchantOrderData = { ...orderData, userId };
      delete merchantOrderData.merchantId;

      // Update the order document
      transaction.update(orderRef, {
        orderNumber,
      });

      transaction.set(merchantOrderRef, { ...merchantOrderData });
    });
  });

exports.keepMercantOrderCount_sendOrderNotificationToMerchant = functions
  .region("asia-northeast1")
  .firestore.document("/merchants/{merchantId}/orders/{orderId}")
  .onCreate((snap, context) => {
    const { merchantId } = context.params;
    const orderRef = snap.ref;

    return db
      .runTransaction(async (transaction) => {
        // Get the metadata document and increment the count.
        const merchantRef = db.collection("merchants").doc(merchantId);

        const orderNumberData = await transaction
          .get(merchantRef)
          .then((document) => {
            if (document.exists) {
              transaction.update(merchantRef, {
                orderNumber: firestore.FieldValue.increment(1),
              });

              return document.data();
            } else {
              transaction.update(merchantRef, { orderNumber: 0 });

              return { orderNumber: 0 };
            }
          })
          .catch((err) => console.error(err));

        const orderNumber = orderNumberData.orderNumber
          ? orderNumberData.orderNumber + 1
          : 1;

        console.log("2", orderNumber, orderNumberData.orderNumber);

        // Update the order document
        transaction.update(orderRef, {
          orderNumber,
        });

        return orderNumber;
      })
      .then(async (orderNumber) => {
        // Send Notification to Merchants

        const orderData = snap.data();

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
