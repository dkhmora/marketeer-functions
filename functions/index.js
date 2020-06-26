const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { firestore } = require("firebase-admin");
admin.initializeApp();

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });

const db = admin.firestore();

exports.sendOrderNotification = functions
  .region("asia-northeast1")
  .firestore.document("merchants/{merchantId}/orders/{orderId}")
  .onCreate(async (snap, context) => {
    const { merchantId } = context.params;

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
          body: `Order # ${orderData.orderNumber}; Total Amount: ${orderData.totalAmount}`,
        },
        token,
      });
    });

    const response = await admin.messaging().sendAll(orderNotifications);
    console.log(response);
  });

exports.keepUserOrderCount = functions
  .region("asia-northeast1")
  .firestore.document("/users/{userId}/orders/{orderId}")
  .onCreate((snap, context) => {
    return db.runTransaction(async (transaction) => {
      // Get the metadata document and increment the count.
      const { userId } = context.params;
      const orderRef = snap.ref;
      const orderNumberRef = db
        .collection("users")
        .doc(userId)
        .collection("orders")
        .doc("order_number");

      const orderNumberData = await transaction
        .get(orderNumberRef)
        .then((document) => {
          if (document.exists) {
            return document.data();
          } else {
            transaction.set(orderNumberRef, { orderNumber: 0 });

            return { orderNumber: 0 };
          }
        })
        .catch((err) => console.error(err));

      const number = orderNumberData.orderNumber + 1;

      // Update the order document
      transaction.update(orderRef, {
        orderNumber: number,
      });
    });
  });
