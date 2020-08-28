/* eslint-disable promise/no-nesting */
const functions = require("firebase-functions");
const firebase = require("firebase");
const { firestore } = require("firebase-admin");
const { FB_CONFIG, HERE_API_KEY } = require("./util/config");
const { db, admin } = require("./util/admin");
const firestoreGCP = require("@google-cloud/firestore");
const client = new firestoreGCP.v1.FirestoreAdminClient();

firebase.initializeApp({
  ...FB_CONFIG,
});

const app = require("express")();
const {
  checkPayment,
  result,
  getMerchantPaymentLink,
  getAvailablePaymentProcessors,
} = require("./handlers/payments");

app.post("/payment/checkPayment", checkPayment);
app.get("/payment/result", result);

// ** Dragonpay Test **
const {
  checkPaymentTest,
  resultTest,
  getMerchantPaymentLinkTest,
} = require("./handlers/payments_test");

app.post("/payment/checkPaymentTest", checkPaymentTest);
app.get("/payment/resultTest", resultTest);

exports.getMerchantPaymentLinkTest = getMerchantPaymentLinkTest;
// ** Dragonpay Test **

// ** Dragonpay PRODUCTION **
exports.getMerchantPaymentLink = getMerchantPaymentLink;
exports.getAvailablePaymentProcessors = getAvailablePaymentProcessors;
// ** Dragonpay PRODUCTION **

exports.api = functions.region("asia-northeast1").https.onRequest(app);

exports.scheduledFirestoreExport = functions
  .region("asia-northeast1")
  .pubsub.schedule("every 24 hours")
  .onRun((context) => {
    const bucket = "gs://marketeer-backup-bucket";
    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    const databaseName = client.databasePath(projectId, "(default)");

    return client
      .exportDocuments({
        name: databaseName,
        outputUriPrefix: bucket,
        collectionIds: [],
      })
      .then((responses) => {
        const response = responses[0];
        return functions.logger.log(`Operation Name: ${response["name"]}`);
      })
      .catch((err) => {
        functions.logger.error(err);
        throw new Error("Export operation failed");
      });
  });

exports.signInWithPhoneAndPassword = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const phoneNumber = data.phone;
    if (phoneNumber === undefined) {
      return { s: 400, m: "Bad argument: no phone number" };
    }

    try {
      const user = await admin.auth().getUserByPhoneNumber(phoneNumber);

      functions.logger.log(user, data);
      const pass = data.password;

      await firebase.auth().signInWithEmailAndPassword(user.email, pass);

      const token = await admin
        .auth()
        .createCustomToken(user.uid, { devClaim: true });

      return { s: 200, t: token };
    } catch (e) {
      return { s: 400, m: "Wrong phone number or password. Please try again." };
    }
  });

exports.sendPasswordResetLinkToMerchant = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const email = data.email;

    try {
      if (email === undefined) {
        return { s: 400, m: "Bad argument: no phone number" };
      }

      const user = await admin.auth().getUserByEmail(email);

      if (!user) {
        return { s: 400, m: "Bad argument: Email could not be found" };
      }

      if (!user.customClaims.merchantIds) {
        return {
          s: 400,
          m: "Bad argument: Email is not assigned to any merchant",
        };
      }

      await firebase.auth().sendPasswordResetEmail(email);
    } catch (e) {
      return { s: 400, m: "Error, something went wrong" };
    }

    return { s: 200, m: `Password reset link successfully sent to ${email}!` };
  });

