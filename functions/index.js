/* eslint-disable promise/no-nesting */
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

exports.changeOrderStatus = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, merchantId } = data;
    const userId = context.auth.uid;

    if (orderId === undefined) {
      return { s: 400, m: "Bad argument: Order ID not found" };
    }

    const statusArray = [
      "pending",
      "unpaid",
      "paid",
      "shipped",
      "completed",
      "cancelled",
    ];

    const orderRef = firestore().collection("orders").doc(orderId);
    const merchantRef = firestore().collection("merchants").doc(merchantId);

    try {
      return db.runTransaction(async (transaction) => {
        let orderData, merchantData;

        await transaction.getAll(orderRef, merchantRef).then((documents) => {
          const orderDoc = documents[0];
          const merchantDoc = documents[1];

          orderData = orderDoc.data();
          merchantData = merchantDoc.data();

          if (!merchantDoc.data().admins[userId] === true) {
            throw new Error("User is not merchant admin");
          }

          if (orderDoc.data().merchantId !== merchantDoc.id) {
            throw new Error("Order does not correspond with merchant id");
          }

          return;
        });

        const { orderStatus, paymentMethod, totalAmount } = orderData;

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

          newOrderStatus[`${currentOrderStatus}`] = {
            status: false,
          };

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
              Math.round(totalAmount * transactionFeePercentage) / 100;
            const newCredits = credits - transactionFee;
            const newCreditThresholdReached =
              newCredits < creditThreshold ? true : false;

            transaction.update(merchantRef, {
              ["creditData.credits"]: newCredits,
              ["creditData.creditThresholdReached"]: newCreditThresholdReached,
            });

            let fcmTokens = [];

            fcmTokens = merchantData.fcmTokens && merchantData.fcmTokens;

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
                  token,
                });
              });
            }

            orderNotifications.length > 0 && fcmTokens.length > 0
              ? await admin.messaging().sendAll(orderNotifications)
              : null;
          }

          return { s: 200, m: "Successfully changed order status" };
        } else {
          throw new Error("No order status");
        }
      });
    } catch (e) {
      return { s: 400, m: `Error, something went wrong: ${e}` };
    }
  });

