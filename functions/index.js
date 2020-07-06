const functions = require("firebase-functions");
const firebase = require("firebase");
const admin = require("firebase-admin");
const { firestore } = require("firebase-admin");
const { FB_CONFIG, HERE_API_KEY } = require("./config");

admin.initializeApp();

firebase.initializeApp({
  ...FB_CONFIG,
});

const db = admin.firestore();

exports.keepOrderCount_sendOrderNotificationToMerchant = functions
  .region("asia-northeast1")
  .firestore.document("/orders/{orderId}")
  .onCreate(async (snap, context) => {
    return db
      .runTransaction(async (transaction) => {
        // Get the metadata document and increment the count.
        const orderData = snap.data();
        const { userId } = orderData;
        const orderRef = snap.ref;
        const userRef = db.collection("users").doc(userId);

        const userData = await transaction.get(userRef).then((documents) => {
          if (documents.exists) {
            return documents.data();
          } else {
            console.error("Error: User does not exist!");
          }

          return null;
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

        // Pass merchant order number
        return { incrementedMerchantOrderNumber };
      })
      .then(async ({ incrementedMerchantOrderNumber }) => {
        // Send Order Notification to Merchant
        const orderData = snap.data();
        const { merchantId } = orderData;
        const merchantFcmRef = db.collection("merchant_fcm").doc(merchantId);
        let fcmTokens = [];

        await merchantFcmRef
          .get()
          .then((document) => {
            if (document.exists) {
              return (fcmTokens = document.data().fcmTokens);
            }
            return null;
          })
          .catch((err) => console.log(err));

        const orderNotifications = [];

        fcmTokens.map((token) => {
          orderNotifications.push({
            notification: {
              title: "You've got a new order!",
              body: `Order # ${incrementedMerchantOrderNumber}; Total Amount: ${orderData.totalAmount}`,
            },
            token,
          });
        });

        return orderNotifications.length > 0
          ? await admin.messaging().sendAll(orderNotifications)
          : console.log(`No fcm token found for ${merchantId}`);
      });
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

exports.updateMerchantCredits = functions
  .region("asia-northeast1")
  .firestore.document("/orders/{orderId}")
  .onUpdate(async (snap, context) => {
    return db.runTransaction(async (transaction) => {
      const orderData = snap.after.data();
      const { totalAmount, merchantId, orderStatus } = orderData;
      const merchantRef = db.collection("merchants").doc(merchantId);

      const merchantData = await transaction
        .get(merchantRef)
        .then((document) => {
          return document.data();
        });

      // Calculate transaction fee and subtract it from current credit data
      const { creditData } = merchantData;
      const { credits, creditThreshold } = creditData;
      const transactionFee = totalAmount * 0.05;
      const newCredits = credits - transactionFee;
      const newCreditThresholdReached =
        newCredits < creditThreshold ? true : false;

      if (orderStatus.shipped.status) {
        transaction.update(merchantRef, {
          ["creditData.credits"]: newCredits,
          ["creditData.creditThresholdReached"]: newCreditThresholdReached,
        });
      }

      // Send notification to merchant if they have no more credits left
      const merchantFcmRef = db.collection("merchant_fcm").doc(merchantId);
      let fcmTokens = [];

      await merchantFcmRef
        .get()
        .then((document) => {
          if (document.exists) {
            return (fcmTokens = document.data().fcmTokens);
          }
          return null;
        })
        .catch((err) => console.log(err));

      const orderNotifications = [];

      if (newCreditThresholdReached) {
        fcmTokens.map((token) => {
          orderNotifications.push({
            notification: {
              title: "WARNING: You've run out of credits!",
              body: `"Please top up in order to receive more orders.
                If you need assistance, please email us at support@marketeer.ph and we will help you load up."`,
            },
            token,
          });
        });
      }

      return orderNotifications.length > 0 && fcmTokens.length > 0
        ? await admin.messaging().sendAll(orderNotifications)
        : null;
    });
  });

exports.getAddressFromCoordinates = functions.https.onCall(
  async (data, context) => {
    const { latitude, longitude } = data;
    let locationDetails = null;

    if (latitude === undefined || longitude === undefined) {
      return { s: 400, m: "Bad argument: no phone number" };
    }

    try {
      locationDetails = await new Promise((resolve) => {
        const url = `https://reverse.geocoder.ls.hereapi.com/6.2/reversegeocode.json?apiKey=${HERE_API_KEY}&mode=retrieveAddresses&prox=${latitude},${longitude}`;

        fetch(url)
          .then((res) => res.json())
          .then((resJson) => {
            if (
              resJson &&
              resJson.Response &&
              resJson.Response.View &&
              resJson.Response.View[0] &&
              resJson.Response.View[0].Result &&
              resJson.Response.View[0].Result[0]
            ) {
              return resolve(
                resJson.Response.View[0].Result[0].Location.Address.Label
              );
            } else {
              return resolve();
            }
          })
          .catch((e) => {
            console.log("Error in getAddressFromCoordinates", e);
            resolve();
          });
      });
    } catch (e) {
      return { s: 400, m: "Error, something went wrong." };
    }

    return { s: 200, locationDetails };
  }
);
