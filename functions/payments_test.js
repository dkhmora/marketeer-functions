const { db } = require("./util/admin");
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
} = require("./util/dragonpay_test");
const { getDragonPayApiKey } = require("./util/dragonpay");
const moment = require("moment");

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

exports.getOrderPaymentLinkTest = async ({ orderData, orderId }) => {
  const {
    userId,
    userEmail,
    processId,
    subTotal,
    deliveryMethod,
    deliveryPrice,
    storeName,
    storeId,
    merchantId,
  } = orderData;
  const { paymentGatewayFee } = payment_methods_test[processId];
  const transactionDoc = db.collection("order_payments").doc(orderId);
  const description =
    deliveryMethod !== "Own Delivery"
      ? `Payment to ${storeName} for Order ${orderId} (Not inclusive of delivery fee)`
      : `Payment to ${storeName} for Order ${orderId} (Inclusive of delivery fee)`;
  const amount =
    deliveryMethod === "Own Delivery" ? subTotal + deliveryPrice : subTotal;

  const paymentInput = {
    merchantId: "MARKETEERPH",
    transactionId: orderId,
    amount,
    currency: "PHP",
    description,
    email: userEmail,
    processId,
    param1: "order_payment",
    param2: userId,
  };

  const secretKey = await getDragonPaySecretKeyTest();
  const timeStamp = firestore.Timestamp.now().toMillis();

  return await transactionDoc
    .set({
      paymentAmount: amount,
      paymentGatewayFee,
      storeId,
      merchantId,
      currency: "PHP",
      description,
      userEmail,
      processId,
      status: "U",
      createdAt: timeStamp,
      updatedAt: timeStamp,
    })
    .then(() => {
      return requestPaymentTest(secretKey, paymentInput).url;
    });
};

exports.checkPaymentTest = async (req, res) => {
  const { txnid, status, digest, refno, message, param1, param2 } = req.body;

  res.setHeader("content-type", "text/plain");

  try {
    const secretKey = await getDragonPaySecretKeyTest();
    const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
    const confirmDigest = SHA1(confirmMessage).toString();
    const transactionDoc =
      param1 === "merchant_topup"
        ? db.collection("merchant_payments").doc(txnid)
        : param1 === "order_payment"
        ? db.collection("order_payments").doc(txnid)
        : null;
    const timeStamp = firestore.Timestamp.now().toMillis();

    if (digest !== confirmDigest) {
      throw new Error("Digest mismatch. Please try again.");
    } else {
      const paymentData = (await transactionDoc.get()).data();
      const { topUpAmount, merchantId, processId, paymentAmount } = paymentData;
      const merchantDoc = db.collection("merchants").doc(merchantId);
      const merchantData = (await merchantDoc.get()).data();
      const { creditData } = merchantData;

      if (status === "S") {
        if (param1 === "merchant_topup") {
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

        if (param1 === "order_payment") {
          const { paymentGatewayFee } = payment_methods_test[processId];
          const orderDoc = db.collection("orders").doc(txnid);
          const monthStart = moment(timeStamp, "x")
            .startOf("month")
            .format("MMDDYYYY");
          const monthEnd = moment(timeStamp, "x")
            .endOf("month")
            .format("MMDDYYYY");
          const merchantInvoiceDoc = db
            .collection("merchants")
            .doc(merchantId)
            .collection("invoices")
            .doc(`${monthStart}-${monthEnd}`);

          await orderDoc
            .set(
              {
                orderStatus: {
                  unpaid: {
                    status: false,
                  },
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
              return merchantInvoiceDoc.get();
            })
            .then((document) => {
              if (document.exists) {
                return merchantInvoiceDoc.update({
                  successfulTransactionCount: firestore.FieldValue.increment(1),
                  totalAmount: firestore.FieldValue.increment(paymentAmount),
                  totalPaymentGatewayDeductedAmount: firestore.FieldValue.increment(
                    paymentGatewayFee
                  ),
                  updatedAt: timeStamp,
                });
              }

              return merchantInvoiceDoc.set({
                startDate: moment(monthEnd, "MMDDYYYY")
                  .startOf("month")
                  .format("MM-DD-YYYY"),
                endDate: moment(monthEnd, "MMDDYYYY")
                  .endOf("month")
                  .format("MM-DD-YYYY"),
                successfulTransactionCount: firestore.FieldValue.increment(1),
                totalAmount: firestore.FieldValue.increment(
                  merchantCreditedAmount
                ),
                totalPaymentGatewayDeductedAmount: firestore.FieldValue.increment(
                  paymentGatewayFee
                ),
                updatedAt: timeStamp,
                createdAt: timeStamp,
              });
            });
        }
      }

      if (status === "F") {
        if (param1 === "order_payment") {
          const orderDoc = db.collection("orders").doc(txnid);

          await orderDoc.set(
            {
              orderStatus: {
                unpaid: {
                  status: false,
                },
                cancelled: {
                  status: true,
                  updatedAt: timeStamp,
                },
              },
              updatedAt: timeStamp,
            },
            { merge: true }
          );
        }
      }

      transactionDoc.update({
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
  const { txnid, status, digest, refno, message, param1, param2 } = req.query;
  const secretKey = await getDragonPaySecretKeyTest();
  const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
  const confirmDigest = SHA1(confirmMessage).toString();

  if (digest !== confirmDigest) {
    throw new Error("Digest mismatch. Please try again.");
  } else {
    if (param1 === "merchant_topup") {
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

    if (param1 === "order_payment") {
      switch (status) {
        case "S":
          res.redirect("https://marketeer.ph/app/order/payment/success");
          break;
        case "F":
          res.redirect("https://marketeer.ph/app/order/payment/failure");
          break;
        case "P":
          res.redirect("https://marketeer.ph/app/order/payment/pending");
          break;
        case "U":
          res.redirect("https://marketeer.ph/app/order/payment/unknown");
          break;
        case "R":
          res.redirect("https://marketeer.ph/app/order/payment/refund");
          break;
        case "K":
          res.redirect("https://marketeer.ph/app/order/payment/chargeback");
          break;
        case "V":
          res.redirect("https://marketeer.ph/app/order/payment/void");
          break;
        case "A":
          res.redirect("https://marketeer.ph/app/order/payment/authorized");
          break;
        default:
          res.redirect("https://marketeer.ph/app/order/payment/error");
          break;
      }
    }
  }
};
