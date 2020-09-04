/* eslint-disable promise/no-nesting */
const functions = require("firebase-functions");
const firebase = require("firebase");
const { firestore } = require("firebase-admin");
const { FB_CONFIG, HERE_API_KEY } = require("./util/config");
const { db, admin } = require("./util/admin");
const firestoreGCP = require("@google-cloud/firestore");
const client = new firestoreGCP.v1.FirestoreAdminClient();
const mkdirp = require("mkdirp");
const spawn = require("child-process-promise").spawn;
const path = require("path");
const os = require("os");
const fs = require("fs");
const request = require("request");

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
  executePayoutTest,
  getOrderPaymentLinkTest,
} = require("./handlers/payments_test");
const { document } = require("firebase-functions/lib/providers/firestore");

const ipAddressTest = async (req, res) => {
  return request.get(
    "https://api.ipify.org?format=json",
    (error, response, body) => {
      functions.logger.log("error:", error); // Print the error if one occurred
      functions.logger.log("statusCode:", response && response.statusCode); // Print the response status code if a response was received
      functions.logger.log("body:", body); //Prints the response of the request.

      res.status(200).send(response);
    }
  );
};

const copyCollection = async (req, res) => {
  const {
    srcDocumentName,
    firstSrcCollectionName,
    secondSrcCollectionName,
    destDocumentName,
    firstDestCollectionName,
    secondDestCollectionName,
  } = req.body;

  const documents = await db
    .collection(firstSrcCollectionName)
    .doc(srcDocumentName)
    .collection(secondSrcCollectionName)
    .get();
  let writeBatch = admin.firestore().batch();
  const destCollection = db
    .collection(firstDestCollectionName)
    .doc(destDocumentName)
    .collection(secondDestCollectionName);
  let i = 0;
  for (const doc of documents.docs) {
    writeBatch.set(destCollection.doc(doc.id), doc.data());
    i++;
    if (i > 400) {
      // write batch only allows maximum 500 writes per batch
      i = 0;
      writeBatch = admin.firestore().batch();
      writeBatch.commit();

      functions.logger.log("Intermediate committing of batch operation");
    }
  }
  if (i > 0) {
    functions.logger.log(
      "Firebase batch operation completed. Doing final committing of batch operation."
    );
    await writeBatch.commit();
  } else {
    functions.logger.log("Firebase batch operation completed.");
  }
};

app.post("/payment/checkPaymentTest", checkPaymentTest);
app.get("/payment/resultTest", resultTest);
// app.get("/ipAddressTest", ipAddressTest);
// app.post("/copyCollection", copyCollection);

exports.getMerchantPaymentLinkTest = getMerchantPaymentLinkTest;
exports.getOrderPaymentLinkTest = getOrderPaymentLinkTest;
exports.executePayoutTest = executePayoutTest;
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

