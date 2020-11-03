const {
  getOrderPriceEstimate,
  getMrSpeedyCourierInfo,
  getMrSpeedyCallbackSecretKey,
  cancelMrSpeedyOrder,
  getOrderPriceEstimateRange,
} = require("./util/mrspeedy");
const functions = require("firebase-functions");
const { db } = require("./util/admin");
const { createHmac } = require("crypto");
const { firestore } = require("firebase-admin");
const {
  getCurrentWeeklyPeriodFromTimestamp,
  getCurrentTimestamp,
} = require("./helpers/time");
const moment = require("moment");

exports.getUserMrSpeedyDeliveryPriceEstimate = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { deliveryLocation, deliveryAddress } = data;
    const { uid, token } = context.auth;
    const { phone_number } = token;

    if (!phone_number) {
      return { s: 500, m: "Error: User is not authorized for this action" };
    }

    const cartStores = (
      await db.collection("user_carts").doc(uid).get()
    ).data();
    const cartStoreIds = Object.keys(cartStores);

    let storeDeliveryFees = {};

    try {
      return await Promise.all(
        cartStoreIds.map(async (storeId) => {
          const { storeLocation, address, deliveryMethods } = (
            await db.collection("stores").doc(storeId).get()
          ).data();
          const storeCartItems = cartStores[storeId];

          let subTotal = 0;

          await storeCartItems.map((item) => {
            subTotal = item.price * item.quantity + subTotal;
          });

          const points = [
            {
              address,
              ...storeLocation,
            },
            {
              address: deliveryAddress,
              ...deliveryLocation,
            },
          ];

          if (deliveryMethods.includes("Mr. Speedy")) {
            const estimate = await getOrderPriceEstimateRange({
              points,
              subTotal,
            });

            storeDeliveryFees[storeId] = estimate;
          }

          return null;
        })
      ).then(() => {
        return { s: 200, m: "Success", d: storeDeliveryFees };
      });
    } catch (e) {
      functions.logger.error(e);
      return { s: 500, m: "Error: Something went wrong" };
    }
  });

exports.getMerchantMrSpeedyDeliveryPriceEstimate = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const {
      subTotal,
      deliveryLocation,
      deliveryAddress,
      storeLocation,
      vehicleType,
      orderWeight,
      storeAddress,
      paymentMethod,
    } = data;

    if (!context.auth.token.storeIds) {
      return { s: 500, m: "Error: User is not authorized for this action" };
    }

    try {
      const points = [
        {
          address: storeAddress,
          ...storeLocation,
        },
        {
          address: deliveryAddress,
          ...deliveryLocation,
          taking_amount: paymentMethod !== "COD" ? "0.00" : subTotal.toFixed(2),
          is_order_payment_here: paymentMethod === "COD",
          is_cod_cash_voucher_required: paymentMethod === "COD",
        },
      ];

      const orderEstimate = await getOrderPriceEstimate({
        points,
        insurance_amount: subTotal.toFixed(2),
        motorbike: vehicleType === 8,
        orderWeight,
        paymentMethod,
      });

      return { s: 200, m: "Success", d: orderEstimate };
    } catch (e) {
      functions.logger.error(e);
      return { s: 500, m: "Error: Something went wrong" };
    }
  });

exports.getMrSpeedyCourierInfo = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { mrspeedyOrderId } = data;

    if (!context.auth.token.storeIds) {
      return { s: 500, m: "Error: User is not authorized for this action" };
    }

    try {
      const mrspeedyOrderData = await getMrSpeedyCourierInfo(mrspeedyOrderId);
      const { is_successful, courier } = mrspeedyOrderData;

      functions.logger.log(mrspeedyOrderData);

      if (is_successful) {
        return { s: 200, d: courier };
      } else {
        throw new Error("Failed to get courier data");
      }
    } catch (e) {
      functions.logger.error(e);
      return { s: 500, m: "Error: Something went wrong" };
    }
  });

