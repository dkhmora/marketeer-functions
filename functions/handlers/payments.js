const { db } = require("../util/admin");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { firestore } = require("firebase-admin");
const {
  getDragonPaySecretKey,
  requestPayment,
  payment_methods,
} = require("../util/dragonpay");

exports.getMerchantPaymentLink = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth.token.merchantIds) {
      return { s: 400, m: "User is not authorized for this action" };
    }

    const { amount, email, processId } = data;
    const { fixedFee, percentageFee } = payment_methods[processId];

    const pFee = percentageFee
      ? percentageFee
        ? 1 - percentageFee * 0.01
        : 1
      : 1;
    const fFee = fixedFee ? fixedFee : 0;

    const topUpAmount = amount / pFee + fFee;
    const roundedTopUpAmount =
      Math.round((topUpAmount + Number.EPSILON) * 100) / 100;

    functions.logger.log(
      `amount: ${amount}, `,
      `topUpAmount: ${topUpAmount}, `,
      `roundedTopUpAmount: ${roundedTopUpAmount}`
    );

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
      param1: "merchant_topup",
      param2: merchantId,
    };

    const secretKey = await getDragonPaySecretKey();
    const timeStamp = firestore.Timestamp.now().toMillis();

    return await db
      .collection("merchant_payments")
      .doc(transactionId)
      .set({
        transactionId,
        paymentAmount: amount,
        topUpAmount: roundedTopUpAmount,
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
  const { txnid, status, digest, refno, message, param1, param2 } = req.body;
  let transactionDoc = null;

  if (param1 === "merchant_topup") {
    transactionDoc = db.collection("merchant_payments").doc(txnid);
  }

  res.setHeader("content-type", "text/plain");

  try {
    const secretKey = await getDragonPaySecretKey();
    const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
    const confirmDigest = SHA1(confirmMessage).toString();

    if (digest !== confirmDigest) {
      throw new Error("Digest mismatch. Please try again.");
    } else {
      const merchantPaymentData = (await transactionDoc.get()).data();
      const { merchantId, topUpAmount } = merchantPaymentData;
      const merchantDoc = db.collection("merchants").doc(merchantId);
      const merchantData = (await merchantDoc.get()).data();
      const { creditData } = merchantData;
      const newCredits = creditData.credits + topUpAmount;

      if (status === "S") {
        await merchantDoc.set(
          {
            creditData: {
              credits: firestore.FieldValue.increment(topUpAmount),
              creditThresholdReached:
                newCredits >= creditData.creditThreshold ? false : true,
            },
          },
          { merge: true }
        );
      }

      await transactionDoc.update({
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

exports.result = async (req, res) => {
  const { txnid, status, digest, refno, message } = req.query;
  const secretKey = await getDragonPaySecretKey();
  const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
  const confirmDigest = SHA1(confirmMessage).toString();

  if (digest !== confirmDigest) {
    throw new Error("Digest mismatch. Please try again.");
  } else {
    switch (status) {
      case "S":
        res.redirect("https://marketeer.ph/app/merchant/payment/success");
        break;
      case "F":
        res.redirect("https://marketeer.ph/app/merchant/payment/failure");
        break;
      case "P":
        res.redirect("https://marketeer.ph/app/merchant/payment/pending");
        break;
      case "U":
        res.redirect("https://marketeer.ph/app/merchant/payment/unknown");
        break;
      case "R":
        res.redirect("https://marketeer.ph/app/merchant/payment/refund");
        break;
      case "K":
        res.redirect("https://marketeer.ph/app/merchant/payment/chargeback");
        break;
      case "V":
        res.redirect("https://marketeer.ph/app/merchant/payment/void");
        break;
      case "A":
        res.redirect("https://marketeer.ph/app/merchant/payment/authorized");
        break;
      default:
        res.redirect("https://marketeer.ph/app/merchant/payment/error");
        break;
    }
  }
};
