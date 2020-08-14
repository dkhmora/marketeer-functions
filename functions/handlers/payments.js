const { db } = require("../util/admin");
const queryString = require("query-string");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { firestore } = require("firebase-admin");
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

exports.getMerchantPaymentLink = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { amount, processId } = data;
    const email = context.auth.token.email;

    if (!context.auth.token.merchantIds) {
      return { s: 400, m: "User is not authorized for this action" };
    }

    const merchantId = Object.keys(context.auth.token.merchantIds)[0];
    const { storeName } = (
      await db.collection("merchants").doc(merchantId).get()
    ).data();

    const description = `${storeName} Markee Credits Top Up`;

    const transactionId = db.collection("merchant_payments").doc().id;

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

    const timeStamp = firestore.Timestamp.now().toMillis();

    return await db
      .collection("merchant_payments")
      .doc(transactionId)
      .set({
        transactionId,
        amount,
        merchantId,
        currency: "PHP",
        description,
        email,
        processId,
        status: "U",
        createdAt: timeStamp,
        updatedAt: timeStamp,
      })
      .then(() => {
        return { s: 200, m: requestPayment(secretKey, paymentInput) };
      })
      .catch((err) => {
        functions.logger.error(err);

        return { s: 400, m: err.message };
      });
  });

exports.checkPayment = async (req, res) => {
  const { txnid, status, digest, refno, message } = req.body;
  const merchantPaymentsDoc = db.collection("merchant_payments").doc(txnid);

  res.setHeader("content-type", "text/plain");
  try {
    const [accessResponse] = await client.accessSecretVersion({
      name: "projects/1549607298/secrets/dragonpay_secret/versions/latest",
    });
    const secretKey = accessResponse.payload.data.toString("utf8");
    const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
    const confirmDigest = SHA1(confirmMessage).toString();

    if (digest !== confirmDigest) {
      throw new Error("Digest mismatch. Please try again.");
    } else {
      await merchantPaymentsDoc.update({
        status,
        refno,
        updatedAt: firestore.Timestamp.now().toMillis(),
      });
    }

    return res.send("result=OK");
  } catch (error) {
    functions.logger.error(error);

    return res.status(400).json({
      m: error,
    });
  }
};

exports.result = (req, res) => {
  return res.status(200).json({ m: "Payment success!" });
};
