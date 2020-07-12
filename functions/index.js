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
    const merchantItemsIdRefs = {};

    cartStores.map((storeName) => {
      const { merchantId } = orderStoreList.find(
        (storeDetails) => storeDetails.storeName === storeName
      );

      merchantIdRefs[merchantId] = db.collection("merchants").doc(merchantId);
      merchantItemsIdRefs[merchantId] = db
        .collection("merchant_items")
        .doc(merchantId);
    });

    const merchantRefs = Object.values(merchantIdRefs);
    const merchantItemsRefs = Object.values(merchantItemsIdRefs);

    let merchantData = {};
    let merchantItemsData = {};
    let userData = {};
    let ordersStores = {};

    let error = null;

    return db
      .runTransaction(
        async (transaction) => {
          await transaction
            .getAll(userRef, ...merchantRefs, ...merchantItemsRefs)
            .then((documents) => {
              const userDoc = documents[0];
              const merchantDocs = documents.slice(1, merchantRefs.length + 1);
              const merchantItemsDocs = documents.slice(
                merchantDocs.length + 1,
                documents.length
              );

              if (userDoc.exists) {
                userData = userDoc.data();
              } else {
                console.error("Error: User does not exist!");
              }

              merchantDocs.map((merchantDoc, index) => {
                if (merchantDoc.exists) {
                  merchantData[merchantDoc.id] = merchantDoc.data();
                } else {
                  console.error("Error: Merchant does not exist!");
                }
              });

              merchantItemsDocs.map((merchantItemDoc, index) => {
                if (merchantItemDoc.exists) {
                  merchantItemsData[
                    merchantItemDoc.id
                  ] = merchantItemDoc.data();
                } else {
                  console.error(
                    "Error: Merchant Items Document does not exist!"
                  );
                }
              });

              return null;
            });

          const currentUserOrderNumber = userData.orderNumber
            ? userData.orderNumber
            : 0;

          await cartStores.map(async (storeName) => {
            const { merchantId } = orderStoreList.find(
              (storeDetails) => storeDetails.storeName === storeName
            );

            const currentStoreItems = [...merchantItemsData[merchantId].items];

            const storeDetails = merchantData[merchantId];

            const currentMerchantOrderNumber = storeDetails.orderNumber
              ? storeDetails.orderNumber
              : 0;

            let quantity = 0;
            let totalAmount = 0;

            const orderItems = storeCartItems[storeName];
            const shipping = storeSelectedShipping[storeName];
            const paymentMethod = storeSelectedPaymentMethod[storeName];

            orderItems.map((orderItem) => {
              quantity = orderItem.quantity + quantity;
              totalAmount = orderItem.price * orderItem.quantity + totalAmount;

              const currentStoreItemIndex = currentStoreItems.findIndex(
                (storeItem) => storeItem.name === orderItem.name
              );

              const currentStoreItem = currentStoreItems[currentStoreItemIndex];

              currentStoreItem.stock -= orderItem.quantity;

              currentStoreItem.sales += orderItem.quantity;

              if (currentStoreItem.stock < 0) {
                error = `Not enough stocks for item ${orderItem.name} from ${storeName}`;
                return Promise.reject(new functions.https.HttpsError(error));
              }
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

            // Place order
            transaction.set(orderItemsRef.doc(id), {
              items: orderItems,
            });
            transaction.set(ordersRef.doc(id), {
              ...orderDetails,
            });

            // Update order number
            transaction.update(merchantIdRefs[merchantId], {
              orderNumber: currentMerchantOrderNumber + 1,
            });
            transaction.update(userRef, {
              orderNumber: currentUserOrderNumber + 1,
            });

            // Update store item quantity
            transaction.update(merchantItemsIdRefs[merchantId], {
              items: [...currentStoreItems],
            });

            ordersStores[merchantId] = orderDetails;
          });

          const userCartRef = firestore().collection("user_carts").doc(userId);

          transaction.set(userCartRef, {});
        },
        { maxAttempts: 5 }
      )
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
        if (error) {
          return { s: 400, m: error };
        }
        return { s: 200, m: "Orders placed!" };
      })
      .catch((err) => {
        return new functions.https.HttpsError(
          "invalid-argument",
          err.error_code ? err.error_code : err.code,
          err.message
        );
      });
  });

exports.addReview = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, merchantId, reviewTitle, reviewBody, rating } = data;
    const userId = context.auth.uid;
    const userName = context.auth.token.name || null;

    console.log(data);

    if (orderId === undefined || rating === undefined) {
      return { s: 400, m: "Bad argument: Incomplete data" };
    }

    try {
      return db.runTransaction(async (transaction) => {
        const orderRef = db.collection("orders").doc(orderId);
        const merchantRef = db.collection("merchants").doc(merchantId);
        let orderReviewPage = 0;
        let newRatingAverage = 0;

        await transaction
          .getAll(orderRef, merchantRef)
          .then((documents) => {
            const orderDoc = documents[0];
            const merchantDoc = documents[1];

            const review = {
              reviewTitle,
              reviewBody,
              rating,
              orderId,
              userId,
              userName,
              createdAt: new Date().toISOString(),
            };

            if (orderDoc.exists) {
              if (orderDoc.data().reviewed) {
                return Promise.reject(
                  new Error("The order is already reviewed")
                );
              } else {
                transaction.update(orderDoc.ref, { reviewed: true });
              }
            }

            if (merchantDoc.exists) {
              const { reviewNumber, ratingAverage } = merchantDoc.data();
              console.log("merchantDoc.exists");

              if (reviewNumber && ratingAverage) {
                orderReviewPage = Math.floor(reviewNumber / 2000);

                if (orderReviewPage <= 0) {
                  orderReviewPage = 1;
                }

                newRatingAverage = (ratingAverage + rating) / 2;

                const orderReviewPageRef = db
                  .collection("merchants")
                  .doc(merchantId)
                  .collection("order_reviews")
                  .doc(`${orderReviewPage}`);

                console.log("update");

                transaction.update(orderReviewPageRef, {
                  reviews: firestore.FieldValue.arrayUnion(review),
                });
              } else {
                newRatingAverage = rating;

                console.log("set");

                const firstOrderReviewPageRef = db
                  .collection("merchants")
                  .doc(merchantId)
                  .collection("order_reviews")
                  .doc("1");

                transaction.set(firstOrderReviewPageRef, {
                  reviews: [review],
                });
              }

              transaction.update(merchantRef, {
                reviewNumber: firestore.FieldValue.increment(1),
                ratingAverage: newRatingAverage,
              });

              console.log(orderReviewPage);
            } else {
              return { s: 500, m: "Error, merchant was not found" };
            }

            return { s: 200, m: "Review placed!" };
          })
          .catch((err) => {
            console.log(err);
          });
      });
    } catch (e) {
      return { s: 400, m: e };
    }
  });