exports.changeOrderStatus = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId } = data;
    const userId = context.auth.uid;
    const merchantId = context.auth.token.merchantId;

    if (!userId || !merchantId) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (orderId === undefined) {
      return { s: 400, m: "Bad argument: Order ID not found" };
    }

    const statusArray = ["pending", "unpaid", "paid", "shipped", "completed"];

    const orderRef = firestore().collection("orders").doc(orderId);
    const merchantRef = firestore().collection("merchants").doc(merchantId);

    try {
      return db
        .runTransaction(async (transaction) => {
          let orderData, merchantData;

          await transaction.getAll(orderRef, merchantRef).then((documents) => {
            const orderDoc = documents[0];
            const merchantDoc = documents[1];

            orderData = orderDoc.data();
            merchantData = merchantDoc.data();

            if (merchantId !== orderData.merchantId) {
              throw new Error("Order does not correspond with merchant id");
            }

            if (merchantData.creditData.creditThresholdReached) {
              throw new Error(
                "You have reached the Markee credit threshold! Please load up in order to process more orders. If you have any problems, please contact Marketeer Support at support@marketeer.ph"
              );
            }

            return;
          });

          const { orderStatus, paymentMethod, subTotal } = orderData;

          let currentOrderStatus = null;
          let newOrderStatus = {};

          Object.keys(orderStatus).map((item, index) => {
            if (orderStatus[`${item}`].status) {
              currentOrderStatus = item;
            }
          });

          if (currentOrderStatus) {
            let nextStatusIndex = statusArray.indexOf(currentOrderStatus) + 1;

            if (paymentMethod === "COD" && currentOrderStatus === "pending") {
              nextStatusIndex = 2;
            }

            const nextStatus = statusArray[nextStatusIndex];

            newOrderStatus = orderStatus;

            const nowTimestamp = firestore.Timestamp.now().toMillis();

            newOrderStatus[`${currentOrderStatus}`].status = false;

            newOrderStatus[`${nextStatus}`] = {
              status: true,
              updatedAt: nowTimestamp,
            };

            transaction.update(orderRef, {
              orderStatus: newOrderStatus,
              updatedAt: nowTimestamp,
            });

            if (nextStatus === "shipped") {
              const { creditData } = merchantData;
              const {
                credits,
                creditThreshold,
                transactionFeePercentage,
              } = creditData;
              const transactionFee =
                Math.round(subTotal * transactionFeePercentage) / 100;
              const newCredits = credits - transactionFee;
              const newCreditThresholdReached =
                newCredits < creditThreshold ? true : false;

              transaction.update(merchantRef, {
                ["creditData.credits"]: newCredits,
                ["creditData.creditThresholdReached"]: newCreditThresholdReached,
              });

              const fcmTokens = merchantData.fcmTokens
                ? merchantData.fcmTokens
                : [];

              const orderNotifications = [];

              if (newCreditThresholdReached) {
                fcmTokens.map((token) => {
                  orderNotifications.push({
                    notification: {
                      title: "WARNING: You've run out of Markee credits!",
                      body: `"Please top up in order to receive more orders.
                If you need assistance, please email us at support@marketeer.ph and we will help you load up."`,
                    },
                    token,
                  });
                });
              }

              if (newCredits <= creditThreshold * 2) {
                fcmTokens.map((token) => {
                  orderNotifications.push({
                    notification: {
                      title: `WARNING: You only have ${newCredits} Markee credits left!`,
                      body: `"Please top up before reaching your Markee credit threshold limit of ${creditThreshold} in order to receive more orders.
                If you need assistance, please email us at support@marketeer.ph and we will help you load up."`,
                    },
                    data: {
                      type: "markee_credits",
                    },
                    token,
                  });
                });
              }

              orderNotifications.length > 0 && fcmTokens.length > 0
                ? await admin.messaging().sendAll(orderNotifications)
                : null;
            }

            return { orderData, merchantData, nextStatus, paymentMethod };
          } else {
            throw new Error("No order status");
          }
        })
        .then(
          async ({ orderData, merchantData, nextStatus, paymentMethod }) => {
            const { userId, userOrderNumber } = orderData;
            const { storeName } = merchantData;

            const userData = (
              await db.collection("users").doc(userId).get()
            ).data();

            const fcmTokens = userData.fcmTokens ? userData.fcmTokens : [];

            const orderNotifications = [];

            let notificationTitle = "";
            let notificationBody = "";

            if (nextStatus === "unpaid" && paymentMethod === "Online Payment") {
              notificationTitle = "Your order has been confirmed!";
              notificationBody = `Order # ${userOrderNumber} is now waiting for your payment. Pay for your order now by contacting ${storeName} through our chat in the Orders Screen.`;
            } else if (
              nextStatus === "unpaid" &&
              paymentMethod === "Online Payment"
            ) {
              notificationTitle = "Your order has been confirmed!";
              notificationBody = `Order # ${userOrderNumber} is now waiting for your payment. Pay for your order now by visiting the orders page or by pressing here.`;
            } else if (
              nextStatus === "paid" &&
              paymentMethod === "Online Payment"
            ) {
              notificationTitle = "Your order has been marked as paid!";
              notificationBody = `Order # ${userOrderNumber} is now being processed by ${storeName}! Please be on the lookout for updates by ${storeName} in the chat.`;
            } else if (nextStatus === "paid" && paymentMethod === "COD") {
              notificationTitle = "Your order has been confirmed!";
              notificationBody = `Order # ${userOrderNumber} is now being processed by ${storeName}! Please be on the lookout for updates by ${storeName} in the chat.`;
            } else if (
              nextStatus === "paid" &&
              paymentMethod === "Online Banking"
            ) {
              notificationTitle =
                "You've successfully paid for your order online!";
              notificationBody = `Order # ${userOrderNumber} is now being processed by ${storeName}! Please be on the lookout for updates by ${storeName} in the chat.`;
            } else if (nextStatus === "shipped") {
              notificationTitle = "Your order has been shipped!";
              notificationBody = `Order # ${userOrderNumber} has now been shipped! Please wait for your order to arrive and get ready to pay if you ordered via COD. Thank you for shopping using Marketeer!`;
            } else if (nextStatus === "completed") {
              notificationTitle = "Your order is now marked as complete!";
              notificationBody = `Enjoy the goodies from ${storeName}! If you liked the service, please share your experience with others by placing a review. We hope to serve you again soon!`;
            }

            fcmTokens.map((token) => {
              orderNotifications.push({
                notification: {
                  title: notificationTitle,
                  body: notificationBody,
                },
                data: {
                  type: "order_update",
                  orderId,
                },
                token,
              });
            });

            orderNotifications.length > 0 && fcmTokens.length > 0
              ? await admin.messaging().sendAll(orderNotifications)
              : null;

            return { s: 200, m: "Order status successfully updated!" };
          }
        );
    } catch (e) {
      return { s: 400, m: `Error, something went wrong: ${e}` };
    }
  });

