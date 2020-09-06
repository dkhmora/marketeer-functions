/* eslint-disable promise/no-nesting */
const functions = require("firebase-functions");
const firebase = require("firebase");
const { firestore } = require("firebase-admin");
const { FB_CONFIG } = require("./util/config");
const { db, admin } = require("./util/admin");
const app = require("express")();

const {
  scheduledFirestoreExport,
  generateThumbnail,
} = require("./maintenance_services");
const {
  signInWithPhoneAndPassword,
  sendPasswordResetLinkToStoreUser,
} = require("./authentication");
const {
  getAddressFromCoordinates,
  placeOrder,
  cancelOrder,
  addReview,
  sendMessageNotification,
} = require("./user_services");
const { changeOrderStatus, addStoreItem } = require("./store_services");
const {
  setUserAsMerchant,
  assignStoreToMerchant,
  getUserFromEmail,
  getUserFromUserId,
  editUserStoreRoles,
  createStoreEmployeeAccount,
  setMarketeerAdminToken,
} = require("./admin_services");
const {
  checkPayment,
  result,
  getMerchantPaymentLink,
  getAvailablePaymentProcessors,
} = require("./payments");
const {
  checkPaymentTest,
  resultTest,
  getMerchantTopUpPaymentLinkTest,
  executePayoutTest,
} = require("./payments_test");

firebase.initializeApp({
  ...FB_CONFIG,
});

// ** Dragonpay Test **
app.post("/payment/checkPaymentTest", checkPaymentTest);
app.get("/payment/resultTest", resultTest);

exports.getMerchantTopUpPaymentLinkTest = getMerchantTopUpPaymentLinkTest;
exports.executePayoutTest = executePayoutTest;
// ** Dragonpay Test **

// ** Dragonpay PRODUCTION **
app.post("/payment/checkPayment", checkPayment);
app.get("/payment/result", result);

exports.getMerchantPaymentLink = getMerchantPaymentLink;
exports.getAvailablePaymentProcessors = getAvailablePaymentProcessors;
// ** Dragonpay PRODUCTION **

exports.api = functions.region("asia-northeast1").https.onRequest(app);

// Services
exports.scheduledFirestoreExport = scheduledFirestoreExport;
exports.generateThumbnail = generateThumbnail;

// Authentication
exports.signInWithPhoneAndPassword = signInWithPhoneAndPassword;
exports.sendPasswordResetLinkToStoreUser = sendPasswordResetLinkToStoreUser;

// Admin Services
exports.setUserAsMerchant = setUserAsMerchant;
exports.assignStoreToMerchant = assignStoreToMerchant;
exports.getUserFromEmail = getUserFromEmail;
exports.getUserFromUserId = getUserFromUserId;
exports.createStoreEmployeeAccount = createStoreEmployeeAccount;
exports.setMarketeerAdminToken = setMarketeerAdminToken;
exports.editUserStoreRoles = editUserStoreRoles;

// Store Services
exports.changeOrderStatus = changeOrderStatus;
exports.addStoreItem = addStoreItem;

// User Services
exports.getAddressFromCoordinates = getAddressFromCoordinates;
exports.placeOrder = placeOrder;
exports.cancelOrder = cancelOrder;
exports.addReview = addReview;
exports.sendMessageNotification = sendMessageNotification;

// Testing
exports.placeOrderTest = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const userRegistrationEmail = context.auth.token.email;
    const { orderInfo } = data;

    const {
      deliveryCoordinates,
      deliveryCoordinatesGeohash,
      deliveryAddress,
      userCoordinates,
      userName,
      storeUserEmail,
      storeSelectedDeliveryMethod,
      storeSelectedPaymentMethod,
      storeAssignedMerchantId,
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
        !storeSelectedPaymentMethod ||
        !storeAssignedMerchantId
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
              const storeMerchantId = storeAssignedMerchantId[storeId];
              const storeMerchantRef = db
                .collection("merchants")
                .doc(storeMerchantId);
              const storeItemDocs = [];
              const storeItemRefs = [];

              if (!storeMerchantId) {
                throw new Error(
                  `Sorry, a store you ordered from is currently not available. Please try again later or place another order from another store.`
                );
              }

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
              let merchantDetails = {};

              return await transaction
                .getAll(userRef, storeRef, storeMerchantRef, ...storeItemRefs)
                .then(async (documents) => {
                  const userDoc = documents[0];
                  const storeDoc = documents[1];
                  const storeMerchantDoc = documents[2];
                  const storeItemsDocs = documents.slice(3, documents.length);

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

                  if (storeDetails.creditThresholdReached) {
                    throw new Error(
                      `Sorry, ${storeDetails.storeName} is currently not available. Please try again later.`
                    );
                  }

                  if (storeMerchantDoc.exists) {
                    merchantDetails = storeMerchantDoc.data();
                  } else {
                    throw new Error(
                      `Sorry, ${storeDetails.storeName} is currently not available. Please try again later.`
                    );
                  }

                  if (!merchantDetails.stores.includes(storeId)) {
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
                  const userEmail =
                    paymentMethod !== "COD"
                      ? storeUserEmail[storeId]
                      : userRegistrationEmail;

                  if (paymentMethod !== "COD" && !userEmail) {
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

                  let orderDetails = {
                    reviewed: false,
                    userCoordinates,
                    deliveryCoordinates,
                    deliveryAddress,
                    userName,
                    userPhoneNumber,
                    userId,
                    userEmail,
                    createdAt: timeStamp,
                    updatedAt: timeStamp,
                    orderStatus,
                    quantity,
                    subTotal,
                    transactionFee:
                      subTotal *
                      merchantDetails.creditData.transactionFeePercentage *
                      0.01,
                    freeDelivery,
                    deliveryMethod,
                    deliveryPrice,
                    paymentMethod: "COD",
                    storeId,
                    merchantId: storeDetails.merchantId,
                    storeName: storeDetails.storeName,
                    storeOrderNumber: newStoreOrderNumber,
                    merchantOrderNumber: newStoreOrderNumber,
                    userOrderNumber: newUserOrderNumber,
                  };

                  if (
                    paymentMethod !== "COD" &&
                    paymentMethod !== "Online Payment"
                  ) {
                    orderDetails.processId = paymentMethod;
                    orderDetails.paymentMethod = "Online Banking";
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
            .then(async ({ orderDetails, storeDetails, orderId, s, m }) => {
              if (orderDetails && storeDetails && orderId) {
                // Send Order Notification to store
                const fcmTokens = storeDetails.fcmTokens && [
                  ...storeDetails.fcmTokens,
                ];

                functions.logger.log(fcmTokens, storeDetails.fcmTokens);

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
              }

              return { s, m };
            });
        })
      );
    } catch (e) {
      return { s: 400, m: `${e}` };
    }
  });
