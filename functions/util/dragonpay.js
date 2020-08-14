const queryString = require("query-string");
const { SHA1 } = require("crypto-js");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const client = new SecretManagerServiceClient();

const getDragonPaySecretKey = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name: "projects/1549607298/secrets/dragonpay_secret/versions/latest",
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
}

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

module.exports = {requestPayment, getDragonPaySecretKey};