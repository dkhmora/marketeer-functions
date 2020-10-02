const { getOrderPriceEstimate } = require("./util/mrspeedy");
const functions = require("firebase-functions");
const { db } = require("./util/admin");

exports.getMrSpeedyDeliveryPriceEstimate = functions
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
