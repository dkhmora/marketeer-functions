const functions = require("firebase-functions");
const { firestore } = require("firebase-admin");
const { db, admin } = require("./util/admin");
const { getOrderPaymentLink } = require("./payments");
const {
  isPointInBoundingBox,
  getBoundingBox,
  getGeohashRange,
  getBoundsOfDistance,
} = require("./helpers/location");
const {
  placeMrSpeedyOrder,
  getOrderPriceEstimate,
} = require("./util/mrspeedy");

exports.changeOrderStatus = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId, storeId, merchantId, mrspeedyBookingData } = data;
    const userId = context.auth.uid;
    const storeIds = context.auth.token.storeIds;
    const storePhoneNumber = context.auth.token.phone_number;

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
        let mrspeedyMessage = "";

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

            const {
              storeId,
              orderStatus,
              paymentMethod,
              deliveryMethod,
              subTotal,
              transactionFee,
              deliveryCoordinates,
              deliveryAddress,
              userPhoneNumber,
              userName,
            } = orderData;
            const { storeLocation, storeName, address } = storeData;
            const { stores, creditData } = merchantData;
            const { credits, creditThreshold } = creditData;
            const chargeToTopUp =
              paymentMethod === "COD"; /* && deliveryMethod === 'Mr. Speedy' */

            const userStoreRoles = storeIds[storeId];

            if (!Object.keys(stores).includes(storeId)) {
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

              if (deliveryMethod === "Mr. Speedy" && nextStatus === "shipped") {
                if (
                  !mrspeedyBookingData ||
                  !mrspeedyBookingData.vehicleType ||
                  mrspeedyBookingData.motobox === undefined ||
                  !mrspeedyBookingData.orderWeight ||
                  !mrspeedyBookingData.storePhoneNumber
                ) {
                  throw new Error(
                    "Error: Incomplete details provided for Mr. Speedy Booking. Please try again."
                  );
                }

                const {
                  vehicleType,
                  motobox,
                  orderWeight,
                  storePhoneNumber,
                } = mrspeedyBookingData;
                const matter = `${userName}'s order from ${storeName} via Marketeer`;
                const { latitude, longitude } = deliveryCoordinates;
                const esimationPoints = [
                  {
                    address,
                    ...storeLocation,
                  },
                  {
                    address: deliveryAddress,
                    latitude,
                    longitude,
                    client_order_id: orderId,
                    taking_amount: paymentMethod !== "COD" ? "0.00" : "1.00",
                    is_order_payment_here: paymentMethod === "COD",
                    is_cod_cash_voucher_required: paymentMethod === "COD",
                  },
                ];

                const totalDeliveryFee = await getOrderPriceEstimate({
                  points: esimationPoints,
                  insurance_amount: subTotal.toFixed(2),
                  motorbike: vehicleType === 8,
                  orderWeight,
                  paymentMethod,
                });

                functions.logger.log(
                  subTotal,
                  totalDeliveryFee,
                  Number(totalDeliveryFee)
                );
                const takingAmount = (
                  subTotal + Number(totalDeliveryFee)
                ).toFixed(2);
                functions.logger.log(takingAmount);

                const finalPoints = [
                  {
                    address,
                    ...storeLocation,
                    contact_person: {
                      phone: storePhoneNumber,
                      name: storeName,
                    },
                  },
                  {
                    address: deliveryAddress,
                    taking_amount:
                      paymentMethod !== "COD" ? "0.00" : takingAmount,
                    latitude,
                    longitude,
                    contact_person: { phone: userPhoneNumber, name: userName },
                    client_order_id: orderId,
                    is_cod_cash_voucher_required: paymentMethod === "COD",
                    is_order_payment_here: paymentMethod === "COD",
                  },
                ];

                // eslint-disable-next-line promise/no-nesting
                await placeMrSpeedyOrder({
                  matter,
                  points: finalPoints,
                  insurance_amount: subTotal.toFixed(2),
                  is_motobox_required: vehicleType === 8 ? motobox : false,
                  payment_method: paymentMethod !== "COD" ? "non-cash" : "cash",
                  total_weight_kg: orderWeight,
                  vehicle_type_id: vehicleType,
                }).then((mrspeedyBookingData) => {
                  functions.logger.log(mrspeedyBookingData);
                  if (!mrspeedyBookingData.is_successful) {
                    functions.logger.log(
                      mrspeedyBookingData.parameter_errors.points[0],
                      mrspeedyBookingData.parameter_errors.points[1]
                    );

                    throw new Error(
                      "Error: Something went wrong with booking Mr. Speedy."
                    );
                  }

                  mrspeedyMessage =
                    "Successfully placed Mr. Speedy Booking! Please wait for the courier to arrive.";
                  orderUpdateData.mrspeedyBookingData = mrspeedyBookingData;
                  orderUpdateData.deliveryPrice = Number(totalDeliveryFee);

                  return null;
                });
              }

              if (
                paymentMethod === "Online Banking" &&
                currentOrderStatus === "unpaid"
              ) {
                throw new Error(
                  "Sorry, you cannot manually change an Online Banking Order's status when it is unpaid."
                );
              }

              if (
                paymentMethod === "Online Banking" &&
                currentOrderStatus === "pending"
              ) {
                orderUpdateData.paymentLink = await getOrderPaymentLink({
                  orderData,
                  orderId,
                });
              }

              transaction.update(orderRef, {
                ...orderUpdateData,
              });

              if (nextStatus === "shipped" && chargeToTopUp) {
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

                  stores.map((store) => {
                    const merchantStoreRef = db.collection("stores").doc(store);

                    transaction.update(merchantStoreRef, {
                      creditThresholdReached: true,
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
                type = "order_update";
              }

              if (paymentMethod === "Online Banking") {
                notificationTitle = "Your order has been confirmed!";
                notificationBody = `Order #${userOrderNumber} is now waiting for your payment. Pay for your order now by visiting the orders page or by pressing here.`;
                type = "order_update";
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
              type = "order_update";
            }

            if (nextStatus === "shipped") {
              notificationTitle = "Your order has been shipped!";
              notificationBody = `Order # ${userOrderNumber} has now been shipped! Please wait for your order to arrive and get ready to pay if you ordered via COD. Thank you for shopping using Marketeer!`;
              type = "order_update";
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

            return {
              s: 200,
              m: `Order status successfully updated! ${mrspeedyMessage}`,
            };
          });
      });
    } catch (e) {
      return { s: 400, m: `Error, something went wrong: ${e}` };
    }
  });

