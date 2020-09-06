const firebase = require("firebase");
const functions = require("firebase-functions");
const { db, admin } = require("./util/admin");

exports.signInWithPhoneAndPassword = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const phoneNumber = data.phone;
    if (phoneNumber === undefined) {
      return { s: 400, m: "Bad argument: no phone number" };
    }

    try {
      const user = await admin.auth().getUserByPhoneNumber(phoneNumber);

      functions.logger.log(user, data);
      const pass = data.password;

      await firebase.auth().signInWithEmailAndPassword(user.email, pass);

      const token = await admin
        .auth()
        .createCustomToken(user.uid, { devClaim: true });

      return { s: 200, t: token };
    } catch (e) {
      return { s: 400, m: "Wrong phone number or password. Please try again." };
    }
  });

exports.sendPasswordResetLinkToStoreUser = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { email, storeId } = data;

    try {
      if (email === undefined) {
        return { s: 400, m: "Bad argument: no phone number" };
      }

      const user = await admin.auth().getUserByEmail(email);

      if (!user) {
        return { s: 400, m: "Bad argument: Email could not be found" };
      }

      if (!user.customClaims.storeIds) {
        return {
          s: 400,
          m: "Bad argument: Email is not assigned to any store",
        };
      }

      await firebase.auth().sendPasswordResetEmail(email);
    } catch (e) {
      return { s: 400, m: "Error, something went wrong" };
    }

    return { s: 200, m: `Password reset link successfully sent to ${email}!` };
  });
