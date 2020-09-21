const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const client = new SecretManagerServiceClient();
const fetch = require("node-fetch");
const { db } = require("./admin");
const { SECRET_PROJECT_ID, DEV_MODE } = require("./config");

const BASE_URL = DEV_MODE
  ? "https://robotapitest.mrspeedy.ph/api/business/1.1"
  : "https://robot.mrspeedy.ph/api/business/1.1";

const getMrSpeedySecretKey = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name: `projects/${SECRET_PROJECT_ID}/secrets/mrspeedy_api_key/versions/latest`,
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
};

const getOrderPriceEstimate = async ({ points, motorbike }) => {
  return fetch(`${BASE_URL}/calculate-order`, {
    method: "post",
    body: JSON.stringify({
      matter: "Order price estimation",
      points,
      vehicle_type_id: motorbike ? 8 : 7,
    }),
    headers: {
      "X-DV-Auth-Token": await getMrSpeedySecretKey(),
    },
  })
    .then((res) => {
      return res.json();
    })
    .then((json) => {
      return json.order.delivery_fee_amount;
    });
};

const placeMrSpeedyOrder = async ({ points }) => {
  return fetch(`${BASE_URL}/create-order`, {
    method: "post",
    body: JSON.stringify({
      matter: "Documents",
      points,
    }),
    headers: {
      "X-DV-Auth-Token": await getMrSpeedySecretKey(),
    },
  }).then((res) => {
    return res.json();
  });
};

const cancelMrSpeedyOrder = async ({ orderId }) => {
  return fetch(`${BASE_URL}/cancel-order`, {
    method: "post",
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

const getMrSpeedyCourierInfo = async ({ orderId }) => {
  return fetch(`${BASE_URL}/courier`, {
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
