const { db, admin } = require("./util/admin");
const { firestore } = require("firebase-admin");
const moment = require("moment");
const functions = require("firebase-functions");
const { createDisbursementInvoicePdf } = require("./helpers/pdf");
require("moment-timezone");

exports.sendDisbursementInvoicePdfs = functions
  .region("asia-northeast1")
  .pubsub.schedule("0 8 * * 6")
  .timeZone("Asia/Manila")
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
      .then(async (merchantIds) => {
        return await Promise.all(
          merchantIds.map(async (merchantId) => {
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
                  const dragonpayOrders = [];

                  await querySnapshot.docs.forEach(
                    (documentSnapshot, index) => {
                      const orderPayment = {
                        ...documentSnapshot.data(),
                        orderId: documentSnapshot.id,
                      };

                      if (orderPayment.updatedAt <= weekEnd) {
                        dragonpayOrders.push(orderPayment);
                      }
                    }
                  );

                  return {
                    dragonpayOrders: dragonpayOrders.sort(
                      (a, b) => a.updatedAt - b.updatedAt
                    ),
                  };
                })
                .then(async ({ dragonpayOrders }) => {
                  // eslint-disable-next-line promise/no-nesting
                  return await db
                    .collection("orders")
                    .where("merchantId", "==", merchantId)
                    .where("status", "==", "S")
                    .where("updatedAt", ">=", Number(weekStart))
                    .orderBy("updatedAt", "desc")
                    .startAfter(Number(weekEnd))
                    .get()
                    .then(async (querySnapshot) => {
                      const mrspeedyOrders = [];

                      await querySnapshot.docs.forEach(
                        (documentSnapshot, index) => {
                          const mrspeedyOrder = {
                            ...documentSnapshot.data(),
                            orderId: documentSnapshot.id,
                          };

                          if (orderPayment.updatedAt <= weekEnd) {
                            mrspeedyOrders.push(mrspeedyOrder);
                          }
                        }
                      );

                      return {
                        dragonpayOrders,
                        mrspeedyOrders: mrspeedyOrders.sort(
                          (a, b) => a.updatedAt - b.updatedAt
                        ),
                      };
                    })
                    .then(async ({ dragonpayOrders, mrspeedyOrders }) => {
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
                        dragonpayOrders,
                        mrspeedyOrders,
                        stores,
                        transactionFeePercentage,
                        totalAmountPayable,
                        totalRevenueShare,
                        totalPaymentProcessorFee: totalPaymentGatewayFees,
                        totalAmount,
                        successfulTransactionCount,
                      });
                    });
                });
            } else {
              functions.logger.info(
                `No disbursement data for ${companyName} in ${weekStartFormatted}-${weekEndFormatted}`
              );
            }
          })
        );
      });
  });