exports.cancelOrder = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, cancelReason } = data;
    const userId = context.auth.uid;
    const merchantId = context.auth.token.merchantId;

    if (!userId || !merchantId) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (orderId === undefined || cancelReason === undefined) {
      return { s: 400, m: "Bad argument: Incomplete Information" };
    }

    try {
      return await db
        .runTransaction(async (transaction) => {
          const orderRef = firestore().collection("orders").doc(orderId);
          const merchantRef = firestore()
            .collection("merchants")
            .doc(merchantId);

          return await transaction
            .getAll(orderRef, merchantRef)
            .then((documents) => {
              const orderData = documents[0].data();
              const merchantData = documents[1].data();

              if (orderData.merchantId !== merchantId) {
                throw new Error("Order does not correspond with merchant id");
              }

              const { orderStatus } = orderData;

              let newOrderStatus = {};
              let currentStatus;

              Object.keys(orderStatus).map((item, index) => {
                if (orderStatus[`${item}`].status) {
                  currentStatus = item;
                }
              });

              if (
                currentStatus === "paid" ||
                currentStatus === "shipped" ||
                currentStatus === "completed" ||
                currentStatus === "cancelled"
              ) {
                throw new Error(
                  "Error: Order is not pending or unpaid, and thus cannot be cancelled"
                );
              }

              newOrderStatus = orderStatus;

              newOrderStatus[`${currentStatus}`].status = false;

              const nowTimestamp = firestore.Timestamp.now().toMillis();

              newOrderStatus.cancelled = {
                status: true,
                reason: cancelReason,
                updatedAt: nowTimestamp,
              };

              transaction.update(orderRef, {
                orderStatus: newOrderStatus,
                updatedAt: nowTimestamp,
              });

              return { orderData, merchantData };
            });
        })
        .then(async ({ orderData, merchantData }) => {
          const { userId, userOrderNumber } = orderData;
          const { storeName } = merchantData;

          const userData = (
            await db.collection("users").doc(userId).get()
          ).data();

          const fcmTokens = userData.fcmTokens ? userData.fcmTokens : [];

          const orderNotifications = [];

          const notificationTitle = "Sorry, your order has been cancelled.";
          const notificationBody = `Order # ${userOrderNumber} has been cancelled by ${storeName}. You may check the reason for cancellation by visiting the orders page.`;

          fcmTokens.map((token) => {
            orderNotifications.push({
              notification: {
                title: notificationTitle,
                body: notificationBody,
              },
              data: {
                type: "order_update",
                orderId,
              },
              token,
            });
          });

          orderNotifications.length > 0 && fcmTokens.length > 0
            ? await admin.messaging().sendAll(orderNotifications)
            : null;

          return { s: 200, m: "Order successfully cancelled!" };
        });
    } catch (e) {
      return { s: 400, m: e };
    }
  });

