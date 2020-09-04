const queryString = require("query-string");
const { SHA1 } = require("crypto-js");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const client = new SecretManagerServiceClient();

const payment_methods_test = {
  BDO: { paymentGatewayFee: 10, disabled: false },
  CBC: { paymentGatewayFee: 10, disabled: false },
  LBPA: { paymentGatewayFee: 10, disabled: false },
  BPI: { paymentGatewayFee: 10, disabled: false },
  MAYB: { paymentGatewayFee: 10, disabled: false },
  RSB: { paymentGatewayFee: 10, disabled: false },
  BDRX: { paymentGatewayFee: 15, disabled: false },
  BPXB: { paymentGatewayFee: 15, disabled: false },
  MBXB: { paymentGatewayFee: 15, disabled: false },
  BNRX: { paymentGatewayFee: 15, disabled: false },
  AUB: { paymentGatewayFee: 15, disabled: false },
  CBCX: { paymentGatewayFee: 15, disabled: false },
  EWXB: { paymentGatewayFee: 15, disabled: false },
  LBXB: { paymentGatewayFee: 15, disabled: false },
  PNBB: { paymentGatewayFee: 15, disabled: false },
  PNXB: { paymentGatewayFee: 15, disabled: false },
  RCXB: { paymentGatewayFee: 15, disabled: false },
  RSBB: { paymentGatewayFee: 15, disabled: false },
  SBCB: { paymentGatewayFee: 15, disabled: false },
  UBXB: { paymentGatewayFee: 15, disabled: false },
  UCXB: { paymentGatewayFee: 15, disabled: false },
  BAYD: { paymentGatewayFee: 20, disabled: false },
  LBC: { paymentGatewayFee: 20, disabled: false },
  SMR: { paymentGatewayFee: 20, disabled: false },
  CEBL: { paymentGatewayFee: 20, disabled: false },
  RDS: { paymentGatewayFee: 20, disabled: false },
  ECPY: { paymentGatewayFee: 20, disabled: false },
  PLWN: { paymentGatewayFee: 20, disabled: false },
  RDP: { paymentGatewayFee: 20, disabled: false },
  RLNT: { paymentGatewayFee: 20, disabled: false },
  MBTC: { paymentGatewayFee: 10, disabled: false },
  PSB: { paymentGatewayFee: 10, disabled: false },
  RCBC: { paymentGatewayFee: 10, disabled: false },
  UBPB: { paymentGatewayFee: 10, disabled: false },
  UCPB: { paymentGatewayFee: 10, disabled: false },
  BITC: { paymentGatewayFee: 10, disabled: false },
  GRPY: { paymentGatewayFee: 20, disabled: false },
  I2I: { paymentGatewayFee: 15, disabled: false },
  GCSH: { paymentGatewayFee: 20, disabled: true },
  711: { paymentGatewayFee: 20, disabled: true },
  BDOA: { paymentGatewayFee: 15, disabled: false },
  BPIA: { paymentGatewayFee: 10, disabled: false },
  DPAY: { paymentGatewayFee: 10, disabled: false },
  MLH: { paymentGatewayFee: 20, disabled: false },
};

const getDragonPaySecretKeyTest = async () => {
  const [accessResponse] = await client.accessSecretVersion({
    name: "projects/1549607298/secrets/dragonpay_secret_test/versions/latest",
  });
  const secretKey = accessResponse.payload.data.toString("utf8");

  return secretKey;
};

const requestPaymentTest = (secretkey, payload) => {
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

module.exports = {
  requestPaymentTest,
  getDragonPaySecretKeyTest,
  payment_methods_test,
};
