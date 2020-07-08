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

exports.signInWithPhoneAndPassword = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
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
  });

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

exports.getAddressFromCoordinates = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { latitude, longitude } = data;
    let locationDetails = null;

    if (latitude === undefined || longitude === undefined) {
      return { s: 400, m: "Bad argument: Incomplete coordinates" };
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
  });

exports.placeOrder = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderInfo } = data;

    const {
      deliveryCoordinates,
      deliveryAddress,
      userCoordinates,
      userName,
      userPhoneNumber,
      userId,
      storeCartItems,
      storeSelectedShipping,
      storeSelectedPaymentMethod,
      orderStoreList,
    } = JSON.parse(orderInfo);

    const cartStores = storeCartItems ? [...Object.keys(storeCartItems)] : null;

    const orderStatus = {
      pending: {
        status: true,
        updatedAt: new Date().toISOString(),
      },
      unpaid: {
        status: false,
      },
      paid: {
        status: false,
      },
      shipped: {
        status: false,
      },
      completed: {
        status: false,
      },
      cancelled: {
        status: false,
      },
    };

    if (
      deliveryCoordinates === undefined ||
      deliveryAddress === undefined ||
      userCoordinates === undefined ||
      userName === undefined ||
      userPhoneNumber === undefined ||
      userId === undefined ||
      storeCartItems === undefined ||
      storeSelectedShipping === undefined ||
      storeSelectedPaymentMethod === undefined ||
      orderStoreList === undefined
    ) {
      return { s: 400, m: "Bad argument: Incomplete request" };
    }

    const userRef = db.collection("users").doc(userId);
    const merchantIdRefs = {};

    cartStores.map((storeName) => {
      const { merchantId } = orderStoreList.find(
        (storeDetails) => storeDetails.storeName === storeName
      );

      merchantIdRefs[merchantId] = db.collection("merchants").doc(merchantId);
    });

    const merchantIds = Object.keys(merchantIdRefs);
    const merchantRefs = Object.values(merchantIdRefs);

    let merchantData = {};
    let userData = {};
    let ordersStores = {};

    return db
      .runTransaction(async (transaction) => {
        await transaction.getAll(userRef, ...merchantRefs).then((documents) => {
          const userDoc = documents[0];
          const merchantDocs = documents.slice(1, documents.length);

          if (userDoc.exists) {
            userData = userDoc.data();
          } else {
            console.error("Error: User does not exist!");
          }

          merchantDocs.map((merchantDoc, index) => {
            if (merchantDoc.exists) {
              merchantData[merchantIds[index]] = merchantDoc.data();
            } else {
              console.error("Error: Merchant does not exist!");
            }
          });

          return null;
        });

        const currentUserOrderNumber = userData.orderNumber
          ? userData.orderNumber
          : 0;

        cartStores.map(async (storeName) => {
          const { merchantId } = orderStoreList.find(
            (storeDetails) => storeDetails.storeName === storeName
          );

          const storeDetails = merchantData[merchantId];

          const currentMerchantOrderNumber = storeDetails.orderNumber
            ? storeDetails.orderNumber
            : 0;

          let quantity = 0;
          let totalAmount = 0;

          const orderItems = storeCartItems[storeName];
          const shipping = storeSelectedShipping[storeName];
          const paymentMethod = storeSelectedPaymentMethod[storeName];

          await orderItems.map((item) => {
            quantity = item.quantity + quantity;
            totalAmount = item.price * item.quantity + totalAmount;
          });

          const orderDetails = {
            reviewed: false,
            userCoordinates,
            deliveryCoordinates,
            deliveryAddress,
            userName,
            userPhoneNumber,
            userId,
            createdAt: new Date().toISOString(),
            orderStatus,
            quantity,
            totalAmount,
            shipping,
            merchantId,
            paymentMethod,
            merchantOrderNumber: currentMerchantOrderNumber + 1,
            userOrderNumber: currentUserOrderNumber + 1,
          };

          const ordersRef = firestore().collection("orders");
          const orderItemsRef = firestore().collection("order_items");
          const id = ordersRef.doc().id;

          transaction.set(orderItemsRef.doc(id), { items: orderItems });
          transaction.set(ordersRef.doc(id), { ...orderDetails });

          transaction.update(merchantIdRefs[merchantId], {
            orderNumber: currentMerchantOrderNumber + 1,
          });
          transaction.update(userRef, {
            orderNumber: currentUserOrderNumber + 1,
          });

          ordersStores[merchantId] = orderDetails;
        });
        const userCartRef = firestore().collection("user_carts").doc(userId);

        transaction.set(userCartRef, {});
      })
      .then(async () => {
        // Send Order Notification to each Merchant
        return Object.entries(ordersStores).map(
          async ([merchantId, orderDetails]) => {
            const merchantFcmRef = db
              .collection("merchant_fcm")
              .doc(merchantId);
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
            
            const { merchantOrderNumber, totalAmount } = orderDetails;
            const orderNotifications = [];

            fcmTokens.map((token) => {
              orderNotifications.push({
                notification: {
                  title: "You've got a new order!",
                  body: `Order # ${merchantOrderNumber}; Total Amount: ${totalAmount}`,
                },
                token,
              });
            });

            return orderNotifications.length > 0
              ? await admin.messaging().sendAll(orderNotifications)
              : console.log(`No fcm token found for ${merchantId}`);
          }
        );
      })
      .then(() => {
        return { s: 200, m: "Orders placed!" };
      })
      .catch((err) => {
        return { s: 500, m: `Error: ${err}` };
      });
  });
