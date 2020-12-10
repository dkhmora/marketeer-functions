const functions = require("firebase-functions");
const firebase = require("firebase");
const { firestore, auth } = require("firebase-admin");
const { db, admin } = require("./util/admin");
const { HERE_API_KEY, functionsRegionHttps } = require("./util/config");
const { payment_methods } = require("./util/dragonpay");
const { getOrderPriceEstimateRange } = require("./util/mrspeedy");
const { editTransaction } = require("./payments");
const { processStoreItems } = require("./helpers/items");
const { getCurrentTimestamp } = require("./helpers/time");
const { sendNotifications } = require("./helpers/messaging");
const { getAppliedVoucherDetails } = require("./helpers/vouchers");
const { default: fetch } = require("node-fetch");

exports.claimVoucher = functionsRegionHttps.onCall(async (data, context) => {
  const { voucherId } = data;
  const {
    auth: {
      uid,
      token: { phone_number },
    },
  } = context;

  if (!phone_number || !uid) {
    return { s: 400, m: "Error: User is not authorized" };
  }

  try {
    return await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(uid);
      const clientConfigRef = db.collection("application").doc("client_config");
      return transaction
        .getAll(userRef, clientConfigRef)
        .then(async (documents) => {
          const userData = documents[0].data();
          const clientConfigData = documents[1].data();
          const { claimedVouchers } = userData;
          const { vouchers } = clientConfigData;

          if (claimedVouchers?.[voucherId] !== undefined) {
            throw new Error(
              `Error: The voucher is already claimed by the user.`
            );
          }

          if (vouchers?.[voucherId] === undefined) {
            throw new Error(`Error: The voucher does not exist.`);
          }

          const { claims, maxClaims, maxUses, title } = vouchers?.[
            voucherId
          ] || {
            maxUses: 0,
            claims: 0,
            maxClaims: 0,
          };

          if (maxClaims <= claims) {
            throw new Error(`Error: The voucher is out of stock`);
          }

          transaction.set(
            userRef,
            {
              claimedVouchers: {
                [voucherId]: maxUses,
              },
              updatedAt: await getCurrentTimestamp(),
            },
            { merge: true }
          );

          transaction.set(
            clientConfigRef,
            {
              vouchers: {
                [voucherId]: {
                  claims: firestore.FieldValue.increment(1),
                  maxClaimsReached: maxClaims <= claims + 1,
                },
              },
            },
            { merge: true }
          );

          return {
            s: 200,
            m: `Voucher ${title} successfully claimed! Enjoy shopping!`,
          };
        });
    });
  } catch (err) {
    return { s: 400, m: err.message };
  }
});

exports.getAddressFromCoordinates = functionsRegionHttps.onCall(
  async (data, context) => {
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
            functions.logger.error("getAddressFromCoordinates: ", e);
            resolve();
          });
      });
    } catch (e) {
      functions.logger.error(e);
      return { s: 400, m: "Error, something went wrong." };
    }

    return { s: 200, locationDetails };
  }
);

