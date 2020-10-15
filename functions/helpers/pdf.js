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
  const totalAmountPayable = orderAmount - transactionFee - paymentGatewayFee;

  return [
    formatTableItem(orderDate),
    formatTableItem(orderId),
    formatTableItem(storeName),
    formatTableItem(`₱${orderAmount}`),
    formatTableItem(`₱${transactionFee}`),
    formatTableItem(processId),
    formatTableItem(`₱${paymentGatewayFee}`),
    formatEmphasizedTableItem(`₱${totalAmountPayable}`),
  ];
};

const formattedDragonpayOrders = ({ dragonpayOrders, stores }) => {
  return orders.map((order) => {
    const storeName = stores[order.storeId].name;

    return formattedDragonpayOrder({
      dragonpayOrders,
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
  const totalAmountPayable = subTotal - transactionFee - deliveryDiscount;

  return [
    formatTableItem(orderDate),
    formatTableItem(orderId),
    formatTableItem(storeName),
    formatTableItem(`₱${subTotal}`),
    formatTableItem(`₱${transactionFee}`),
    formatTableItem(`₱${deliveryDiscount ? deliveryDiscount : "0"}`),
    formatEmphasizedTableItem(`₱${totalAmountPayable}`),
  ];
};

const formattedMrspeedyOrders = ({ mrspeedyOrders, stores }) => {
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
  totalAmountPayable,
  totalRevenueShare,
  totalPaymentProcessorFee,
  totalAmount,
  onlineBankingTransactionCount,
  mrspeedyCODTransactionCount,
}) => {
  return new Promise((resolve, reject) => {
    const fileRef = admin.storage().bucket().file(`${filePath}${fileName}`);

    const pdfDoc = printer.createPdfKitDocument(
      disbursementDD({
        invoiceNumber,
        invoiceStatus,
        userName,
        companyName,
        companyAddress,
        dateIssued,
        formattedDragonpayOrders: formattedDragonpayOrders({
          dragonpayOrders,
          stores,
        }),
        formattedMrspeedyOrders: formattedMrspeedyOrders({
          mrspeedyOrders,
          stores,
        }),
        totalAmountPayable,
        totalRevenueShare,
        transactionFeePercentage,
        totalPaymentProcessorFee,
        totalAmount,
        onlineBankingTransactionCount,
        mrspeedyCODTransactionCount,
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
        })
      );
    });

    fileStream.on("error", (err) => {
      functions.logger.error(err);
      reject(err);
    });
  });
};
