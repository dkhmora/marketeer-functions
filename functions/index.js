const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });

exports.sendOrderNotification = functions
  .region("asia-northeast1")
  .firestore.document("merchants/{merchantId}/orders/{orderId}")
  .onCreate(async (snap, context) => {
    const { merchantId } = context.params;

    const orderData = snap.data();

    let fcmTokens = [];

    await admin
      .firestore()
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