exports.addStoreItem = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { item, storeId } = data;
    const storeIds = context.auth.token.storeIds;

    if (!item || !storeId) {
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

          return null;
        });

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

exports.setStoreDeliveryArea = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { distance, midPoint, storeId } = data;
    const storeIds = context.auth.token.storeIds;

    if (!distance || !midPoint || !storeId || distance < 1) {
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
      !userStoreRoles.includes("manager")
    ) {
      return {
        s: 400,
        m:
          "Error: User does not have required permissions. Please contact Marketeer support to set a role for your account if required.",
      };
    }

    try {
      const storeRef = db.collection("stores").doc(storeId);

      return db.runTransaction(async (transaction) => {
        const storeData = (await transaction.get(storeRef)).data();
        const { storeLocation } = storeData;
        const bounds = await getBoundsOfDistance(midPoint, distance);
        const boundingBox = await getBoundingBox(bounds[0], bounds[1]);
        const { lower, upper } = await getGeohashRange(bounds, distance);

        if (isPointInBoundingBox(storeLocation, boundingBox)) {
          await transaction.update(storeRef, {
            deliveryCoordinates: {
              lowerRange: lower,
              upperRange: upper,
              boundingBox,
            },
            updatedAt: firestore.Timestamp.now().toMillis(),
          });

          return { s: 200, m: "Successfully set delivery area box!" };
        }

        return {
          s: 400,
          m:
            "Error: Store location is not inside delivery area box. Please try again.",
        };
      });
    } catch (e) {
      return { s: 400, m: e };
    }
  });