exports.sendPasswordResetLinkToStoreUser = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { email, storeId } = data;

    try {
      if (email === undefined) {
        return { s: 400, m: "Bad argument: no phone number" };
      }

      const user = await admin.auth().getUserByEmail(email);

      if (!user) {
        return { s: 400, m: "Bad argument: Email could not be found" };
      }

      if (!user.customClaims.storeIds) {
        return {
          s: 400,
          m: "Bad argument: Email is not assigned to any store",
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
    const { orderId, storeId, merchantId } = data;
    const userId = context.auth.uid;
    const storeIds = context.auth.token.storeIds;

    if (!userId || !storeIds) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (!orderId || !storeId || !merchantId) {
      return { s: 400, m: "Bad argument: Incomplete details" };
    }

    try {
      return db.runTransaction(async (transaction) => {
        const orderRef = db.collection("orders").doc(orderId);
        const storeRef = db.collection("stores").doc(storeId);
        const merchantRef = db.collection("merchants").doc(merchantId);
        const CREDIT_THRESHOLD_MULTIPLIER = 2;
        const statusArray = [
          "pending",
          "unpaid",
          "paid",
          "shipped",
          "completed",
        ];

        let orderData, storeData, merchantData;

        return await transaction
          .getAll(orderRef, storeRef, merchantRef)
          .then(async (documents) => {
            const orderDoc = documents[0];
            const storeDoc = documents[1];
            const merchantDoc = documents[2];

            orderData = orderDoc.data();
            storeData = storeDoc.data();
            merchantData = merchantDoc.data();

            const { storeId, orderStatus, paymentMethod, subTotal } = orderData;
            const { stores, creditData } = merchantData;
            const {
              credits,
              creditThreshold,
              transactionFeePercentage,
            } = creditData;

            const userStoreRoles = storeIds[storeId];

            if (!(await stores.find((store) => storeId === store))) {
              throw new Error(
                "Supplied storeId does not correspond with merchant id"
              );
            }

            if (!userStoreRoles) {
              throw new Error("Order does not correspond with store id");
            }

            if (
              !userStoreRoles.includes("admin") &&
              !userStoreRoles.includes("manager") &&
              !userStoreRoles.includes("cashier")
            ) {
              throw new Error(
                "User does not have required permissions. Please contact Marketeer support to set a role for your account if required."
              );
            }

            if (credits < creditThreshold) {
              throw new Error(
                "You have reached the Markee credit threshold! Please load up in order to process more orders. If you have any problems, please contact Marketeer Support at support@marketeer.ph"
              );
            }

            let currentOrderStatus = null;
            let newOrderStatus = { ...orderStatus };

            await Object.keys(orderStatus).map((item, index) => {
              if (orderStatus[`${item}`].status) {
                currentOrderStatus = item;
              }
            });

            if (currentOrderStatus) {
              const nowTimestamp = firestore.Timestamp.now().toMillis();
              let nextStatusIndex = statusArray.indexOf(currentOrderStatus) + 1;

              if (paymentMethod === "COD" && currentOrderStatus === "pending") {
                nextStatusIndex = 2;
              }

              if (
                paymentMethod === "Online Banking" &&
                currentOrderStatus === "unpaid"
              ) {
                throw new Error(
                  "Sorry, you cannot manually change an Online Banking Order's status when it is unpaid."
                );
              }

              const nextStatus = statusArray[nextStatusIndex];
              newOrderStatus[`${currentOrderStatus}`].status = false;
              newOrderStatus[`${nextStatus}`] = {
                status: true,
                updatedAt: nowTimestamp,
              };

              let orderUpdateData = {
                orderStatus: newOrderStatus,
                updatedAt: nowTimestamp,
              };

              if (
                paymentMethod === "Online Banking" &&
                currentOrderStatus === "pending"
              ) {
                orderUpdateData.paymentLink = await getOrderPaymentLinkTest({
                  orderData,
                  orderId,
                });
              }

              transaction.update(orderRef, {
                ...orderUpdateData,
              });

              if (nextStatus === "shipped") {
                const transactionFee =
                  Math.round(subTotal * transactionFeePercentage) / 100;
                const newCredits = credits - transactionFee;

                transaction.update(merchantRef, {
                  ["creditData.credits"]: newCredits,
                });

                const fcmTokens = storeData.fcmTokens
                  ? storeData.fcmTokens
                  : [];
                const orderNotifications = [];

                if (newCredits < creditThreshold) {
                  fcmTokens.map((token) => {
                    orderNotifications.push({
                      notification: {
                        title: "WARNING: You've run out of Markee credits!",
                        body: `"Please top up your Markee Credits in order to receive more orders.
                If you need assistance, please email us at support@marketeer.ph and we will help you load up."`,
                      },
                      token,
                    });
                  });
                }

                if (
                  newCredits <=
                  creditThreshold * CREDIT_THRESHOLD_MULTIPLIER
                ) {
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

              return { orderData, storeData, nextStatus, paymentMethod };
            } else {
              throw new Error("No order status");
            }
          })
          .then(async ({ orderData, storeData, nextStatus, paymentMethod }) => {
            const { userId, userOrderNumber } = orderData;
            const { storeName } = storeData;

            const userData = (
              await db.collection("users").doc(userId).get()
            ).data();

            const fcmTokens = userData.fcmTokens ? userData.fcmTokens : [];

            const orderNotifications = [];

            let notificationTitle = "";
            let notificationBody = "";
            let type = "";

            if (nextStatus === "unpaid") {
              if (paymentMethod === "Online Payment") {
                notificationTitle = "Your order has been confirmed!";
                notificationBody = `Order #${userOrderNumber} is now waiting for your payment. Pay for your order now by contacting ${storeName} through the Marketeer chat screen.`;
                type = "order_cart";
              }

              if (paymentMethod === "Online Banking") {
                notificationTitle = "Your order has been confirmed!";
                notificationBody = `Order #${userOrderNumber} is now waiting for your payment. Pay for your order now by visiting the orders page or by pressing here.`;
                type = "order_payment";
              }
            }

            if (nextStatus === "paid") {
              if (paymentMethod === "COD") {
                notificationTitle = "Your order has been confirmed!";
              }

              if (paymentMethod === "Online Payment") {
                notificationTitle = "Your order has been marked as paid!";
              }

              if (paymentMethod === "Online Banking") {
                notificationTitle =
                  "You've successfully paid for your order online!";
              }

              notificationBody = `Order #${userOrderNumber} is now being processed by ${storeName}! Please be on the lookout for updates by ${storeName} in the chat.`;
              type = "order_details";
            }

            if (nextStatus === "shipped") {
              notificationTitle = "Your order has been shipped!";
              notificationBody = `Order # ${userOrderNumber} has now been shipped! Please wait for your order to arrive and get ready to pay if you ordered via COD. Thank you for shopping using Marketeer!`;
              type = "order_details";
            }

            if (nextStatus === "completed") {
              notificationTitle = "Your order is now marked as complete!";
              notificationBody = `Enjoy the goodies from ${storeName}! If you liked the service, please share your experience with others by placing a review. We hope to serve you again soon!`;
              type = "order_review";
            }

            fcmTokens.map((token) => {
              orderNotifications.push({
                notification: {
                  title: notificationTitle,
                  body: notificationBody,
                },
                data: {
                  type,
                  orderId,
                },
                token,
              });
            });

            orderNotifications.length > 0 && fcmTokens.length > 0
              ? await admin.messaging().sendAll(orderNotifications)
              : null;

            return { s: 200, m: "Order status successfully updated!" };
          });
      });
    } catch (e) {
      return { s: 400, m: `Error, something went wrong: ${e}` };
    }
  });

exports.cancelOrder = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, cancelReason } = data;
    const userId = context.auth.uid;
    const storeIds = context.auth.token.storeIds;

    if (!userId || !storeIds) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (orderId === undefined || cancelReason === undefined) {
      return { s: 400, m: "Bad argument: Incomplete Information" };
    }

    try {
      return await db
        .runTransaction(async (transaction) => {
          const orderRef = firestore().collection("orders").doc(orderId);

          return await transaction.get(orderRef).then((document) => {
            const orderData = document.data();
            const { storeId } = orderData;
            const userStoreRoles = storeIds[storeId];

            if (storeIds && !userStoreRoles) {
              throw new Error("Order does not correspond with store id");
            }

            if (
              !userStoreRoles.includes("admin") &&
              !userStoreRoles.includes("cashier") &&
              !userStoreRoles.includes("manager")
            ) {
              throw new Error(
                "User does not have required permissions. Please contact Marketeer support to set a role for your account if required."
              );
            }

            if (!storeIds && userId && orderData.userId !== userId) {
              throw new Error("Order does not correspond with current user");
            }

            const {
              orderStatus,
              paymentMethod,
              merchantOrderNumber,
              storeOrderNumber,
              userOrderNumber,
            } = orderData;

            let newOrderStatus = {};
            let currentStatus;

            Object.keys(orderStatus).map((item, index) => {
              if (orderStatus[`${item}`].status) {
                currentStatus = item;
              }
            });

            if (
              (currentStatus === "paid" && paymentMethod !== "COD") ||
              currentStatus === "shipped" ||
              currentStatus === "completed" ||
              currentStatus === "cancelled"
            ) {
              throw new Error(
                `Sorry, Order #${
                  // eslint-disable-next-line promise/always-return
                  storeIds ? storeOrderNumber : userOrderNumber
                } cannot be cancelled. Please contact Marketeer Support if you think there may be something wrong. Thank you.`
              );
            }

            newOrderStatus = orderStatus;

            newOrderStatus[`${currentStatus}`].status = false;

            const nowTimestamp = firestore.Timestamp.now().toMillis();

            newOrderStatus.cancelled = {
              status: true,
              reason: cancelReason,
              byShopper: storeIds ? false : true,
              updatedAt: nowTimestamp,
            };

            transaction.update(orderRef, {
              orderStatus: newOrderStatus,
              updatedAt: nowTimestamp,
            });

            return { orderData };
          });
        })
        .then(async ({ orderData }) => {
          const { userId, userOrderNumber, storeId } = orderData;
          const { storeName } = (
            await firestore().collection("stores").doc(storeId).get()
          ).data();

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
      return { s: 400, m: e.message };
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
      userEmail,
      processId,
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
        !deliveryCoordinates ||
        !deliveryAddress ||
        !userCoordinates ||
        !userName ||
        !storeCartItems ||
        !storeSelectedDeliveryMethod ||
        !storeSelectedPaymentMethod
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
        cartStores.map(async (storeId) => {
          return await db
            .runTransaction(async (transaction) => {
              const storeRef = db.collection("stores").doc(storeId);
              const storeItemDocs = [];
              const storeItemRefs = [];

              await storeCartItems[storeId].map((item) => {
                if (!storeItemDocs.includes(item.doc)) {
                  const itemRef = db
                    .collection("stores")
                    .doc(storeId)
                    .collection("items")
                    .doc(item.doc);

                  storeItemRefs.push(itemRef);
                  storeItemDocs.push(item.doc);
                }
              });

              const currentStoreItems = [];
              let userData = {};
              let storeDetails = {};

              return await transaction
                .getAll(userRef, storeRef, ...storeItemRefs)
                .then(async (documents) => {
                  const userDoc = documents[0];
                  const storeDoc = documents[1];
                  const storeItemsDocs = documents.slice(2, documents.length);

                  await storeItemsDocs.map((storeItemDoc) => {
                    currentStoreItems.push(...storeItemDoc.data().items);
                  });

                  if (userDoc.exists) {
                    userData = userDoc.data();
                  } else {
                    functions.logger.error("Error: User does not exist!");
                  }

                  if (storeDoc.exists) {
                    storeDetails = storeDoc.data();
                  } else {
                    throw new Error(
                      `Sorry, a store you ordered from does not exist. Please try again or place another order from another store.`
                    );
                  }

                  if (
                    !storeDetails.devOnly &&
                    (!storeDetails.visibleToPublic || storeDetails.vacationMode)
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

                  const currentStoreOrderNumber = storeDetails.orderNumber
                    ? storeDetails.orderNumber
                    : 0;

                  let quantity = 0;
                  let subTotal = 0;

                  const orderItems = storeCartItems[storeId];
                  const deliveryMethod = storeSelectedDeliveryMethod[storeId];
                  const paymentMethod = storeSelectedPaymentMethod[storeId];

                  if (
                    paymentMethod === "Online Banking" &&
                    !(userEmail && processId)
                  ) {
                    return { s: 400, m: "Bad argument: Incomplete request" };
                  }

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
                  const newStoreOrderNumber = currentStoreOrderNumber + 1;
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
                  const email = userEmail;

                  let orderDetails = {
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
                    storeId,
                    storeName: storeDetails.storeName,
                    paymentMethod,
                    storeOrderNumber: newStoreOrderNumber,
                    merchantOrderNumber: newStoreOrderNumber,
                    userOrderNumber: newUserOrderNumber,
                  };

                  if (paymentMethod === "Online Banking") {
                    orderDetails.email = email;
                    orderDetails.processId = processId;
                  }

                  const ordersRef = firestore().collection("orders");
                  const orderItemsRef = firestore().collection("order_items");
                  const orderId = ordersRef.doc().id;

                  // Place order
                  transaction.set(orderItemsRef.doc(orderId), {
                    items: orderItems,
                    storeId,
                    userId,
                  });
                  transaction.set(ordersRef.doc(orderId), {
                    ...orderDetails,
                    messages: [],
                    userUnreadCount: 0,
                    storeUnreadCount: 0,
                  });

                  // Update order number
                  transaction.update(storeRef, {
                    orderNumber: newStoreOrderNumber,
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
                  storeItemDocs.map(async (storeItemDoc) => {
                    const docItems = await currentStoreItems.filter(
                      (item) => item.doc === storeItemDoc
                    );
                    const storeItemDocRef = db
                      .collection("stores")
                      .doc(storeId)
                      .collection("items")
                      .doc(storeItemDoc);

                    transaction.update(storeItemDocRef, {
                      items: [...docItems],
                    });
                  });

                  transaction.update(userCartRef, {
                    [storeId]: firestore.FieldValue.delete(),
                  });

                  return { orderDetails, storeDetails, orderId };
                });
            })
            .then(async ({ orderDetails, storeDetails, orderId }) => {
              // Send Order Notification to store
              let fcmTokens = [];

              fcmTokens = storeDetails.fcmTokens && [...storeDetails.fcmTokens];

              const {
                merchantOrderNumber,
                storeOrderNumber,
                subTotal,
              } = orderDetails;
              const orderNotifications = [];

              if (fcmTokens) {
                fcmTokens.map((token) => {
                  orderNotifications.push({
                    notification: {
                      title: "You've got a new order!",
                      body: `Order # ${storeOrderNumber}; Order Total: ${subTotal}`,
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
                : functions.logger.log(`No fcm token found for ${storeId}`);

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
    const { orderId, storeId, reviewBody, rating } = data;
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
        const storeRef = db.collection("stores").doc(storeId);
        let orderReviewPage = 0;
        let newRatingAverage = 0;

        return await transaction
          .getAll(orderRef, storeRef)
          .then((documents) => {
            const orderDoc = documents[0];
            const storeDoc = documents[1];
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
              } else if (orderDoc.data().storeId !== storeId) {
                throw new Error("Store Ids do not match");
              } else {
                transaction.update(orderDoc.ref, {
                  reviewed: true,
                  updatedAt: timeStamp,
                });
              }
            }

            if (storeDoc.exists) {
              const { reviewNumber, ratingAverage } = storeDoc.data();

              if (reviewNumber && ratingAverage) {
                orderReviewPage = Math.floor(reviewNumber / 2000);

                if (orderReviewPage <= 0) {
                  orderReviewPage = 1;
                }

                newRatingAverage = (ratingAverage + rating) / 2;

                const orderReviewPageRef = db
                  .collection("stores")
                  .doc(storeId)
                  .collection("order_reviews")
                  .doc(`${orderReviewPage}`);

                transaction.update(orderReviewPageRef, {
                  reviews: firestore.FieldValue.arrayUnion(review),
                });
              } else {
                newRatingAverage = rating;

                const firstOrderReviewPageRef = db
                  .collection("stores")
                  .doc(storeId)
                  .collection("order_reviews")
                  .doc("1");

                transaction.set(firstOrderReviewPageRef, {
                  reviews: [review],
                });
              }

              transaction.update(storeRef, {
                reviewNumber: firestore.FieldValue.increment(1),
                ratingAverage: newRatingAverage,
              });
            } else {
              return { s: 500, m: "Error, store was not found" };
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
    const { item, storeId, timeStamp } = data;
    const storeIds = context.auth.token.storeIds;

    if (!item || !storeId || !timeStamp) {
      return { s: 400, m: "Bad argument: Incomplete data" };
    }

    if (!storeIds) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    const userStoreRoles = storeIds[storeId];

    if (storeIds && !userStoreRoles) {
      return { s: 400, m: "Error: User is not authorized" };
    }

    if (
      !userStoreRoles.includes("admin") &&
      !userStoreRoles.includes("inventory_manager") &&
      !userStoreRoles.includes("manager")
    ) {
      return {
        s: 400,
        m:
          "Error: User does not have required permissions. Please contact Marketeer support to set a role for your account if required.",
      };
    }

    const storeItemsRef = db
      .collection("stores")
      .doc(storeId)
      .collection("items");

    try {
      let newItem = JSON.parse(item);
      let storeItemsDocId = null;

      await storeItemsRef
        .where("itemNumber", "<", 1500)
        .orderBy("itemNumber", "desc")
        .limit(1)
        .get()
        .then((querySnapshot) => {
          if (!querySnapshot.empty) {
            return querySnapshot.forEach((doc, index) => {
              storeItemsDocId = doc.id;
            });
          }

          return functions.logger.log("does not exist");
        });

      functions.logger.log(storeItemsDocId);

      if (storeItemsDocId) {
        const storeItemsDoc = db
          .collection("stores")
          .doc(storeId)
          .collection("items")
          .doc(storeItemsDocId);

        newItem.doc = storeItemsDocId;

        return await storeItemsDoc
          .update({
            items: firestore.FieldValue.arrayUnion(newItem),
            itemNumber: firestore.FieldValue.increment(1),
            updatedAt: newItem.updatedAt,
          })
          .then(() => {
            return { s: 200, m: "Item Added!" };
          });
      } else {
        const initialstoreItemsRef = storeItemsRef.doc();
        newItem.doc = initialstoreItemsRef.id;

        return await storeItemsRef
          .doc(initialstoreItemsRef.id)
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

exports.editUserStoreRoles = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { roles, userId, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId || !roles || !storeId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    let newStoreIds = { [storeId]: roles };
    /*
    const previousUserCustomClaims = (await admin.auth().getUser(userId))
      .customClaims;

    if (previousUserCustomClaims.storeIds) {
      newStoreIds = {
        ...previousUserCustomClaims.storeIds,
        [storeId]: roles,
      };
    }*/

    return await admin
      .auth()
      .setCustomUserClaims(userId, {
        storeIds: {
          ...newStoreIds,
        },
      })
      .then(async () => {
        await firestore()
          .collection("stores")
          .doc(storeId)
          .update({
            [`users.${userId}`]: roles,
          });

        return {
          s: 200,
          m: `Successfully added roles (${roles.map((role, index) => {
            return `${role}${roles.length - 1 !== index ? ", " : ""}`;
          })}) for ${storeId} to ${userId}!`,
        };
      });
  });

exports.setUserAsMerchant = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { userId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    const previousUserCustomClaims = (await admin.auth().getUser(userId))
      .customClaims;

    return await admin
      .auth()
      .setCustomUserClaims(userId, {
        ...previousUserCustomClaims,
        role: "merchant",
      })
      .then(async () => {
        await firestore()
          .collection("merchants")
          .doc(userId)
          .get()
          .then((document) => {
            if (!document.exists) {
              return document.ref.set({});
            }

            return null;
          });

        return {
          s: 200,
          m: `Successfully added "merchant" role to ${userId}!`,
        };
      });
  });

exports.assignStoreToMerchant = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { userId, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId || !storeId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    const userCustomClaims = (await admin.auth().getUser(userId)).customClaims;

    if (userCustomClaims.role !== "merchant") {
      return {
        s: 400,
        m:
          "Error: User is not set as a merchant. Please assign the user a merchant role first in order to assign a store to the user.",
      };
    }

    return await firestore()
      .collection("merchants")
      .doc(userId)
      .update({
        stores: firestore.FieldValue.arrayUnion(storeId),
      })
      .then(() => {
        return {
          s: 200,
          m: `Successfully assigned store ID "${storeId}" to ${userId}!`,
        };
      });
  });

exports.getUserFromEmail = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { email } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!email) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    return admin.auth().getUserByEmail(email);
  });

exports.getUserFromUserId = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { userIds } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userIds) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    return admin.auth().getUsers(userIds);
  });

exports.createStoreEmployeeAccount = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { email, password, role, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    try {
      return admin
        .auth()
        .getUserByEmail(email)
        .then(async (user) => {
          return {
            s: 400,
            m: `Error: User with email "${email}" already exists.`,
          };
        })
        .catch((error) => {
          if (error.code === "auth/user-not-found") {
            return admin
              .auth()
              .createUser({
                email,
                password,
              })
              .then(async (user) => {
                const userId = user.uid;
                const storeIds = { [storeId]: role };

                return await admin
                  .auth()
                  .setCustomUserClaims(userId, {
                    storeIds,
                  })
                  .then(async () => {
                    await firestore()
                      .collection("stores")
                      .doc(storeId)
                      .update({
                        [`users.${role}.${userId}`]: true,
                      });

                    return {
                      s: 200,
                      m: `Successfully added ${storeId} token to ${userId}`,
                    };
                  });
              });
          }

          return { s: 400, m: error };
        });
    } catch (error) {
      return { s: 400, m: error };
    }
  });

exports.setMarketeerAdminToken = functions
  .region("asia-northeast1")
  .firestore.document("marketeer_admins/userIds")
  .onWrite(async (change, context) => {
    const newData = change.after.exists ? change.after.data() : null;
    const previousData = change.before.exists ? change.before.data() : null;
    const newDataLength = newData ? Object.keys(newData).length : 0;
    const previousDataLength = previousData
      ? Object.keys(previousData).length
      : 0;

    const role = "marketeer-admin";

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
            .setCustomUserClaims(userId, { role })
            .then(async () => {
              const newUserCustomClaims = (await admin.auth().getUser(userId))
                .customClaims;

              functions.logger.log(
                `newUserCustomClaims of ${userId}: ${newUserCustomClaims}`
              );

              await firestore()
                .collection("marketeer_admins")
                .doc("userIds")
                .update({
                  [userId]: true,
                })
                .catch((err) => {
                  return functions.logger.error(err);
                });

              return functions.logger.log(
                `Added marketeer-admin token to ${userId}`
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
                `Removed marketeer-admin token from ${userId}`
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
      storeId,
      userId,
      merchantOrderNumber,
      storeOrderNumber,
      userOrderNumber,
      userName,
      storeName,
    } = newValue;

    if (newValue.messages.length !== previousValue.messages.length) {
      const lastMessage = newValue.messages.slice(-1).pop();
      const receivingUserData =
        lastMessage.user._id === storeId
          ? (await firestore().collection("users").doc(userId).get()).data()
          : (await firestore().collection("stores").doc(storeId).get()).data();
      const receivingUserFcmTokens = receivingUserData.fcmTokens;
      const receivingUserName =
        lastMessage.user._id === storeId ? storeName : userName;
      const orderNumber =
        lastMessage.user._id === storeId ? userOrderNumber : storeOrderNumber;

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

exports.generateThumbnail = functions.storage
  .object()
  .onFinalize(async (object) => {
    // Thumbnail prefix added to file names.
    const THUMB_PREFIX = "thumb_";

    // Max height and width of the thumbnail in pixels.
    const THUMB_MAX_HEIGHT = 360;
    const THUMB_MAX_WIDTH = 360;

    // File and directory paths.
    const filePath = object.name;
    const contentType = object.contentType; // This is the image MIME type
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const thumbFilePath = path.normalize(
      path.join(fileDir, `${THUMB_PREFIX}${fileName}`)
    );
    const tempLocalFile = path.join(os.tmpdir(), filePath);
    const tempLocalDir = path.dirname(tempLocalFile);
    const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

    functions.logger.log("directory", fileDir);
    if (
      fileDir.search("/images/orders") >= 0 ||
      fileDir.search("/images/store_categories") >= 0
    ) {
      return functions.logger.log("Will not process order images");
    }

    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith("image/")) {
      return functions.logger.log("This is not an image.");
    }

    // Exit if the image is already a thumbnail.
    if (fileName.startsWith(THUMB_PREFIX)) {
      return functions.logger.log("Already a Thumbnail.");
    }

    // Cloud Storage files.
    const bucket = admin.storage().bucket(object.bucket);
    const file = bucket.file(filePath);
    const metadata = {
      contentType: contentType,
      // To enable Client-side caching you can set the Cache-Control headers here. Uncomment below.
      // 'Cache-Control': 'public,max-age=3600',
    };

    // Create the temp directory where the storage file will be downloaded.
    await mkdirp(tempLocalDir);
    // Download file from bucket.
    await file.download({ destination: tempLocalFile });
    functions.logger.log("The file has been downloaded to", tempLocalFile);
    // Generate a thumbnail using ImageMagick.
    await spawn(
      "convert",
      [
        tempLocalFile,
        "-thumbnail",
        `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`,
        tempLocalThumbFile,
      ],
      { capture: ["stdout", "stderr"] }
    );
    functions.logger.log("Thumbnail created at", tempLocalThumbFile);
    // Uploading the Thumbnail.
    await bucket.upload(tempLocalThumbFile, {
      destination: thumbFilePath,
      metadata: metadata,
    });
    console.log("Thumbnail uploaded to Storage at", thumbFilePath);
    // Once the image has been uploaded delete the local files to free up disk space.
    fs.unlinkSync(tempLocalFile);
    fs.unlinkSync(tempLocalThumbFile);

    return functions.logger.log("Thumbnail saved to storage.");
  });
