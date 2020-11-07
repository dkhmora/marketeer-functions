const request = require("request");
const { db, admin } = require("./util/admin");
const moment = require("moment");
const functions = require("firebase-functions");
require("moment-timezone");

exports.ipAddressTest = async (req, res) => {
  return request.get(
    "https://api.ipify.org?format=json",
    (error, response, body) => {
      functions.logger.log("error:", error); // Print the error if one occurred
      functions.logger.log("statusCode:", response && response.statusCode); // Print the response status code if a response was received
      functions.logger.log("body:", body); //Prints the response of the request.

      res.status(200).send(response);
    }
  );
};

exports.copyCollection = async (req, res) => {
  const {
    srcDocumentName,
    firstSrcCollectionName,
    secondSrcCollectionName,
    destDocumentName,
    firstDestCollectionName,
    secondDestCollectionName,
  } = req.body;

  const documents = await db
    .collection(firstSrcCollectionName)
    .doc(srcDocumentName)
    .collection(secondSrcCollectionName)
    .get();
  let writeBatch = admin.firestore().batch();
  const destCollection = db
    .collection(firstDestCollectionName)
    .doc(destDocumentName)
    .collection(secondDestCollectionName);
  let i = 0;
  for (const doc of documents.docs) {
    writeBatch.set(destCollection.doc(doc.id), doc.data());
    i++;
    if (i > 400) {
      // write batch only allows maximum 500 writes per batch
      i = 0;
      writeBatch = admin.firestore().batch();
      writeBatch.commit();

      functions.logger.log("Intermediate committing of batch operation");
    }
  }
  if (i > 0) {
    functions.logger.log(
      "Firebase batch operation completed. Doing final committing of batch operation."
    );
    await writeBatch.commit();
  } else {
    functions.logger.log("Firebase batch operation completed.");
  }
};

exports.returnOrderPayments = async (req, res) => {
  const { merchantId } = req.body;

  const now = moment();

  const weekStart = now
    .clone()
    .tz("Etc/GMT+8")
    .subtract(1, "weeks")
    .weekday(6)
    .startOf("day")
    .format("x");
  const weekEnd = now
    .clone()
    .tz("Etc/GMT+8")
    .weekday(5)
    .endOf("day")
    .format("x");
  const orderPaymentsList = [];

  functions.logger.log(weekStart, weekEnd);

  return await db
    .collection("order_payments")
    .where("merchantId", "==", merchantId)
    .where("status", "==", "S")
    .where("updatedAt", ">=", Number(weekStart))
    .orderBy("updatedAt", "desc")
    .startAfter(Number(weekEnd))
    .get()
    .then((querySnapshot) => {
      functions.logger.log(querySnapshot.docs);
      return querySnapshot.docs.forEach((documentSnapshot, index) => {
        const orderPayment = documentSnapshot.data();

        functions.logger.log("payment", orderPayment);

        if (orderPayment.updatedAt <= weekEnd) {
          orderPaymentsList.push(orderPayment);
        }
      });
    })
    .then(() => {
      return res.status(200).json({ orderPaymentsList });
    });
};
