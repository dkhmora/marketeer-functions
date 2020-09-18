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

const { admin } = require("../util/admin");
const moment = require("moment");
require("moment-timezone");
const PdfPrinter = require("pdfmake");
const printer = new PdfPrinter(fonts);
const disbursementDD = require("../pdf_templates/disbursement");
const { functions } = require("firebase");
const { notifyUserOfOrderConfirmation } = require("./email");

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

const formattedOrder = ({ order, storeName, transactionFeePercentage }) => {
  const {
    paymentGatewayFee,
    updatedAt,
    paymentAmount,
    processId,
    orderId,
  } = order;
  const orderDate = moment(updatedAt, "x").format("MM-DD-YYYY");
  const revenueShare = paymentAmount * transactionFeePercentage * 0.01;
  const totalAmountPayable = paymentAmount - revenueShare - paymentGatewayFee;

  return [
    formatTableItem(orderDate),
    formatTableItem(orderId),
    formatTableItem(storeName),
    formatTableItem(`₱${paymentAmount}`),
    formatTableItem(`₱${revenueShare}`),
    formatTableItem(processId),
    formatTableItem(`₱${paymentGatewayFee}`),
    formatEmphasizedTableItem(`₱${totalAmountPayable}`),
  ];
};

const formattedOrders = ({ orders, stores, transactionFeePercentage }) => {
  return orders.map((order) => {
    const storeName = stores[order.storeId].name;

    return formattedOrder({ order, storeName, transactionFeePercentage });
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
  orders,
  stores,
  transactionFeePercentage,
  totalAmountPayable,
  totalRevenueShare,
  totalPaymentProcessorFee,
  totalAmount,
  successfulTransactionCount,
}) => {
  return new Promise((resolve, reject) => {
    const fileRef = admin.storage().bucket().file(`${filePath}/${fileName}`);

    const pdfDoc = printer.createPdfKitDocument(
      disbursementDD({
        invoiceNumber,
        invoiceStatus,
        userName,
        companyName,
        companyAddress,
        dateIssued,
        formattedOrders: formattedOrders({
          orders,
          stores,
          transactionFeePercentage,
        }),
        totalAmountPayable,
        totalRevenueShare,
        transactionFeePercentage,
        totalPaymentProcessorFee,
        totalAmount,
        successfulTransactionCount,
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
      reject(err);
    });
  });
};