exports.cancelOrder = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, merchantId, cancelReason } = data;
    const userId = context.auth.uid;

    if (orderId === undefined || cancelReason === undefined) {
      return { s: 400, m: "Bad argument: Incomplete Information" };
    }

    try {
      let orderData, merchantData;

      return db.runTransaction(async (transaction) => {
        const orderRef = firestore().collection("orders").doc(orderId);
        const merchantRef = firestore().collection("merchants").doc(merchantId);

        await transaction.getAll(orderRef, merchantRef).then((documents) => {
          const orderDoc = documents[0];
          const merchantDoc = documents[1];

          orderData = orderDoc.data();
          merchantData = merchantDoc.data();

          if (!merchantDoc.data().admins[userId] === true) {
            throw new Error("User is not merchant admin");
          }

          if (orderDoc.data().merchantId !== merchantDoc.id) {
            throw new Error("Order does not correspond with merchant id");
          }

          return;
        });

        const { orderStatus } = orderData;

        let newOrderStatus = {};
        let currentStatus;

        Object.keys(orderStatus).map((item, index) => {
          if (orderStatus[`${item}`].status) {
            currentStatus = item;
          }
        });

        if (currentStatus !== "pending") {
          return {
            s: 400,
            m: "Error: Order is not pending, and thus cannot be cancelled",
          };
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
      storeSelectedShipping,
      storeSelectedPaymentMethod,
    } = JSON.parse(orderInfo);

    const userId = context.auth.uid;
    const userPhoneNumber = context.auth.token.phone_number;

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

    const userRef = db.collection("users").doc(userId);
    const userCartRef = db.collection("user_carts").doc(userId);

    const storeCartItems = (await userCartRef.get()).data();
    const cartStores = storeCartItems ? [...Object.keys(storeCartItems)] : null;

    const merchantIdRefs = {};
    const merchantItemsIdRefs = {};

    cartStores.map((merchantId) => {
      merchantIdRefs[merchantId] = db.collection("merchants").doc(merchantId);
      merchantItemsIdRefs[merchantId] = db
        .collection("merchant_items")
        .doc(merchantId);
    });

    const merchantRefs = Object.values(merchantIdRefs);
    const merchantItemsRefs = Object.values(merchantItemsIdRefs);

    if (
      deliveryCoordinates === undefined ||
      deliveryAddress === undefined ||
      userCoordinates === undefined ||
      userName === undefined ||
      storeCartItems === undefined ||
      storeSelectedShipping === undefined ||
      storeSelectedPaymentMethod === undefined
    ) {
      return { s: 400, m: "Bad argument: Incomplete request" };
    }

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

          await cartStores.map(async (merchantId, index) => {
            const currentStoreItems = [...merchantItemsData[merchantId].items];

            const storeDetails = merchantData[merchantId];

            const currentMerchantOrderNumber = storeDetails.orderNumber
              ? storeDetails.orderNumber
              : 0;

            let quantity = 0;
            let totalAmount = 0;

            const orderItems = storeCartItems[merchantId];
            const shipping = storeSelectedShipping[merchantId];
            const paymentMethod = storeSelectedPaymentMethod[merchantId];

            orderItems.map((orderItem) => {
              quantity = orderItem.quantity + quantity;
              totalAmount = orderItem.price * orderItem.quantity + totalAmount;

              const currentStoreItemIndex = currentStoreItems.findIndex(
                (storeItem) => storeItem.itemId === orderItem.itemId
              );

              const currentStoreItem = currentStoreItems[currentStoreItemIndex];

              currentStoreItem.stock -= orderItem.quantity;

              currentStoreItem.sales += orderItem.quantity;

              if (currentStoreItem.stock < 0) {
                error = `Not enough stocks for item ${orderItem.name} from ${merchantId}`;
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
              createdAt: firestore.Timestamp.now().toMillis(),
              updatedAt: firestore.Timestamp.now().toMillis(),
              orderStatus,
              quantity,
              totalAmount,
              shipping,
              merchantId,
              paymentMethod,
              merchantOrderNumber: currentMerchantOrderNumber + 1,
              userOrderNumber: currentUserOrderNumber + 1 + index,
            };

            const ordersRef = firestore().collection("orders");
            const orderItemsRef = firestore().collection("order_items");
            const id = ordersRef.doc().id;

            // Place order
            transaction.set(orderItemsRef.doc(id), {
              items: orderItems,
              merchantId,
              userId,
            });
            transaction.set(ordersRef.doc(id), {
              ...orderDetails,
              messages: [],
            });

            // Update order number
            transaction.update(merchantIdRefs[merchantId], {
              orderNumber: currentMerchantOrderNumber + 1,
            });
            transaction.update(userRef, {
              orderNumber: currentUserOrderNumber + 1 + index,
            });

            // Update store item quantities
            transaction.update(merchantItemsIdRefs[merchantId], {
              items: [...currentStoreItems],
            });

            ordersStores[merchantId] = orderDetails;
          });

          transaction.set(userCartRef, {});
        },
        { maxAttempts: 5 }
      )
      .then(async () => {
        // Send Order Notification to each Merchant
        return Object.entries(ordersStores).map(
          async ([merchantId, orderDetails]) => {
            let fcmTokens = [];

            fcmTokens = merchantData[merchantId].fcmTokens && [
              ...merchantData[merchantId].fcmTokens,
            ];

            const { merchantOrderNumber, totalAmount } = orderDetails;
            const orderNotifications = [];

            if (fcmTokens) {
              fcmTokens.map((token) => {
                orderNotifications.push({
                  notification: {
                    title: "You've got a new order!",
                    body: `Order # ${merchantOrderNumber}; Total Amount: ${totalAmount}`,
                  },
                  token,
                });
              });
            }

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
              } else if (orderDoc.data().merchantId !== merchantId) {
                return Promise.reject(new Error("Merchant Ids do not match"));
              } else {
                transaction.update(orderDoc.ref, { reviewed: true });
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
          })
          .catch((err) => {
            console.log(err);
          });
      });
    } catch (e) {
      return { s: 400, m: e };
    }
  });

exports.setMerchantAdminToken = functions
  .region("asia-northeast1")
  .firestore.document("merchant_admins/{merchantId}")
  .onWrite(async (change, context) => {
    const newData = change.after.exists ? change.after.data() : null;
    const previousData = change.before.data();
    const newDataLength = newData ? Object.keys(newData).length : null;
    const previousDataLength = Object.keys(previousData).length;

    const merchantId = context.params.merchantId;

    if (newData && newDataLength >= previousDataLength) {
      Object.entries(newData).map(async ([userId, value]) => {
        if (value === false) {
          return await admin
            .auth()
            .setCustomUserClaims(userId, { merchantId })
            .then(async () => {
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
    } else if (previousData && newDataLength < previousDataLength) {
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
    }
  });
