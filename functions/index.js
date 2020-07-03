const functions = require("firebase-functions");
const firebase = require("firebase");
const admin = require("firebase-admin");
const { firestore } = require("firebase-admin");
const { config } = require("./FBconfig");

admin.initializeApp();

firebase.initializeApp({
  ...config,
});

const db = admin.firestore();

exports.keepOrderCount_sendOrderNotificationToMerchant = functions
  .region("asia-northeast1")
  .firestore.document("/orders/{orderId}")
  .onCreate((snap, context) => {
    return db
      .runTransaction(async (transaction) => {
        // Get the metadata document and increment the count.
        const orderData = snap.data();
        const { userId, totalAmount, merchantId } = orderData;
        const orderRef = snap.ref;
        const userRef = db.collection("users").doc(userId);
        const merchantRef = db.collection("merchants").doc(merchantId);
        let userData = null;
        let merchantData = null;

        await transaction.getAll(userRef, merchantRef).then((documents) => {
          const userDoc = documents[0];
          const merchantDoc = documents[1];

          if (userDoc.exists) {
            userData = userDoc.data();
          } else {
            console.error("Error: User does not exist!");
          }

          if (merchantDoc.exists) {
            merchantData = merchantDoc.data();
          } else {
            console.error("Error: Merchant does not exist!");
          }

          return null;
        });

        // Calculate transaction fee and subtract it from current credit data
        const { creditData } = merchantData;
        const { credits, creditThreshold } = creditData;
        const transactionFee = totalAmount * 0.05;
        const newCredits = credits - transactionFee;
        const newCreditThresholdReached =
          newCredits < creditThreshold ? true : false;

        console.log(transactionFee, newCredits, newCreditThresholdReached);

        // Update merchant order number and credits fields
        transaction.update(merchantRef, {
          orderNumber: firestore.FieldValue.increment(1),
          ["creditData.credits"]: newCredits,
          ["creditData.creditThresholdReached"]: newCreditThresholdReached,
        });

        // Update user order number field
        transaction.update(userRef, {
          orderNumber: firestore.FieldValue.increment(1),
        });

        const incrementedUserOrderNumber = userData.orderNumber
          ? userData.orderNumber + 1
          : 1;

        const incrementedMerchantOrderNumber = merchantData.orderNumber
          ? merchantData.orderNumber + 1
          : 1;

        // Update order number fields
        transaction.update(orderRef, {
          orderNumber: incrementedUserOrderNumber,
          transactionFee,
        });

        // Pass merchant order number and updated merchant credits for order notification
        return {
          incrementedMerchantOrderNumber,
          newCredits,
          newCreditThresholdReached,
        };
      })
      .then(
        async ({
          incrementedMerchantOrderNumber,
          newCredits,
          newCreditThresholdReached,
        }) => {
          // Send Order Notification to Merchant
          const orderData = snap.data();
          const { merchantId } = orderData;
          let fcmTokens = [];

          await db
            .collection("merchant_fcm")
            .doc(merchantId)
            .get()
            .then((document) => {
              if (document.exists) {
                return (fcmTokens = document.data().fcmTokens);
              }
              return null;
            })
            .catch((err) => console.log(err));

          const orderNotifications = [];

          const warningMessage =
            "Warning: Credit threshold reached. Please load up to receive orders.";

          fcmTokens.map((token) => {
            orderNotifications.push({
              notification: {
                title: "You've got a new order!",
                body: `Order # ${incrementedMerchantOrderNumber}; Total Amount: ${orderData.totalAmount}; Credits left: ${newCredits}`,
              },
              token,
            });

            if (newCreditThresholdReached) {
              orderNotifications.push({
                notification: {
                  title: "WARNING: You've run out of credit load!",
                  body: `"Please load up in order to receive more orders.
                    If you need assistance, please email us at support@marketeer.ph and we will help you load up."`,
                },
                token,
              });
            }
          });

          return orderNotifications.length > 0
            ? await admin.messaging().sendAll(orderNotifications)
            : console.log(`No fcm token found for ${merchantId}`);
        }
      );
  });

exports.signInWithPhoneAndPassword = functions.https.onCall(
  async (data, context) => {
    const phoneNumber = data.phone;
    if (phoneNumber === undefined) {
      return { s: 400, m: "Bad argument: no phone number" };
    }
    const user = await admin.auth().getUserByPhoneNumber(phoneNumber);
    const pass = data.password;
    try {
      await firebase.auth().signInWithEmailAndPassword(user.email, pass);
    } catch (e) {
      return { s: 400, m: "Wrong password" };
    }
    const token = await admin
      .auth()
      .createCustomToken(user.uid, { devClaim: true }); //developer claims, optional param
    return { s: 200, t: token };
  }
);