exports.cancelMrSpeedyOrder = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { orderId } = data;

    if (!context.auth.token.storeIds) {
      return { s: 500, m: "Error: User is not authorized for this action" };
    }

    try {
      const orderDoc = db.collection("orders").doc(orderId);

      return await db.runTransaction(async (transaction) => {
        return await transaction.get(orderDoc).then(async (document) => {
          const { storeId, mrspeedyBookingData } = document.data();

          if (
            !context.auth.token.storeIds[storeId] ||
            (!context.auth.token.storeIds[storeId].includes("admin") &&
              !context.auth.token.storeIds[storeId].includes("manager") &&
              !context.auth.token.storeIds[storeId].includes("cashier"))
          ) {
            throw new Error("Error: User is not authorized for this action");
          }

          const mrspeedyOrderData = await cancelMrSpeedyOrder(
            mrspeedyBookingData.order.order_id
          );

          const { is_successful, order } = mrspeedyOrderData;

          if (is_successful) {
            return await db
              .collection("orders")
              .doc(orderId)
              .set(
                {
                  mrspeedyBookingData: { order },
                },
                { merge: true }
              )
              .then(() => {
                return {
                  s: 200,
                  m: "Successfully cancelled Mr. Speedy booking",
                };
              });
          } else {
            throw new Error("Failed to cancel Mr. Speedy booking");
          }
        });
      });
    } catch (e) {
      functions.logger.error(e);
      return { s: 500, m: "Error: Something went wrong" };
    }
  });

exports.mrspeedyNotification = async (req, res) => {
  const { headers, body } = req;

  try {
    if (headers["x-dv-signature"] === undefined) {
      throw new Error("Error: No signature found.");
    }

    const callbackSecret = await getMrSpeedyCallbackSecretKey();
    const hmac = createHmac("sha256", callbackSecret)
      .update(JSON.stringify(body))
      .digest("hex");

    if (headers["x-dv-signature"] !== hmac) {
      throw new Error("Error: Digest mismatch");
    }

    const { order, delivery, event_type, event_datetime } = body;

    functions.logger.log(body);

    const timestamp = await getCurrentTimestamp();

    if (event_type === "order_changed" && order) {
      const { points } = order;
      const orderId = points[1].client_order_id;

      let orderDocUpdateData = {
        mrspeedyBookingData: {
          order,
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
      };

      if (order.status === "completed") {
        orderDocUpdateData.orderStatus = {
          shipped: {
            status: false,
          },
          completed: {
            status: true,
            updatedAt: timestamp,
          },
        };
      }

      return await db
        .collection("orders")
        .doc(orderId)
        .set(orderDocUpdateData, { merge: true })
        .then(async () => {
          if (order.status === "completed") {
            const orderDoc = db.collection("orders").doc(orderId);
            const { merchantId, subTotal, deliveryPrice, deliveryDiscount } = (
              await orderDoc.get()
            ).data();
            const {
              weekStart,
              weekEnd,
            } = await getCurrentWeeklyPeriodFromTimestamp(timestamp);
            const period = `${weekStart}-${weekEnd}`;
            const merchantInvoiceDoc = db
              .collection("merchants")
              .doc(merchantId)
              .collection("disbursement_periods")
              .doc(period);
            const merchantInvoiceData = (await merchantInvoiceDoc.get()).data();

            if (
              merchantInvoiceData &&
              merchantInvoiceData.mrspeedy &&
              merchantInvoiceData.mrspeedy.lastIncrementedOrderId === orderId
            ) {
              return functions.logger.warn("Order ID already incremented");
            }

            // eslint-disable-next-line promise/no-nesting
            return await merchantInvoiceDoc.set(
              {
                startDate: moment(weekStart, "MMDDYYYY").format("MM-DD-YYYY"),
                endDate: moment(weekEnd, "MMDDYYYY").format("MM-DD-YYYY"),
                mrspeedy: {
                  transactionCount: firestore.FieldValue.increment(1),
                  totalAmount: firestore.FieldValue.increment(subTotal),
                  totalDeliveryPrice: firestore.FieldValue.increment(
                    deliveryPrice
                  ),
                  totalDeliveryDiscount: firestore.FieldValue.increment(
                    deliveryDiscount ? deliveryDiscount : 0
                  ),
                  lastIncrementedOrderId: orderId,
                  updatedAt: timestamp,
                },
                status: "Pending",
                updatedAt: timestamp,
              },
              { merge: true }
            );
          }

          return null;
        })
        .then(() => {
          return res.status(200).send("OK");
        });
    } else {
      return res.status(200).send("OK");
    }
  } catch (e) {
    functions.logger.error(e);
    return res.status(500);
  }
};
