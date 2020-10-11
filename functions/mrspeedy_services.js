const {
  getOrderPriceEstimate,
  getMrSpeedyCourierInfo,
} = require("./util/mrspeedy");
const functions = require("firebase-functions");
const { db } = require("./util/admin");

exports.getUserMrSpeedyDeliveryPriceEstimate = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { deliveryLocation, deliveryAddress } = data;
    const { uid } = context.auth;

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

          functions.logger.log(subTotal, subTotal.toFixed(2));

          if (deliveryMethods.includes("Mr. Speedy")) {
            const motorbikeEstimate = await getOrderPriceEstimate({
              points,
              insurance_amount: subTotal.toFixed(2),
              motorbike: true,
            });
            const carEstimate = await getOrderPriceEstimate({
              points,
              insurance_amount: subTotal.toFixed(2),
              motorbike: false,
            });

            storeDeliveryFees[storeId] = {
              motorbike: Number(motorbikeEstimate),
              car: Number(carEstimate),
            };
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
    const { orderId, clientOrderId } = data;

    try {
      const { is_successful, courier } = await getMrSpeedyCourierInfo({
        orderId,
      });

      if (is_successful) {
        await db.collection("orders").doc(clientOrderId).set(
          {
            mrspeedyBookingData: { courier },
          },
          { merge: true }
        );
      } else {
        throw new Error("Failed to get courier data");
      }

      return await getMrSpeedyCourierInfo({ orderId });
    } catch (e) {
      functions.logger.error(e);
      return { s: 500, m: "Error: Something went wrong" };
    }
  });

exports.mrspeedyNotification = async (req, res) => {
  functions.logger.log(req);
};
