const { db } = require("./util/admin");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { firestore } = require("firebase-admin");
const {
  getDragonPaySecretKey,
  requestPayment,
  payment_methods,
} = require("./util/dragonpay");
const soapRequest = require("easy-soap-request");
const xml2js = require("xml2js");
const parser = new xml2js.Parser(/* options */);

exports.getAvailablePaymentProcessors = functions
  .region("asia-northeast1")
  .pubsub.schedule("every 15 minutes")
  .onRun(async (context) => {
    const merchantId = "MARKETEERPH";
    const password = await getDragonPaySecretKey();
    const amount = "-1000";
    const url =
      "https://gw.dragonpay.ph/DragonPayWebService/MerchantService.asmx";
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
        hasTxnPwd,
      } = item;

      finalJson[procId[0]] = {
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
        hasTxnPwd: hasTxnPwd[0] === "true",
      };
    });

    return await firestore()
      .collection("application")
      .doc("client_config")
      .update({
        availablePaymentMethods: finalJson,
      });
  });

exports.getMerchantPaymentLink = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth.token.merchantIds) {
      return { s: 400, m: "User is not authorized for this action" };
    }

    const { topUpAmount, email, processId } = data;
    const minAmount = 1000;

    if (topUpAmount < minAmount) {
      return {
        s: 400,
        m: "The minimimum top up amount is 1000 pesos. Please try again.",
      };
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
      amount: topUpAmount,
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
        paymentAmount: topUpAmount,
        topUpAmount,
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