exports.placeOrder = functionsRegionHttps.onCall(async (data, context) => {
  const userRegistrationEmail = context.auth.token.email;
  const { orderInfo } = data;

  const {
    deliveryCoordinates,
    deliveryCoordinatesGeohash,
    deliveryAddress,
    userCoordinates,
    userName,
    cartStoreSnapshots,
  } = JSON.parse(orderInfo);

  const userId = context.auth.uid;
  const userPhoneNumber = context.auth.token.phone_number;

  if (!userId || !userPhoneNumber) {
    return { s: 400, m: "Error: User is not authorized" };
  }

  try {
    const userRef = db.collection("users").doc(userId);
    const userCartRef = db.collection("user_carts").doc(userId);

    const storeCartItemsMap = (await userCartRef.get()).data();
    const cartStores = storeCartItemsMap
      ? [...Object.keys(storeCartItemsMap)]
      : null;

    if (
      !deliveryCoordinates ||
      !deliveryAddress ||
      !userCoordinates ||
      !userName ||
      !storeCartItemsMap ||
      !cartStoreSnapshots
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
            const storeOptions = cartStoreSnapshots[storeId];
            const {
              merchantId,
              email,
              deliveryMethod,
              paymentMethod,
              vouchersApplied,
            } = storeOptions;

            functions.logger.log(storeOptions);

            if (!merchantId) {
              throw new Error(
                `Sorry, a store you ordered from is currently not available. Please try again later or place another order from another store.`
              );
            }

            const storeMerchantRef = db.collection("merchants").doc(merchantId);
            const storeItemDocs = [];
            const storeItemRefs = [];

            await storeCartItemsMap[storeId].map((item) => {
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

            return await transaction
              .getAll(userRef, storeRef, storeMerchantRef, ...storeItemRefs)
              .then(async (documents) => {
                const userDoc = documents[0];
                const storeDoc = documents[1];
                const storeMerchantDoc = documents[2];
                const storeItemsDocs = documents.slice(3, documents.length);

                const storeItemsSnapshot = [].concat(
                  ...storeItemsDocs.map(
                    (storeItemDoc) => storeItemDoc.data().items
                  )
                );

                let userData = {};
                let storeDetails = {};
                let merchantDetails = {};

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

                const {
                  storeName,
                  devOnly,
                  visibleToPublic,
                  vacationMode,
                  storeLocation,
                  merchantId,
                  creditThresholdReached,
                  availablePaymentMethods,
                  availableDeliveryMethods,
                } = storeDetails;

                const { claimedVouchers } = userData;

                if (!devOnly && (!visibleToPublic || vacationMode)) {
                  throw new Error(
                    `Sorry, ${storeName} is currently on vacation. Please try again later.`
                  );
                }

                if (storeMerchantDoc.exists) {
                  merchantDetails = storeMerchantDoc.data();
                } else {
                  throw new Error(
                    `Sorry, ${storeName} is currently not available. Please try again later.`
                  );
                }

                const storeDeliveryMethod =
                  availableDeliveryMethods[deliveryMethod];

                if (!storeDeliveryMethod || !storeDeliveryMethod.activated) {
                  throw new Error(
                    `Sorry, ${storeName} currently does not support the delivery method ${deliveryMethod}. Please try ordering again.`
                  );
                }

                if (
                  (paymentMethod === "COD" &&
                    (!availablePaymentMethods[paymentMethod] ||
                      !availablePaymentMethods[paymentMethod].activated)) ||
                  (paymentMethod !== "COD" &&
                    (!availablePaymentMethods["Online Banking"] ||
                      !availablePaymentMethods["Online Banking"].activated ||
                      !payment_methods[paymentMethod]))
                ) {
                  throw new Error(
                    `Sorry, ${storeName} currently does not support the payment method ${paymentMethod}. Please try ordering again.`
                  );
                }

                const {
                  stores,
                  creditData,
                  recurringBilling,
                } = merchantDetails;
                const { creditThreshold, credits } = creditData;

                if (!Object.keys(stores).includes(storeId)) {
                  throw new Error(
                    `Sorry, ${storeName} is currently not available. Please try again later.`
                  );
                }

                if (
                  (creditThresholdReached || credits < creditThreshold) &&
                  !recurringBilling
                ) {
                  throw new Error(
                    `Sorry, ${storeName} is currently not available. Please try again later.`
                  );
                }

                const currentUserOrderNumber = userData.orderNumber
                  ? userData.orderNumber
                  : 0;
                const currentStoreOrderNumber = storeDetails.orderNumber
                  ? storeDetails.orderNumber
                  : 0;

                const userEmail =
                  paymentMethod !== "COD" ? email : userRegistrationEmail;

                if (paymentMethod !== "COD" && !userEmail) {
                  return { s: 400, m: "Bad argument: Incomplete request" };
                }

                const storeCartItems = storeCartItemsMap[storeId];
                const {
                  quantity,
                  subTotal,
                  newStoreItems,
                } = await processStoreItems(
                  storeCartItems,
                  storeItemsSnapshot,
                  storeName
                );

                const timeStamp = firestore.Timestamp.now().toMillis();
                const newStoreOrderNumber = currentStoreOrderNumber + 1;
                const newUserOrderNumber = currentUserOrderNumber + 1;
                const storeDeliveryDiscountApplicable =
                  storeDetails.deliveryDiscount &&
                  storeDetails.deliveryDiscount.activated &&
                  subTotal >= storeDetails.deliveryDiscount.minimumOrderAmount;
                const deliveryPrice =
                  deliveryMethod === "Own Delivery"
                    ? storeDeliveryMethod.deliveryPrice
                    : null;
                const deliveryDiscount = storeDeliveryDiscountApplicable
                  ? storeDetails.deliveryDiscount.discountAmount
                  : null;
                const marketeerVoucherDetails = await getAppliedVoucherDetails(
                  vouchersApplied,
                  subTotal,
                  claimedVouchers
                );

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
                  deliveryMethod,
                  deliveryPrice,
                  deliveryDiscount,
                  marketeerVoucherDetails,
                  paymentMethod: "COD",
                  storeId,
                  merchantId,
                  storeName,
                  storeLocation,
                  storeOrderNumber: newStoreOrderNumber,
                  merchantOrderNumber: newStoreOrderNumber,
                  userOrderNumber: newUserOrderNumber,
                };

                if (paymentMethod !== "COD") {
                  orderDetails.processId = paymentMethod;
                  orderDetails.paymentMethod = "Online Banking";

                  if (deliveryMethod === "Mr. Speedy") {
                    const points = [
                      {
                        address: storeDetails.address,
                        ...storeLocation,
                      },
                      {
                        address: deliveryAddress,
                        latitude: deliveryCoordinates.latitude,
                        longitude: deliveryCoordinates.longitude,
                      },
                    ];

                    orderDetails.mrspeedyBookingData = {
                      estimatedOrderPrices: await getOrderPriceEstimateRange({
                        points,
                        subTotal,
                      }),
                    };
                  }
                }

                const ordersRef = firestore().collection("orders");
                const orderItemsRef = firestore().collection("order_items");
                const orderId = ordersRef.doc().id;

                // Place order
                transaction.set(orderItemsRef.doc(orderId), {
                  items: storeCartItems,
                  storeId,
                  userId,
                  updatedAt: timeStamp,
                  createdAt: timeStamp,
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

                const newUserData = {
                  orderNumber: newUserOrderNumber,
                  addresses: {
                    Home: {
                      coordinates: { ...deliveryCoordinates },
                      geohash: deliveryCoordinatesGeohash,
                      address: deliveryAddress,
                    },
                  },
                };

                if (vouchersApplied?.delivery !== undefined) {
                  newUserData.claimedVouchers = {
                    [vouchersApplied.delivery]: firestore.FieldValue.increment(
                      -1
                    ),
                  };
                }

                transaction.set(userRef, newUserData, { merge: true });

                // Update store item document quantities
                storeItemDocs.map(async (storeItemDoc) => {
                  const docItems = await newStoreItems.filter(
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

              if (orderNotifications.length > 0) {
                await admin.messaging().sendAll(orderNotifications);
              }

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
    functions.logger.error(e);
    return { s: 400, m: `${e}` };
  }
});

exports.cancelOrder = functionsRegionHttps.onCall(async (data, context) => {
  const { orderId, cancelReason } = data;
  const userId = context.auth.uid;
  const storeIds = context.auth.token.storeIds;

  if (!userId && !storeIds) {
    return { s: 400, m: "Error: User is not authorized" };
  }

  if (orderId === undefined || cancelReason === undefined) {
    return { s: 400, m: "Bad argument: Incomplete Information" };
  }

  try {
    return await db
      .runTransaction(async (transaction) => {
        const orderRef = db.collection("orders").doc(orderId);

        return await transaction.get(orderRef).then(async (document) => {
          const orderData = document.data();
          const { storeId } = orderData;

          if (storeIds) {
            const userStoreRoles = storeIds[storeId];

            if (!userStoreRoles) {
              throw new Error("Order does not correspond with store id");
            }

            if (
              storeIds &&
              !userStoreRoles.includes("admin") &&
              !userStoreRoles.includes("cashier") &&
              !userStoreRoles.includes("manager")
            ) {
              throw new Error(
                "User does not have required permissions. Please contact Marketeer support to set a role for your account if required."
              );
            }
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
            paymentLink,
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

          const timestamp = firestore.Timestamp.now().toMillis();

          newOrderStatus.cancelled = {
            status: true,
            reason: cancelReason,
            byShopper: storeIds ? false : true,
            updatedAt: timestamp,
          };

          if (paymentLink) {
            await editTransaction({ operation: "VOID", txnId: orderId });
          }

          transaction.update(orderRef, {
            orderStatus: newOrderStatus,
            paymentLink: null,
            updatedAt: timestamp,
          });

          return { orderData };
        });
      })
      .then(async ({ orderData }) => {
        const { userId, userOrderNumber, storeId } = orderData;
        const { storeName } = (
          await db.collection("stores").doc(storeId).get()
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

        if (orderNotifications.length > 0) {
          admin.messaging().sendAll(orderNotifications);
        }

        return { s: 200, m: "Order successfully cancelled!" };
      });
  } catch (e) {
    functions.logger.error(e);
    return { s: 400, m: e.message };
  }
});

exports.addReview = functionsRegionHttps.onCall(async (data, context) => {
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

      return await transaction.getAll(orderRef, storeRef).then((documents) => {
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
    functions.logger.error(e);
    return { s: 400, m: e };
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
          ? (await db.collection("users").doc(userId).get()).data()
          : (await db.collection("stores").doc(storeId).get()).data();
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

exports.createAccountDocument = functionsRegionHttps.onCall(
  async (data, context) => {
    const { birthdate, gender } = data;
    const { uid } = context.auth.token;

    if (!uid) {
      return { s: 500, m: "Error: User is not authorized" };
    }

    const timestamp = firebase.firestore.Timestamp.now().toMillis();
    const user = auth().getUser(uid);
    const { displayName, email, phoneNumber } = user;

    await firestore()
      .collection("users")
      .doc(uid)
      .set({
        name: displayName,
        email,
        phoneNumber: phoneNumber,
        birthdate,
        gender,
        updatedAt: timestamp,
        createdAt: timestamp,
      })
      .then(() => {
        return { s: 200, m: "User documents successfully created!" };
      });
  }
);
