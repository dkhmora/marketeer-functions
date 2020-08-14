const { db } = require("../util/admin");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { firestore } = require("firebase-admin");
const { getDragonPaySecretKey, requestPayment } = require('../util/dragonpay');

exports.getMerchantPaymentLink = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth.token.merchantIds) {
      return { s: 400, m: "User is not authorized for this action" };
    }

    const { amount, processId } = data;
    const email = context.auth.token.email;
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

    const secretKey = await getDragonPaySecretKey();
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
    const secretKey = await getDragonPaySecretKey();
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