exports.getAddressFromCoordinates = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { latitude, longitude } = data;
    let locationDetails = null;

    if (!context.auth.uid) {
      return { s: 400, m: "Error: User is not authenticated" };
    }

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
            functions.logger.log("Error in getAddressFromCoordinates", e);
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
      deliveryCoordinatesGeohash,
      deliveryAddress,
      userCoordinates,
      userName,
      storeSelectedDeliveryMethod,
      storeSelectedPaymentMethod,
    } = JSON.parse(orderInfo);

    const userId = context.auth.uid;
    const userPhoneNumber = context.auth.token.phone_number;

    if (!userId || !userPhoneNumber) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    try {
      const userRef = db.collection("users").doc(userId);
      const userCartRef = db.collection("user_carts").doc(userId);

      const storeCartItems = (await userCartRef.get()).data();
      const cartStores = storeCartItems
        ? [...Object.keys(storeCartItems)]
        : null;

      if (
        deliveryCoordinates === undefined ||
        deliveryAddress === undefined ||
        userCoordinates === undefined ||
        userName === undefined ||
        storeCartItems === undefined ||
        storeSelectedDeliveryMethod === undefined ||
        storeSelectedPaymentMethod === undefined
      ) {
        return { s: 400, m: "Bad argument: Incomplete request" };
      }

      const orderStatus = {
        pending: {
          status: true,
          updatedAt: firestore.Timestamp.now().toMillis(),
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

      return await Promise.all(
        cartStores.map(async (merchantId) => {
          return await db
            .runTransaction(async (transaction) => {
              const merchantRef = db.collection("merchants").doc(merchantId);
              const merchantItemDocs = [];
              const merchantItemRefs = [];

              await storeCartItems[merchantId].map((item) => {
                if (!merchantItemDocs.includes(item.doc)) {
                  const itemRef = db
                    .collection("merchants")
                    .doc(merchantId)
                    .collection("items")
                    .doc(item.doc);

                  merchantItemRefs.push(itemRef);
                  merchantItemDocs.push(item.doc);
                }
              });

              const currentStoreItems = [];
              let userData = {};
              let storeDetails = {};

              return await transaction
                .getAll(userRef, merchantRef, ...merchantItemRefs)
                .then(async (documents) => {
                  const userDoc = documents[0];
                  const merchantDoc = documents[1];
                  const merchantItemsDocs = documents.slice(
                    2,
                    documents.length
                  );

                  await merchantItemsDocs.map((merchantItemDoc) => {
                    currentStoreItems.push(...merchantItemDoc.data().items);
                  });

                  if (userDoc.exists) {
                    userData = userDoc.data();
                  } else {
                    functions.logger.error("Error: User does not exist!");
                  }

                  if (merchantDoc.exists) {
                    storeDetails = merchantDoc.data();
                  } else {
                    throw new Error(
                      `Sorry, a store you ordered from does not exist. Please try again or place another order from another store.`
                    );
                  }

                  if (
                    !storeDetails.visibleToPublic ||
                    storeDetails.vacationMode
                  ) {
                    throw new Error(
                      `Sorry, ${storeDetails.storeName} is currently on vacation. Please try again later.`
                    );
                  }

                  if (storeDetails.creditData.creditThresholdReached) {
                    throw new Error(
                      `Sorry, ${storeDetails.storeName} is currently not available. Please try again later.`
                    );
                  }

                  const currentUserOrderNumber = userData.orderNumber
                    ? userData.orderNumber
                    : 0;

                  const currentMerchantOrderNumber = storeDetails.orderNumber
                    ? storeDetails.orderNumber
                    : 0;

                  let quantity = 0;
                  let subTotal = 0;

                  const orderItems = storeCartItems[merchantId];
                  const deliveryMethod =
                    storeSelectedDeliveryMethod[merchantId];
                  const paymentMethod = storeSelectedPaymentMethod[merchantId];

                  await orderItems.map((orderItem) => {
                    quantity = orderItem.quantity + quantity;
                    subTotal = orderItem.price * orderItem.quantity + subTotal;

                    const currentStoreItemIndex = currentStoreItems.findIndex(
                      (storeItem) => storeItem.itemId === orderItem.itemId
                    );

                    const currentStoreItem =
                      currentStoreItems[currentStoreItemIndex];

                    currentStoreItem.stock -= orderItem.quantity;

                    currentStoreItem.sales += orderItem.quantity;

                    if (currentStoreItem.stock < 0) {
                      const error = `Not enough stocks for item "${orderItem.name}" from "${storeDetails.storeName}. Please update your cart."`;
                      throw new Error(error);
                    }
                  });

                  const timeStamp = firestore.Timestamp.now().toMillis();
                  const newMerchantOrderNumber = currentMerchantOrderNumber + 1;
                  const newUserOrderNumber = currentUserOrderNumber + 1;
                  const freeDelivery =
                    deliveryMethod === "Own Delivery" &&
                    subTotal >= storeDetails.freeDeliveryMinimum &&
                    storeDetails.freeDelivery;
                  const deliveryPrice = freeDelivery
                    ? 0
                    : deliveryMethod !== "Own Delivery"
                    ? null
                    : storeDetails.ownDeliveryServiceFee;

                  const orderDetails = {
                    reviewed: false,
                    userCoordinates,
                    deliveryCoordinates,
                    deliveryAddress,
                    userName,
                    userPhoneNumber,
                    userId,
                    createdAt: timeStamp,
                    updatedAt: timeStamp,
                    orderStatus,
                    quantity,
                    subTotal,
                    freeDelivery,
                    deliveryMethod,
                    deliveryPrice,
                    merchantId,
                    storeName: storeDetails.storeName,
                    paymentMethod,
                    merchantOrderNumber: newMerchantOrderNumber,
                    userOrderNumber: newUserOrderNumber,
                  };

                  const ordersRef = firestore().collection("orders");
                  const orderItemsRef = firestore().collection("order_items");
                  const orderId = ordersRef.doc().id;

                  // Place order
                  transaction.set(orderItemsRef.doc(orderId), {
                    items: orderItems,
                    merchantId,
                    userId,
                  });
                  transaction.set(ordersRef.doc(orderId), {
                    ...orderDetails,
                    messages: [],
                  });

                  // Update order number
                  transaction.update(merchantRef, {
                    orderNumber: newMerchantOrderNumber,
                  });

                  transaction.update(userRef, {
                    orderNumber: newUserOrderNumber,
                    addresses: {
                      Home: {
                        coordinates: { ...deliveryCoordinates },
                        geohash: deliveryCoordinatesGeohash,
                        address: deliveryAddress,
                      },
                    },
                  });

                  // Update store item document quantities
                  merchantItemDocs.map(async (merchantItemDoc) => {
                    const docItems = await currentStoreItems.filter(
                      (item) => item.doc === merchantItemDoc
                    );
                    const merchantItemDocRef = db
                      .collection("merchants")
                      .doc(merchantId)
                      .collection("items")
                      .doc(merchantItemDoc);

                    transaction.update(merchantItemDocRef, {
                      items: [...docItems],
                    });
                  });

                  transaction.update(userCartRef, {
                    [merchantId]: firestore.FieldValue.delete(),
                  });

                  return { orderDetails, storeDetails, orderId };
                });
            })
            .then(async ({ orderDetails, storeDetails, orderId }) => {
              // Send Order Notification to merchant
              let fcmTokens = [];

              fcmTokens = storeDetails.fcmTokens && [...storeDetails.fcmTokens];

              const { merchantOrderNumber, subTotal } = orderDetails;
              const orderNotifications = [];

              if (fcmTokens) {
                fcmTokens.map((token) => {
                  orderNotifications.push({
                    notification: {
                      title: "You've got a new order!",
                      body: `Order # ${merchantOrderNumber}; Order Total: ${subTotal}`,
                    },
                    data: {
                      type: "new_order",
                      orderId,
                    },
                    token,
                  });
                });
              }

              orderNotifications.length > 0
                ? await admin.messaging().sendAll(orderNotifications)
                : functions.logger.log(`No fcm token found for ${merchantId}`);

              return {
                s: 200,
                m: `Order placed for ${storeDetails.storeName}`,
              };
            });
        })
      );
    } catch (e) {
      return { s: 400, m: `${e}` };
    }
  });

