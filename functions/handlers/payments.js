const { db } = require("../util/admin");
const queryString = require("query-string");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const client = new SecretManagerServiceClient();

const requestPayment = (secretkey, payload) => {
  const message = `${payload.merchantId}:${
    payload.transactionId
  }:${payload.amount.toFixed(2)}:${payload.currency}:${payload.description}:${
    payload.email
  }:${secretkey}`;

  const hash = SHA1(message).toString();

  const request = {
    merchantid: payload.merchantId,
    txnid: payload.transactionId,
    amount: payload.amount.toFixed(2),
    ccy: payload.currency,
    description: payload.description,
    email: payload.email,
    digest: hash,
    param1: payload.param1,
    param2: payload.param2,
    procid: payload.processId,
  };

  const url = `https://test.dragonpay.ph/Pay.aspx?${queryString.stringify(
    request
  )}`;

  return { url };
};

exports.getPaymentLink = async (req, res) => {
  const { amount, description, email, processId } = req.body;

  const transactionId = db.collection("payments").doc().id;

  const paymentInput = {
    merchantId: "MARKETEERPH",
    transactionId,
    amount,
    currency: "PHP",
    description,
    email,
    processId,
  };

  const [accessResponse] = await client.accessSecretVersion({
    name: "projects/1549607298/secrets/dragonpay_secret/versions/latest",
  });

  const secretKey = accessResponse.payload.data.toString("utf8");

  res.status(200).json(requestPayment(secretKey, paymentInput));

  /*
  return await db
    .collection("payments")
    .doc(txnid)
    .set(paymentRequest)
    .then(() => {
      return requestPayment(secretKey, paymentInput);
    })
    .then(() => {
      return functions.logger.log("executePayment success");
    })
    .catch((err) => {
      functions.logger.error(err);

      return { s: 400, m: err.message };
    });
    */
};

exports.checkPayment = (req, res) => {
  functions.logger.log("checkPayment", req.body);

  return res.status(200).json(req.body);
};

exports.result = (req, res) => {
  functions.logger.log("result", req.body);

  return res.status(200).json(req.body);
};
