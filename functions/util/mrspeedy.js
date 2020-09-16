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

const getOrderPriceEstimate = async ({ points }) => {
  return fetch(
    "https://robotapitest.mrspeedy.ph/api/business/1.1/calculate-order",
    {
      method: "post",
      body: JSON.stringify({
        matter: "Order price estimation",
        points,
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
      return json.order.delivery_fee_amount;
    });
};

const placeMrSpeedyOrder = async ({ points }) => {
  return fetch(
    "https://robotapitest.mrspeedy.ph/api/business/1.1/create-order",
    {
      method: "post",
      body: JSON.stringify({
        matter: "Documents",
        points,
      }),
      headers: {
        "X-DV-Auth-Token": await getMrSpeedySecretKey(),
      },
    }
  ).then((res) => {
    return res.json();
  });
};

const cancelMrSpeedyOrder = async ({ orderId }) => {
  return fetch(
    "https://robotapitest.mrspeedy.ph/api/business/1.1/cancel-order",
    {
      method: "post",
      body: JSON.stringify({
        order_id: orderId,
      }),
      headers: {
        "X-DV-Auth-Token": await getMrSpeedySecretKey(),
      },
    }
  ).then((res) => {
    return res.json();
  });
};

const getMrSpeedyCourierInfo = async ({ orderId }) => {
  return fetch("https://robotapitest.mrspeedy.ph/api/business/1.1/courier", {
    method: "get",
    body: JSON.stringify({
      order_id: orderId,
    }),
    headers: {
      "X-DV-Auth-Token": await getMrSpeedySecretKey(),
    },
  }).then((res) => {
    return res.json();
  });
};

module.exports = {
  getMrSpeedySecretKey,
  getOrderPriceEstimate,
  placeMrSpeedyOrder,
  cancelMrSpeedyOrder,
  getMrSpeedyCourierInfo,
};