exports.addReview = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, merchantId, reviewBody, rating } = data;
    const userId = context.auth.uid;
    const userName = context.auth.token.name || null;
    const userPhoneNumber = context.auth.token.phone_number;

    if (!userId || !userPhoneNumber) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (orderId === undefined || rating === undefined) {
      return { s: 400, m: "Bad argument: Incomplete data" };
    }

    try {
      return db.runTransaction(async (transaction) => {
        const orderRef = db.collection("orders").doc(orderId);
        const merchantRef = db.collection("merchants").doc(merchantId);
        let orderReviewPage = 0;
        let newRatingAverage = 0;

        return await transaction
          .getAll(orderRef, merchantRef)
          .then((documents) => {
            const orderDoc = documents[0];
            const merchantDoc = documents[1];
            const timeStamp = firestore.Timestamp.now().toMillis();

            const review = {
              reviewBody,
              rating,
              orderId,
              userId,
              userName,
              createdAt: timeStamp,
            };

            if (orderDoc.exists) {
              if (orderDoc.data().reviewed) {
                throw new Error("The order is already reviewed");
              } else if (orderDoc.data().merchantId !== merchantId) {
                throw new Error("Merchant Ids do not match");
              } else {
                transaction.update(orderDoc.ref, {
                  reviewed: true,
                  updatedAt: timeStamp,
                });
              }
            }

            if (merchantDoc.exists) {
              const { reviewNumber, ratingAverage } = merchantDoc.data();

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

                transaction.update(orderReviewPageRef, {
                  reviews: firestore.FieldValue.arrayUnion(review),
                });
              } else {
                newRatingAverage = rating;

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
            } else {
              return { s: 500, m: "Error, merchant was not found" };
            }

            return { s: 200, m: "Review placed!" };
          });
      });
    } catch (e) {
      return { s: 400, m: e };
    }
  });

