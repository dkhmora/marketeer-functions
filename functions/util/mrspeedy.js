const { SHA1 } = require("crypto-js");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const client = new SecretManagerServiceClient();
const functions = require("firebase-functions");
const fetch = require("node-fetch");
const { db } = require("./admin");

const getMrSpeedySecretKey = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name: "projects/1549607298/secrets/mrspeedy_api_key/versions/latest",
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
};

const getOrderPriceEstimate = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { deliveryLocation, deliveryAddress } = data;
    const { uid } = context.auth;

    const cartStoreIds = Object.keys(
      (await db.collection("user_carts").doc(uid).get()).data()
    );

    functions.logger.log(cartStoreIds, deliveryLocation, deliveryAddress);

    let storeDeliveryFees = {};

    try {
      return await Promise.all(
        cartStoreIds.map(async (storeId) => {
          const { storeLocation, address, deliveryMethods } = (
            await db.collection("stores").doc(storeId).get()
          ).data();

          if (deliveryMethods.includes("Mr. Speedy")) {
            return fetch(
              "https://robotapitest.mrspeedy.ph/api/business/1.1/calculate-order",
              {
                method: "post",
                body: JSON.stringify({
                  matter: "Documents",
                  points: [
                    {
                      address,
                      ...storeLocation,
                    },
                    {
                      address: deliveryAddress,
                      ...deliveryLocation,
                    },
                  ],
                }),
                headers: {
                  "X-DV-Auth-Token": await getMrSpeedySecretKey(),
                },
              }
            )
              .then((res) => {
                return res.json();
              })
              .then((json) => {
                storeDeliveryFees[storeId] = json.order.delivery_fee_amount;

                return;
              });
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

    /*
    const deliveryFees = async () => {
      return await fetch(
        "https://robotapitest.mrspeedy.ph/api/business/1.1/calculate-order",
        {
          method: "post",
          body: JSON.stringify({
            matter: "Documents",
            points: [
              {
                address: "ABC",
                latitude: "14.6737037",
                longitude: "121.0911911",
              },
              {
                address: "DEF",
                latitude: "14.5528233",
                longitude: "121.0519364",
              },
            ],
          }),
          headers: {
            "X-DV-Auth-Token": await getMrSpeedySecretKey(),
          },
        }
      )
        .then((res) => {
          return res.json();
        })
        .then((json) => {
          return json;
        })
        .catch((err) => {
          return err;
        });
    };
    */
  });

module.exports = {
  getMrSpeedySecretKey,
  getOrderPriceEstimate,
};
