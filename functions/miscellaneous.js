const request = require("request");
const { db, admin } = require("./util/admin");

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