exports.addStoreItem = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { item } = data;
    const merchantId = context.auth.token.merchantId || null;

    if (!merchantId) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (item === undefined) {
      return { s: 400, m: "Bad argument: Incomplete data" };
    }

    const merchantItemsRef = db
      .collection("merchants")
      .doc(merchantId)
      .collection("items");

    try {
      let newItem = JSON.parse(item);
      let merchantItemsDocId = null;

      functions.logger.log(merchantId);

      await merchantItemsRef
        .where("itemNumber", "<", 1500)
        .orderBy("itemNumber", "desc")
        .limit(1)
        .get()
        .then((querySnapshot) => {
          if (!querySnapshot.empty) {
            querySnapshot.forEach((doc, index) => {
              merchantItemsDocId = doc.id;
            });

            return functions.logger.log("exist");
          }

          return functions.logger.log("does not exist");
        });

      functions.logger.log(merchantItemsDocId);

      if (merchantItemsDocId) {
        const merchantItemsDoc = db
          .collection("merchants")
          .doc(merchantId)
          .collection("items")
          .doc(merchantItemsDocId);

        newItem.doc = merchantItemsDocId;

        return await merchantItemsDoc
          .update({
            items: firestore.FieldValue.arrayUnion(newItem),
            itemNumber: firestore.FieldValue.increment(1),
            updatedAt: newItem.updatedAt,
          })
          .then(() => {
            return { s: 200, m: "Item Added!" };
          });
      } else {
        const initialMerchantItemsRef = merchantItemsRef.doc();
        newItem.doc = initialMerchantItemsRef.id;

        return await merchantItemsRef
          .doc(initialMerchantItemsRef.id)
          .set({
            items: [newItem],
            itemNumber: 1,
            updatedAt: newItem.updatedAt,
            createdAt: newItem.createdAt,
          })
          .then(() => {
            return { s: 200, m: "Item Added!" };
          });
      }
    } catch (e) {
      return { s: 400, m: e };
    }
  });

