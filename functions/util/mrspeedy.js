const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const functions = require("firebase-functions");
const client = new SecretManagerServiceClient();
const fetch = require("node-fetch");
const { db } = require("./admin");
const { SECRET_PROJECT_ID, DEV_MODE } = require("./config");

/* UNCOMMENT WHEN PRODUCTION READY
const BASE_URL = DEV_MODE
  ? "https://robotapitest.mrspeedy.ph/api/business/1.1"
  : "https://robot.mrspeedy.ph/api/business/1.1";
*/
const BASE_URL = "https://robotapitest.mrspeedy.ph/api/business/1.1";

const getMrSpeedySecretKey = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name: `projects/${SECRET_PROJECT_ID}/secrets/mrspeedy_api_key/versions/latest`,
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
};

const getMrSpeedyCallbackSecretKey = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name: `projects/${SECRET_PROJECT_ID}/secrets/mrspeedy_callback_key/versions/latest`,
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
};

const getOrderPriceEstimate = async ({
  points,
  insurance_amount,
  motorbike,
  orderWeight,
  paymentMethod,
}) => {
  functions.logger.log("insurance", insurance_amount);

  return fetch(`${BASE_URL}/calculate-order`, {
    method: "post",
    body: JSON.stringify({
      matter: "Order price estimation",
      points,
      insurance_amount,
      vehicle_type_id: motorbike ? 8 : 7,
      total_weight_kg: orderWeight ? orderWeight : 0,
      payment_method: paymentMethod === "COD" ? "cash" : "non_cash",
    }),
    headers: {
      "X-DV-Auth-Token": await getMrSpeedySecretKey(),
    },
  })
    .then((res) => {
      return res.json();
    })
    .then((json) => {
      functions.logger.log(json);
      return json.order.payment_amount;
    });
};

const placeMrSpeedyOrder = async ({
  matter,
  points,
  insurance_amount,
  is_motobox_required,
  payment_method,
  total_weight_kg,
  vehicle_type_id,
}) => {
  return fetch(`${BASE_URL}/create-order`, {
    method: "post",
    body: JSON.stringify({
      matter,
      points,
      insurance_amount,
      is_motobox_required,
      payment_method,
      total_weight_kg,
      vehicle_type_id,
      is_contact_person_notification_enabled: true,
    }),
    headers: {
      "X-DV-Auth-Token": await getMrSpeedySecretKey(),
    },
  }).then((res) => {
    return res.json();
  });
};

const cancelMrSpeedyOrder = async (orderId) => {
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

const getMrSpeedyCourierInfo = async (orderId) => {
  return fetch(`${BASE_URL}/courier?order_id=${orderId}`, {
    method: "get",
    headers: {
      "X-DV-Auth-Token": await getMrSpeedySecretKey(),
    },
  }).then((res) => {
    return res.json();
  });
};

module.exports = {
  getMrSpeedySecretKey,
  getMrSpeedyCallbackSecretKey,
  getOrderPriceEstimate,
  placeMrSpeedyOrder,
  cancelMrSpeedyOrder,
  getMrSpeedyCourierInfo,
};
