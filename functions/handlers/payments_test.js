const { db } = require("../util/admin");
const axios = require("axios");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { firestore } = require("firebase-admin");
const soapRequest = require("easy-soap-request");
const xml2js = require("xml2js");
const parser = new xml2js.Parser(/* options */);
const {
  requestPaymentTest,
  getDragonPaySecretKeyTest,
  payment_methods_test,
} = require("../util/dragonpay_test");

/* Dragonpay Test API (getAvailablePaymentProcessors)
exports.getAvailablePaymentProcessorsTest = functions
  .region("asia-northeast1")
  .pubsub.schedule("every 5 minutes")
  .onRun(async (context) => {
    const merchantId = "MARKETEERPH";
    const password = await getDragonPaySecretKeyTest();
    const amount = "-1000";
    const url =
      "https://test.dragonpay.ph/DragonPayWebService/MerchantService.asmx";
    const requestHeaders = {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "http://api.dragonpay.ph/GetAvailableProcessors",
    };
    const xml = `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body>
                      <GetAvailableProcessors xmlns="http://api.dragonpay.ph/">
                        <merchantId>${merchantId}</merchantId>
                        <password>${password}</password>
                        <amount>${amount}</amount>
                      </GetAvailableProcessors>
                    </soap:Body>
                  </soap:Envelope>`;

    const { response } = await soapRequest({
      url: url,
      headers: requestHeaders,
      xml: xml,
      timeout: 10000,
    });
    const { headers, body, statusCode } = response;
    const json = (
      await parser.parseStringPromise(body).then((result) => {
        return result;
      })
    )["soap:Envelope"]["soap:Body"][0]["GetAvailableProcessorsResponse"][0][
      "GetAvailableProcessorsResult"
    ][0]["ProcessorInfo"];

    let finalJson = {};

    await json.map((item, index) => {
      const {
        procId,
        longName,
        logo,
        minAmount,
        maxAmount,
        mustRedirect,
        pwd,
        realTime,
        remarks,
        shortName,
        status,
        startTime,
        surcharge,
        type,
        url,
        cost,
        currencies,
        dayOfWeek,
        defaultBillerId,
        endTime,
        hasAltRefNo,
        hasManualEnrollment,
      } = item;

      finalJson[item.procId] = {
        procId: procId[0],
        longName: longName[0],
        logo: logo[0],
        minAmount: Number(minAmount[0]),
        maxAmount: Number(maxAmount[0]),
        mustRedirect: mustRedirect[0] === "true",
        pwd: pwd[0],
        realTime: realTime[0] === "true",
        remarks: remarks[0],
        shortName: shortName[0],
        status: status[0],
        startTime: startTime[0],
        surcharge: Number(surcharge[0]),
        type: type[0],
        url: url[0],
        cost: Number(cost[0]),
        currencies: currencies[0],
        dayOfWeek: dayOfWeek[0],
        defaultBillerId: defaultBillerId[0],
        endTime: endTime[0],
        hasAltRefNo: hasAltRefNo[0] === "true",
        hasManualEnrollment: hasManualEnrollment[0] === "true",
      };
    });

    return await firestore()
      .collection("application")
      .doc("client_config_test")
      .update({
        availablePaymentMethods: finalJson,
      });
  });
  */

exports.getMerchantPaymentLinkTest = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth.token.merchantIds) {
      return { s: 400, m: "User is not authorized for this action" };
    }

    const { amount, email, processId } = data;
    const { fixedFee, percentageFee } = payment_methods_test[processId];

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

    const secretKey = await getDragonPaySecretKeyTest();
    const timeStamp = firestore.Timestamp.now().toMillis();

    functions.logger.log({
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
    });

    return { s: 200, m: requestPaymentTest(secretKey, paymentInput) };
  });

exports.checkPaymentTest = async (req, res) => {
  const { txnid, status, digest, refno, message, param1, param2 } = req.body;
  let transactionDoc = null;

  if (param1 === "merchant_topup") {
    transactionDoc = db.collection("merchant_payments").doc(txnid);
  }

  res.setHeader("content-type", "text/plain");

  try {
    const secretKey = await getDragonPaySecretKeyTest();
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

exports.resultTest = async (req, res) => {
  const { txnid, status, digest, refno, message } = req.query;
  const secretKey = await getDragonPaySecretKeyTest();
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