exports.setMerchantAdminToken = functions
  .region("asia-northeast1")
  .firestore.document("merchant_admins/{merchantId}")
  .onWrite(async (change, context) => {
    const newData = change.after.exists ? change.after.data() : null;
    const previousData = change.before.exists ? change.before.data() : null;
    const newDataLength = newData ? Object.keys(newData).length : 0;
    const previousDataLength = previousData
      ? Object.keys(previousData).length
      : 0;

    const merchantId = context.params.merchantId;
    const merchantIds = { [context.params.merchantId]: true };
    const role = "admin";

    if (newDataLength >= previousDataLength) {
      Object.entries(newData).map(async ([userId, value]) => {
        if (value === false) {
          const previousUserCustomClaims = (await admin.auth().getUser(userId))
            .customClaims;

          functions.logger.log(
            `previousUserCustomClaims of ${userId}: ${previousUserCustomClaims}`
          );

          return await admin
            .auth()
            .setCustomUserClaims(userId, { merchantId, merchantIds, role })
            .then(async () => {
              const newUserCustomClaims = (await admin.auth().getUser(userId))
                .customClaims;

              functions.logger.log(
                `newUserCustomClaims of ${userId}: ${newUserCustomClaims}`
              );

              await firestore()
                .collection("merchant_admins")
                .doc(merchantId)
                .update({
                  [userId]: true,
                })
                .catch((err) => {
                  return functions.logger.error(err);
                });

              return functions.logger.log(
                `Added ${merchantId} token to ${userId}`
              );
            })
            .catch((err) => {
              return functions.logger.error(err);
            });
        } else {
          functions.logger.log(`${userId} already set`);
        }
      });
    } else if (newDataLength < previousDataLength) {
      Object.entries(previousData).map(async ([userId, value]) => {
        if (!Object.keys(newData).includes(userId)) {
          return await admin
            .auth()
            .setCustomUserClaims(userId, null)
            .then(() => {
              return functions.logger.log(
                `Removed ${merchantId} token from ${userId}`
              );
            })
            .catch((err) => {
              return functions.logger.error(err);
            });
        }
      });
    } else {
      functions.logger.log("No user IDs");
    }
  });

exports.sendMessageNotification = functions
  .region("asia-northeast1")
  .firestore.document("orders/{orderId}")
  .onUpdate(async (change, context) => {
    const orderId = change.after.id;
    const newValue = change.after.data();
    const previousValue = change.before.data();
    const {
      merchantId,
      userId,
      merchantOrderNumber,
      userOrderNumber,
      userName,
      storeName,
    } = newValue;

    if (newValue.messages.length !== previousValue.messages.length) {
      const lastMessage = newValue.messages.slice(-1).pop();
      const receivingUserData =
        lastMessage.user._id === merchantId
          ? (await firestore().collection("users").doc(userId).get()).data()
          : (
              await firestore().collection("merchants").doc(merchantId).get()
            ).data();
      const receivingUserFcmTokens = receivingUserData.fcmTokens;
      const receivingUserName =
        lastMessage.user._id === merchantId ? storeName : userName;
      const orderNumber =
        lastMessage.user._id === merchantId
          ? userOrderNumber
          : merchantOrderNumber;

      let messageNotifications = [];

      const body = lastMessage.text
        ? `${receivingUserName}: ${lastMessage.text}`
        : `${receivingUserName} sent you an image`;

      if (receivingUserFcmTokens) {
        receivingUserFcmTokens.map((token) => {
          messageNotifications.push({
            notification: {
              title: `New message regarding Order #${orderNumber}`,
              body,
            },
            data: {
              type: "order_message",
              orderId,
            },
            token,
          });
        });
      }

      messageNotifications.length > 0 && receivingUserFcmTokens.length > 0
        ? await admin.messaging().sendAll(messageNotifications)
        : null;
    }
  });
