const { db, admin } = require("./util/admin");
const { firestore } = require("firebase-admin");
const moment = require("moment");
const functions = require("firebase-functions");
const { createDisbursementInvoicePdf } = require("./helpers/pdf");
require("moment-timezone");

exports.sendDisbursementInvoicePdfs = functions
  .region("asia-northeast1")
  .pubsub.schedule("0 8 * * 6")
  .onRun(async (context) => {
    const timeStamp = firestore.Timestamp.now().toMillis();
    const now = moment(timeStamp, "x");
    let weekStart = moment(timeStamp, "x")
      .tz("Etc/GMT+8")
      .subtract(1, "weeks")
      .weekday(6)
      .startOf("day")
      .format("x");
    let weekEnd = moment(timeStamp, "x")
      .tz("Etc/GMT+8")
      .weekday(5)
      .endOf("day")
      .format("x");

    if (timeStamp > weekEnd) {
      weekStart = moment(weekStart, "x").add(1, "weeks").format("x");
      weekEnd = moment(weekEnd, "x").add(1, "weeks").format("x");
    }

    const weekStartFormatted = moment(weekStart, "x")
      .weekday(6)
      .startOf("day")
      .format("MMDDYYYY");
    const weekEndFormatted = moment(weekEnd, "x")
      .weekday(5)
      .endOf("day")
      .format("MMDDYYYY");

    return await db
      .collection("merchants")
      .where("generateInvoice", "==", true)
      .get()
      .then(async (querySnapshot) => {
        const merchantIds = [];

        await querySnapshot.docs.forEach((document, index) => {
          merchantIds.push(document.id);
        });

        return merchantIds;
      })
      .then((merchantIds) => {
        return merchantIds.map(async (merchantId) => {
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

          const { creditData, user, company, stores } = merchantData;
          const { companyName, companyAddress } = company;
          const { userName, userEmail } = user;
          const { transactionFeePercentage } = creditData;

          const companyInitials = companyName
            .split(" ")
            .map((i) => i.charAt(0).toUpperCase())
            .join("");

          if (latestDisbursementData) {
            const {
              totalAmount,
              totalPaymentGatewayFees,
              successfulTransactionCount,
            } = latestDisbursementData;

            const invoiceNumber = `${companyInitials}-${merchantId.slice(
              -7
            )}-${weekStartFormatted}${weekEndFormatted}-DI`;
            const invoiceStatus = "PROCESSING PAYMENT";
            const dateIssued = now
              .clone()
              .tz("Etc/GMT+8")
              .format("MMMM DD, YYYY");

            const totalRevenueShare =
              totalAmount * transactionFeePercentage * 0.01;
            const totalAmountPayable =
              totalAmount - totalPaymentGatewayFees - totalRevenueShare;
            const fileName = `${companyName} - ${invoiceNumber}.pdf`;
            const filePath = `merchants/${merchantId}/disbursement_invoices/`;

            // eslint-disable-next-line promise/no-nesting
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
                return await createDisbursementInvoicePdf({
                  fileName,
                  filePath,
                  invoiceNumber,
                  invoiceStatus,
                  userName,
                  userEmail,
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
                  successfulTransactionCount,
                });
              });
          } else {
            functions.logger.info(
              `No disbursement data for ${companyName} in ${weekStartFormatted}-${weekEndFormatted}`
            );
          }
        });
      });
  });
