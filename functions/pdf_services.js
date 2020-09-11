const { db, admin } = require("./util/admin");
const { firestore } = require("firebase-admin");
const moment = require("moment");
const functions = require("firebase-functions");
const { createDisbursementInvoicePdf } = require("./helpers/pdf");
require("moment-timezone");

exports.createPdf = async (req, res) => {
  const { merchantId } = req.body;

  const timeStamp = firestore.Timestamp.now().toMillis();

  const now = moment(timeStamp, "x");

  const weekStart = moment(timeStamp, "x")
    .tz("Etc/GMT+8")
    .subtract(1, "weeks")
    .weekday(6)
    .startOf("day")
    .format("x");
  const weekEnd = moment(timeStamp, "x")
    .tz("Etc/GMT+8")
    .weekday(5)
    .endOf("day")
    .format("x");
  const weekStartFormatted = moment(timeStamp, "x")
    .tz("Etc/GMT+8")
    .subtract(1, "weeks")
    .weekday(6)
    .startOf("day")
    .format("MMDDYYYY");
  const weekEndFormatted = moment(timeStamp, "x")
    .tz("Etc/GMT+8")
    .weekday(5)
    .endOf("day")
    .format("MMDDYYYY");

  functions.logger.log(
    weekStart,
    weekStartFormatted,
    weekEnd,
    weekEndFormatted,
    `${weekStartFormatted}-${weekEndFormatted}`
  );

  const merchantData = (
    await db.collection("merchants").doc(merchantId).get()
  ).data();
  const latestDisbursementData = (
    await db
      .collection("merchants")
      .doc(merchantId)
      .collection("disbursement_periods")
      .doc(`${weekStartFormatted}-${weekEndFormatted}`)
      .get()
  ).data();
  functions.logger.log(merchantData, latestDisbursementData);

  const { creditData, user, company, stores } = merchantData;
  const {
    totalAmount,
    totalPaymentGatewayFees,
    successfulTransactionCount,
  } = latestDisbursementData;
  const { transactionFeePercentage } = creditData;
  const { companyName, companyAddress } = company;
  const { userName } = user;
  const companyInitials = companyName
    .split(" ")
    .map((i) => i.charAt(0).toUpperCase())
    .join("");

  const invoiceNumber = `${companyInitials}-${merchantId.slice(
    -7
  )}-${weekStartFormatted}${weekEndFormatted}-DI`;
  const invoiceStatus = "PROCESSING PAYMENT";
  const dateIssued = now.clone().tz("Etc/GMT+8").format("MMMM DD, YYYY");

  const totalRevenueShare = totalAmount * transactionFeePercentage * 0.01;
  const totalAmountPayable =
    totalAmount - totalPaymentGatewayFees - totalRevenueShare;
  const fileName = `${companyName} - ${invoiceNumber}`;

  return await db
    .collection("order_payments")
    .where("merchantId", "==", merchantId)
    .where("status", "==", "S")
    .where("updatedAt", ">=", Number(weekStart))
    .orderBy("updatedAt", "desc")
    .startAfter(Number(weekEnd))
    .get()
    .then(async (querySnapshot) => {
      const orders = [];

      await querySnapshot.docs.forEach((documentSnapshot, index) => {
        const orderPayment = {
          ...documentSnapshot.data(),
          orderId: documentSnapshot.id,
        };

        if (orderPayment.updatedAt <= weekEnd) {
          orders.push(orderPayment);
        }
      });

      return orders.sort((a, b) => a.updatedAt - b.updatedAt);
    })
    .then(async (orders) => {
      await createDisbursementInvoicePdf({
        fileName,
        invoiceNumber,
        invoiceStatus,
        userName,
        companyName,
        companyAddress,
        dateIssued,
        orders,
        stores,
        transactionFeePercentage,
        totalAmountPayable,
        totalRevenueShare,
        totalPaymentProcessorFee: totalPaymentGatewayFees,
        totalAmount,
      });

      return res.status(200).json({ orders });
    });
};
