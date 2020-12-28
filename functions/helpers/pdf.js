const { admin } = require("../util/admin");
const moment = require("moment");
require("moment-timezone");
const PdfPrinter = require("pdfmake");
const disbursementDD = require("../pdf_templates/disbursement");
const functions = require("firebase-functions");
const { notifyUserOfOrderConfirmation } = require("./email");

const fonts = {
  Courier: {
    normal: "Courier",
    bold: "Courier-Bold",
    italics: "Courier-Oblique",
    bolditalics: "Courier-BoldOblique",
  },
  Helvetica: {
    normal: "Helvetica",
    bold: "Helvetica-Bold",
    italics: "Helvetica-Oblique",
    bolditalics: "Helvetica-BoldOblique",
  },
  Times: {
    normal: "Times-Roman",
    bold: "Times-Bold",
    italics: "Times-Italic",
    bolditalics: "Times-BoldItalic",
  },
  Symbol: {
    normal: "Symbol",
  },
  ZapfDingbats: {
    normal: "ZapfDingbats",
  },
  Roboto: {
    normal: "fonts/Roboto-Regular.ttf",
    bold: "fonts/Roboto-Medium.ttf",
    italics: "fonts/Roboto-Italic.ttf",
    bolditalics: "fonts/Roboto-MediumItalic.ttf",
  },
};

const formatTableItem = (text) => {
  return {
    text,
    fontSize: 10,
    border: [false, false, false, true],
    margin: [0, 5, 0, 5],
    alignment: "left",
  };
};

const formatEmphasizedTableItem = (text) => {
  return {
    text,
    fontSize: 10,
    fillColor: "#f5f5f5",
    alignment: "right",
    border: [false, false, false, true],
    margin: [0, 5, 0, 5],
  };
};

const formatBoldEmphasizedTableItem = (text) => {
  return {
    text,
    bold: true,
    fontSize: 12,
    alignment: "right",
    border: [false, false, false, true],
    fillColor: "#f5f5f5",
    margin: [0, 5, 0, 5],
  };
};

const printer = new PdfPrinter(fonts);

let onlineBankingTotalAmountPayable = 0;
let mrspeedyTotalAmountPayable = 0;
let onlineBankingTotalRevenueShare = 0;
let mrspeedyTotalRevenueShare = 0;
let onlineBankingTotalPurchaseAmount = 0;

const formattedDragonpayOrder = ({ order, storeName }) => {
  const {
    paymentGatewayFee,
    updatedAt,
    paymentAmount,
    deliveryMethod,
    deliveryPrice,
    subTotal,
    processId,
    orderId,
    transactionFee,
  } = order;
  const orderDate = moment(updatedAt, "x").format("MM-DD-YYYY");
  const orderAmount =
    deliveryMethod === "Own Delivery" ? subTotal + deliveryPrice : subTotal;
  const amountPayable = orderAmount - transactionFee - paymentGatewayFee;
  onlineBankingTotalPurchaseAmount += orderAmount;
  onlineBankingTotalAmountPayable += amountPayable;
  onlineBankingTotalRevenueShare += transactionFee;

  return [
    formatTableItem(orderDate),
    formatTableItem(orderId),
    formatTableItem(storeName),
    formatTableItem(`₱${orderAmount}`),
    formatTableItem(`₱${transactionFee}`),
    formatTableItem(processId),
    formatTableItem(`₱${paymentGatewayFee}`),
    formatEmphasizedTableItem(`₱${amountPayable}`),
  ];
};

const getFormattedDragonpayOrders = ({ dragonpayOrders, stores }) => {
  return dragonpayOrders.map((order) => {
    const storeName = stores[order.storeId].name;

    return formattedDragonpayOrder({
      order,
      storeName,
    });
  });
};

const formattedMrspeedyOrder = ({ order, storeName }) => {
  const {
    updatedAt,
    subTotal,
    orderId,
    deliveryDiscount,
    transactionFee,
  } = order;
  const orderDate = moment(updatedAt, "x").format("MM-DD-YYYY");
  const amountPayable = subTotal - transactionFee - deliveryDiscount;
  mrspeedyTotalAmountPayable += amountPayable;
  mrspeedyTotalRevenueShare += transactionFee;

  return [
    formatTableItem(orderDate),
    formatTableItem(orderId),
    formatTableItem(storeName),
    formatTableItem(`₱${subTotal}`),
    formatTableItem(`₱${transactionFee}`),
    formatTableItem(`₱${deliveryDiscount ? deliveryDiscount : "0"}`),
    formatEmphasizedTableItem(`₱${amountPayable}`),
  ];
};

const getFormattedMrspeedyOrders = ({ mrspeedyOrders, stores }) => {
  return mrspeedyOrders.map((order) => {
    const storeName = stores[order.storeId].name;

    return formattedMrspeedyOrder({
      order,
      storeName,
    });
  });
};

exports.createDisbursementInvoicePdf = ({
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
  mrspeedy,
  onlineBanking,
  additionalEmailText,
}) => {
  return new Promise((resolve, reject) => {
    const fileRef = admin.storage().bucket().file(`${filePath}${fileName}`);
    const formattedDragonpayOrders = getFormattedDragonpayOrders({
      dragonpayOrders,
      stores,
    });
    const formattedMrspeedyOrders = getFormattedMrspeedyOrders({
      mrspeedyOrders,
      stores,
    });

    const pdfDoc = printer.createPdfKitDocument(
      disbursementDD({
        invoiceNumber,
        invoiceStatus,
        userName,
        companyName,
        companyAddress,
        dateIssued,
        transactionFeePercentage,
        totalAmountPayable:
          mrspeedyTotalAmountPayable + onlineBankingTotalAmountPayable,
        totalRevenueShare:
          mrspeedyTotalRevenueShare + onlineBankingTotalRevenueShare,
        onlineBanking,
        onlineBankingTotalRevenueShare,
        onlineBankingTotalAmountPayable,
        onlineBankingTotalPurchaseAmount,
        formattedDragonpayOrders,
        mrspeedy,
        mrspeedyTotalRevenueShare,
        mrspeedyTotalAmountPayable,
        formattedMrspeedyOrders,
      })
    );
    const fileStream = fileRef.createWriteStream();

    pdfDoc.pipe(fileStream);
    pdfDoc.end();

    fileStream.on("finish", () => {
      resolve(
        notifyUserOfOrderConfirmation({
          filePath,
          fileName,
          userEmail,
          userName,
          dateIssued,
          additionalEmailText,
        })
      );
    });

    fileStream.on("error", (err) => {
      functions.logger.error(err);
      reject(err);
    });
  });
};
