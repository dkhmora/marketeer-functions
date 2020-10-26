/* eslint-disable promise/no-nesting */
const functions = require("firebase-functions");
const firebase = require("firebase");
const { FB_CONFIG, DEV_MODE } = require("./util/config");
const app = require("express")();
const adminApp = require("express")();
const mrspeedyApp = require("express")();

const {
  scheduledFirestoreExport,
  generateThumbnail,
} = require("./maintenance_services");
const {
  signInWithPhoneAndPassword,
  sendPasswordResetLinkToStoreUser,
} = require("./authentication");
const {
  getAddressFromCoordinates,
  placeOrder,
  cancelOrder,
  addReview,
  sendMessageNotification,
  createAccountDocument,
} = require("./user_services");
const {
  changeOrderStatus,
  addStoreItem,
  setStoreDeliveryArea,
} = require("./store_services");
const {
  setUserAsMerchant,
  assignStoreToMerchant,
  getUserFromEmail,
  getUserFromUserId,
  editUserStoreRoles,
  createStoreEmployeeAccount,
  setMarketeerAdminToken,
  executeNewDeliveryFormat,
} = require("./admin_services");
const {
  checkPayout,
  checkPayment,
  result,
  getMerchantTopUpPaymentLink,
  getAvailablePaymentProcessors,
} = require("./payments");
const { returnOrderPayments } = require("./miscellaneous");
const { sendDisbursementInvoicePdfs } = require("./pdf_services");
const {
  getMerchantMrSpeedyDeliveryPriceEstimate,
  mrspeedyNotification,
  getMrSpeedyCourierInfo,
  cancelMrSpeedyOrder,
  getUserMrSpeedyDeliveryPriceEstimate,
} = require("./mrspeedy_services");

firebase.initializeApp({
  ...FB_CONFIG,
});

// Functions in Development
if (DEV_MODE) {
  app.post("/returnOrderPayments", returnOrderPayments);

  // Mr. Speedy Services
  exports.getUserMrSpeedyDeliveryPriceEstimate = getUserMrSpeedyDeliveryPriceEstimate;
  exports.getMerchantMrSpeedyDeliveryPriceEstimate = getMerchantMrSpeedyDeliveryPriceEstimate;
  exports.getMrSpeedyCourierInfo = getMrSpeedyCourierInfo;
  exports.cancelMrSpeedyOrder = cancelMrSpeedyOrder;

  // Payout Postback/Callback URLs
  app.post("/payout/checkPayout", checkPayout);

  // Mr. Speedy Callback
  mrspeedyApp.post("/order/update", mrspeedyNotification);

  exports.mrspeedy = functions
    .region("asia-northeast1")
    .https.onRequest(mrspeedyApp);
}

// Dragonpay Services
app.post("/payment/checkPayment", checkPayment);
app.get("/payment/result", result);

exports.getMerchantTopUpPaymentLink = getMerchantTopUpPaymentLink;
exports.getAvailablePaymentProcessors = getAvailablePaymentProcessors;
// ** Dragonpay PRODUCTION **

// API
exports.api = functions.region("asia-northeast1").https.onRequest(app);

// Automated Services
exports.scheduledFirestoreExport = DEV_MODE ? null : scheduledFirestoreExport;
exports.generateThumbnail = generateThumbnail;

// Authentication Services
exports.signInWithPhoneAndPassword = signInWithPhoneAndPassword;
exports.sendPasswordResetLinkToStoreUser = sendPasswordResetLinkToStoreUser;

// Admin Services
exports.setUserAsMerchant = setUserAsMerchant;
exports.assignStoreToMerchant = assignStoreToMerchant;
exports.getUserFromEmail = getUserFromEmail;
exports.getUserFromUserId = getUserFromUserId;
exports.createStoreEmployeeAccount = createStoreEmployeeAccount;
exports.setMarketeerAdminToken = setMarketeerAdminToken;
exports.editUserStoreRoles = editUserStoreRoles;

adminApp.post("/executeNewDeliveryFormat", executeNewDeliveryFormat);

exports.adminApi = functions
  .region("asia-northeast1")
  .https.onRequest(adminApp);

// Merchant Services
exports.sendDisbursementInvoicePdfs = DEV_MODE
  ? null
  : sendDisbursementInvoicePdfs;

// Store Services
exports.changeOrderStatus = changeOrderStatus;
exports.addStoreItem = addStoreItem;
exports.setStoreDeliveryArea = setStoreDeliveryArea;

// User Services
exports.getAddressFromCoordinates = getAddressFromCoordinates;
exports.placeOrder = placeOrder;
exports.cancelOrder = cancelOrder;
exports.addReview = addReview;
exports.sendMessageNotification = sendMessageNotification;
exports.createAccountDocument = createAccountDocument;
