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
const { getDragonPayApiKey } = require("../util/dragonpay");

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

exports.executePayoutTest = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    const apiKey = await getDragonPayApiKey();
    const merchantTxnId = db.collection("merchant_payouts").doc().id;
    const userName = "Daryl Kiel H. Mora";
    const amount = "1000";
    const currency = "PHP";
    const description = "Test Payout";
    const procId = "GCSH";
    const procDetail = "09175690965";
    const runDate = "2020-09-03";
    const email = "dkhmora@gmail.com";
    const mobileNo = "09175690965";

    const url =
      "https://test.dragonpay.ph/DragonPayWebService/PayoutService.asmx";
    const requestHeaders = {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "http://api.dragonpay.ph/RequestPayoutEx",
    };
    const xml = `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                  <soap:Body>
                    <RequestPayoutEx xmlns="http://api.dragonpay.ph/">
                      <apiKey>${apiKey}</apiKey>
                      <merchantTxnId>${merchantTxnId}</merchantTxnId>
                      <userName>${userName}</userName>
                      <amount>${amount}</amount>
                      <currency>${currency}</currency>
                      <description>${description}</description>
                      <procId>${procId}</procId>
                      <procDetail>${procDetail}</procDetail>
                      <runDate>${runDate}</runDate>
                      <email>${email}</email>
                      <mobileNo>${mobileNo}</mobileNo>
                    </RequestPayoutEx>
                  </soap:Body>
                </soap:Envelope>`;

    const { response } = await soapRequest({
      url: url,
      headers: requestHeaders,
      xml: xml,
      timeout: 10000,
    });
    const { headers, body, statusCode } = response;

    return functions.logger.log(body);
  });

exports.getMerchantPaymentLinkTest = functions
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

    const secretKey = await getDragonPaySecretKeyTest();
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
        return { s: 200, m: requestPaymentTest(secretKey, paymentInput) };
      })
      .catch((err) => {
        functions.logger.error(err);

        return { s: 400, m: err.message };
      });
  });

exports.getOrderPaymentLinkTest = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth.uid || !context.auth.token.phone_number) {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    const { email } = context.auth.token;
    const { orderId } = data;
    const orderDoc = db.collection("orders").doc(orderId);
    const orderData = (await orderDoc.get()).data();
    const {
      userId,
      processId,
      subTotal,
      storeName,
      merchantId,
      orderStatus,
      paymentLink,
    } = orderData;

    if (context.auth.uid !== userId) {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!orderStatus.unpaid.status) {
      return { s: 400, m: "Error: Order status is not valid for payment!" };
    }

    if (paymentLink) {
      return { s: 200, m: paymentLink };
    }

    const description = `Payment to ${storeName} for Order ${orderId} (Not inclusive of delivery fee)`;

    const paymentInput = {
      merchantId: "MARKETEERPH",
      transactionId: orderId,
      amount: subTotal,
      currency: "PHP",
      description,
      email,
      processId,
      param1: "order_payment",
      param2: userId,
    };

    const secretKey = await getDragonPaySecretKeyTest();
    const timeStamp = firestore.Timestamp.now().toMillis();

    functions.logger.log({
      orderId,
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

    return await db
      .collection("merchant_payments")
      .doc(transactionId)
      .set({
        paymentAmount: subTotal,
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
        return orderDoc.update({ paymentLink, updatedAt: timeStamp });
      })
      .then(() => {
        return { s: 200, m: requestPaymentTest(secretKey, paymentInput) };
      })
      .catch((err) => {
        functions.logger.error(err);

        return { s: 400, m: err.message };
      });
  });

exports.checkPaymentTest = async (req, res) => {
  const { txnid, status, digest, refno, message, param1, param2 } = req.body;
  let transactionDoc = null;

  if (param1 === "merchant_topup") {
    transactionDoc = db.collection("merchant_payments").doc(txnid);
  }

  if (param1 === "order_payment") {
    transactionDoc = db.collection("order_payments").doc(txnid);
  }

  res.setHeader("content-type", "text/plain");

  try {
    const secretKey = await getDragonPaySecretKeyTest();
    const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
    const confirmDigest = SHA1(confirmMessage).toString();

    if (digest !== confirmDigest) {
      throw new Error("Digest mismatch. Please try again.");
    } else {
      const paymentData = (await transactionDoc.get()).data();
      const merchantDoc = db
        .collection("merchants")
        .doc(paymentData.merchantId);
      const merchantData = (await merchantDoc.get()).data();
      const { creditData } = merchantData;

      if (status === "S" && param1 === "merchant_topup") {
        const { topUpAmount } = paymentData;
        const newCredits = creditData.credits + topUpAmount;

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

      if (status === "S" && param1 === "order_payment") {
        const { procId, paymentAmount } = paymentData;
        const { paymentGatewayFee } = payment_methods_test[procId];
        const merchantCreditedAmount = paymentAmount - paymentGatewayFee;
        const orderDoc = db.collection("orders").doc(txnid);
        const merchantOrderTransactionSummaryDoc = db
          .collection("merchants_order_transaction_summary")
          .doc(paymentData.merchantId);
        const timeStamp = firestore.Timestamp.now().toMillis();

        await orderDoc
          .set(
            {
              orderStatus: {
                paid: {
                  status: true,
                  updatedAt: timeStamp,
                },
              },
              updatedAt: timeStamp,
            },
            { merge: true }
          )
          .then(() => {
            return merchantOrderTransactionSummaryDoc.set(
              {
                currentPeriod: {
                  amount: firestore.FieldValue.increment(
                    merchantCreditedAmount
                  ),
                  noDeductionAmount: firestore.FieldValue.increment(
                    paymentAmount
                  ),
                  successfulTransactionCount: firestore.FieldValue.increment(1),
                  updatedAt: timeStamp,
                },
                lifetimePeriod: {
                  amount: firestore.FieldValue.increment(
                    merchantCreditedAmount
                  ),
                  noDeductionAmount: firestore.FieldValue.increment(
                    paymentAmount
                  ),
                  successfulTransactionCount: firestore.FieldValue.increment(1),
                  updatedAt: timeStamp,
                },
                updatedAt: timeStamp,
              },
              { merge: true }
            );
          });
      }

      await transactionDoc.update({
        status,
        refno,
        updatedAt: timeStamp,
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
