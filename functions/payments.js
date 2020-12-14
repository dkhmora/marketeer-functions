const { db, admin } = require("./util/admin");
const functions = require("firebase-functions");
const { SHA1 } = require("crypto-js");
const { firestore } = require("firebase-admin");
const soapRequest = require("easy-soap-request");
const xml2js = require("xml2js");
const parser = new xml2js.Parser(/* options */);
const moment = require("moment");
const {
  getDragonPaySecretKey,
  requestPayment,
  requestPaymentOperation,
  payment_methods,
} = require("./util/dragonpay");
const { DEV_MODE, functionsRegionHttps } = require("./util/config");
const {
  getCurrentWeeklyPeriodFromTimestamp,
  getCurrentTimestamp,
} = require("./helpers/time");

exports.getAvailablePaymentProcessors = functions
  .region("asia-northeast1")
  .pubsub.schedule(DEV_MODE ? "every 6 hours" : "every 15 minutes")
  .onRun(async (context) => {
    const merchantId = "MARKETEERPH";
    const password = await getDragonPaySecretKey();
    const amount = "-1000";
    const url = DEV_MODE
      ? "https://test.dragonpay.ph/DragonPayWebService/MerchantService.asmx"
      : "https://gw.dragonpay.ph/DragonPayWebService/MerchantService.asmx";
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

exports.getMerchantTopUpPaymentLink = functionsRegionHttps.onCall(
  async (data, context) => {
    const { uid, role } = context.auth.token;
    const userId = uid;

    if (!userId || !role || (role && role !== "merchant")) {
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
    const description = `Merchant #${userId} Markee Credits Top Up`;
    const transactionId = db.collection("merchant_topups").doc().id;

    const paymentInput = {
      merchantId: "MARKETEERPH",
      transactionId,
      amount: topUpAmount,
      currency: "PHP",
      description,
      email,
      processId,
      param1: "merchant_topup",
      param2: userId,
    };

    const secretKey = await getDragonPaySecretKey();
    const timestamp = await getCurrentTimestamp();

    return await db
      .collection("merchant_topups")
      .doc(transactionId)
      .set({
        transactionId,
        paymentAmount: topUpAmount,
        topUpAmount,
        merchantId: userId,
        currency: "PHP",
        description,
        email,
        processId,
        status: "U",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .then(() => {
        return { s: 200, m: requestPayment(secretKey, paymentInput) };
      })
      .catch((err) => {
        functions.logger.error(err);

        return { s: 400, m: err.message };
      });
  }
);

exports.editTransaction = async ({ operation, txnId }) => {
  const operationLink = (await requestPaymentOperation({ operation, txnId }))
    .url;

  return await fetch(operationLink);
};

exports.getOrderPaymentLink = async ({ orderData, orderId }) => {
  const {
    userId,
    userEmail,
    processId,
    subTotal,
    transactionFee,
    deliveryMethod,
    deliveryPrice = 0,
    deliveryDiscount = 0,
    storeName,
    storeId,
    merchantId,
    marketeerVoucherDetails: { delivery } = {},
  } = orderData;
  const { paymentGatewayFee } = payment_methods[processId];
  const transactionDoc = db.collection("order_payments").doc(orderId);
  const description =
    deliveryMethod !== "Own Delivery"
      ? `Payment to ${storeName} for Order #${orderId} (Not inclusive of delivery fee)`
      : `Payment to ${storeName} for Order #${orderId} (Inclusive of delivery fee)`;
  const amount =
    subTotal +
    Math.max(0, deliveryPrice - delivery.discount.amount - deliveryDiscount);

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

  const secretKey = await getDragonPaySecretKey();
  const timestamp = await getCurrentTimestamp();

  return await transactionDoc
    .set({
      paymentAmount: amount,
      subTotal,
      deliveryPrice,
      deliveryMethod,
      transactionFee,
      paymentGatewayFee,
      storeId,
      merchantId,
      userId,
      currency: "PHP",
      description,
      userEmail,
      processId,
      status: "U",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .then(() => {
      return requestPayment(secretKey, paymentInput).url;
    });
};

exports.checkPayment = async (req, res) => {
  const { txnid, status, digest, refno, message, param1, param2 } = req.body;

  res.setHeader("content-type", "text/plain");

  try {
    const secretKey = await getDragonPaySecretKey();
    const confirmMessage = `${txnid}:${refno}:${status}:${message}:${secretKey}`;
    const confirmDigest = SHA1(confirmMessage).toString();
    const transactionDoc =
      param1 === "merchant_topup"
        ? db.collection("merchant_topups").doc(txnid)
        : param1 === "order_payment"
        ? db.collection("order_payments").doc(txnid)
        : null;
    const timestamp = await getCurrentTimestamp();

    if (digest !== confirmDigest) {
      throw new Error("Digest mismatch. Please try again.");
    } else {
      const paymentData = (await transactionDoc.get()).data();
      const {
        topUpAmount,
        merchantId,
        storeId,
        processId,
        paymentAmount,
      } = paymentData;

      if (status === "S") {
        if (param1 === "merchant_topup") {
          const merchantDoc = db.collection("merchants").doc(merchantId);
          const merchantData = (await merchantDoc.get()).data();
          const { creditData } = merchantData;
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
          const storeDoc = db.collection("stores").doc(storeId);
          const { paymentGatewayFee } = payment_methods[processId];
          const orderDoc = db.collection("orders").doc(txnid);
          const {
            weekStart,
            weekEnd,
          } = await getCurrentWeeklyPeriodFromTimestamp(timestamp);
          const period = `${weekStart}-${weekEnd}`;
          const merchantInvoiceDoc = db
            .collection("merchants")
            .doc(merchantId)
            .collection("disbursement_periods")
            .doc(period);

          await orderDoc
            .set(
              {
                orderStatus: {
                  unpaid: {
                    status: false,
                  },
                  paid: {
                    status: true,
                    updatedAt: timestamp,
                  },
                },
                paymentLink: null,
                updatedAt: timestamp,
              },
              { merge: true }
            )
            .then(async () => {
              return await merchantInvoiceDoc.set(
                {
                  startDate: await moment(weekStart, "MMDDYYYY").format(
                    "MM-DD-YYYY"
                  ),
                  endDate: await moment(weekEnd, "MMDDYYYY").format(
                    "MM-DD-YYYY"
                  ),
                  onlineBanking: {
                    transactionCount: firestore.FieldValue.increment(1),
                    totalAmount: firestore.FieldValue.increment(paymentAmount),
                    totalPaymentGatewayFees: firestore.FieldValue.increment(
                      paymentGatewayFee
                    ),
                    updatedAt: timestamp,
                  },
                  status: "Pending",
                  updatedAt: timestamp,
                },
                { merge: true }
              );
            })
            .then(async () => {
              const storeData = (await storeDoc.get()).data();
              const fcmTokens = storeData.fcmTokens ? storeData.fcmTokens : [];
              const orderNotifications = [];

              fcmTokens.map((token) => {
                orderNotifications.push({
                  notification: {
                    title: `Congrats! You may now process Order ID: ${txnid}!`,
                    body: `Order ID: ${txnid} is now paid for. Please process the order immediately when possible in order to avoid user dissatisfaction.`,
                  },
                  data: {
                    type: "order_update",
                    txnid,
                  },
                  token,
                });
              });

              return orderNotifications.length > 0 && fcmTokens.length > 0
                ? await admin.messaging().sendAll(orderNotifications)
                : null;
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
                  reason: "Online Payment failure",
                  updatedAt: timestamp,
                },
              },
              updatedAt: timestamp,
            },
            { merge: true }
          );
        }
      }

      transactionDoc.update({
        status,
        refno,
        updatedAt: timestamp,
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
  const { txnid, status, digest, refno, message, param1, param2 } = req.query;
  const secretKey = await getDragonPaySecretKey();
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

exports.checkPayout = async (req, res) => {
  return functions.logger.log(req, res);
};
