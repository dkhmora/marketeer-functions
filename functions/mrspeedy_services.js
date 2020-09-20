const { getOrderPriceEstimate } = require("./util/mrspeedy");
const functions = require("firebase-functions");
const { db } = require("./util/admin");

exports.getMrSpeedyDeliveryPriceEstimate = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { deliveryLocation, deliveryAddress } = data;
    const { uid } = context.auth;

    const cartStoreIds = Object.keys(
      (await db.collection("user_carts").doc(uid).get()).data()
    );

    let storeDeliveryFees = {};

    try {
      return await Promise.all(
        cartStoreIds.map(async (storeId) => {
          const { storeLocation, address, deliveryMethods } = (
            await db.collection("stores").doc(storeId).get()
          ).data();

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
            const motorbikeEstimate = await getOrderPriceEstimate({
              points,
              motorbike: true,
            });
            const carEstimate = await getOrderPriceEstimate({
              points,
              motorbike: false,
            });

            storeDeliveryFees[
              storeId
            ] = `₱${motorbikeEstimate}(Max. 20kg) - ₱${carEstimate}(Max. 300kg)`;
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
