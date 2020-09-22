const functions = require("firebase-functions");
const { firestore } = require("firebase-admin");
const { db, admin } = require("./util/admin");

exports.editUserStoreRoles = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { roles, userId, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId || !roles || !storeId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    let newStoreIds = { [storeId]: roles };
    /*
    const previousUserCustomClaims = (await admin.auth().getUser(userId))
      .customClaims;

    if (previousUserCustomClaims.storeIds) {
      newStoreIds = {
        ...previousUserCustomClaims.storeIds,
        [storeId]: roles,
      };
    }*/

    return await admin
      .auth()
      .setCustomUserClaims(userId, {
        storeIds: {
          ...newStoreIds,
        },
      })
      .then(async () => {
        await db
          .collection("stores")
          .doc(storeId)
          .update({
            [`users.${userId}`]: roles,
          });

        return {
          s: 200,
          m: `Successfully added roles (${roles.map((role, index) => {
            return `${role}${roles.length - 1 !== index ? ", " : ""}`;
          })}) for ${storeId} to ${userId}!`,
        };
      });
  });

exports.setUserAsMerchant = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const {
      userId,
      storeId,
      companyName,
      companyAddress,
      creditThreshold,
      credits,
      transactionFeePercentage,
      userBirthdate,
      userEmail,
      userName,
      userPhone,
      generateInvoice,
    } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    const previousUserCustomClaims = (await admin.auth().getUser(userId))
      .customClaims;

    return await admin
      .auth()
      .setCustomUserClaims(userId, {
        ...previousUserCustomClaims,
        role: "merchant",
      })
      .then(async () => {
        // eslint-disable-next-line promise/no-nesting
        await db
          .collection("merchants")
          .doc(userId)
          .get()
          .then(async (document) => {
            if (!document.exists) {
              const { storeName, storeCategory } = (
                await db.collection("stores").doc(storeId).get()
              ).data();

              return document.ref.set({
                company: {
                  companyName,
                  companyAddress,
                },
                creditData: {
                  creditThreshold,
                  credits,
                  transactionFeePercentage,
                },
                generateInvoice,
                stores:
                  storeName && storeCategory
                    ? {
                        name: storeName,
                        category: storeCategory,
                      }
                    : {},
                user: {
                  userBirthdate,
                  userEmail,
                  userName,
                  userPhone,
                },
              });
            }

            return null;
          });

        return {
          s: 200,
          m: `Successfully added "merchant" role to ${userId}!`,
        };
      });
  });

exports.assignStoreToMerchant = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { userId, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId || !storeId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    const userCustomClaims = (await admin.auth().getUser(userId)).customClaims;

    if (userCustomClaims.role !== "merchant") {
      return {
        s: 400,
        m:
          "Error: User is not set as a merchant. Please assign the user a merchant role first in order to assign a store to the user.",
      };
    }

    return await db
      .collection("merchants")
      .doc(userId)
      .update({
        stores: firestore.FieldValue.arrayUnion(storeId),
      })
      .then(() => {
        return {
          s: 200,
          m: `Successfully assigned store ID "${storeId}" to ${userId}!`,
        };
      });
  });

exports.getUserFromEmail = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { email } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!email) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    return admin.auth().getUserByEmail(email);
  });

exports.getUserFromUserId = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { userIds } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userIds) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    return admin.auth().getUsers(userIds);
  });

exports.createStoreEmployeeAccount = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { email, password, role, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    try {
      return admin
        .auth()
        .getUserByEmail(email)
        .then(async (user) => {
          return {
            s: 400,
            m: `Error: User with email "${email}" already exists.`,
          };
        })
        .catch((error) => {
          if (error.code === "auth/user-not-found") {
            return admin
              .auth()
              .createUser({
                email,
                password,
              })
              .then(async (user) => {
                const userId = user.uid;
                const storeIds = { [storeId]: role };

                return await admin
                  .auth()
                  .setCustomUserClaims(userId, {
                    storeIds,
                  })
                  .then(async () => {
                    await db
                      .collection("stores")
                      .doc(storeId)
                      .update({
                        [`users.${role}.${userId}`]: true,
                      });

                    return {
                      s: 200,
                      m: `Successfully added ${storeId} token to ${userId}`,
                    };
                  });
              });
          }

          return { s: 400, m: error };
        });
    } catch (error) {
      return { s: 400, m: error };
    }
  });

exports.setMarketeerAdminToken = functions
  .region("asia-northeast1")
  .firestore.document("marketeer_admins/userIds")
  .onWrite(async (change, context) => {
    const newData = change.after.exists ? change.after.data() : null;
    const previousData = change.before.exists ? change.before.data() : null;
    const newDataLength = newData ? Object.keys(newData).length : 0;
    const previousDataLength = previousData
      ? Object.keys(previousData).length
      : 0;

    const role = "marketeer-admin";

    if (newDataLength >= previousDataLength) {
      Object.entries(newData).map(async ([userId, value]) => {
        if (value === false) {
          const previousUserCustomClaims = (await admin.auth().getUser(userId))
            .customClaims;

          functions.logger.log(
            `previousUserCustomClaims of ${userId}: ${previousUserCustomClaims}`
          );

          return await admin
            .auth()
            .setCustomUserClaims(userId, { role })
            .then(async () => {
              const newUserCustomClaims = (await admin.auth().getUser(userId))
                .customClaims;

              functions.logger.log(
                `newUserCustomClaims of ${userId}: ${newUserCustomClaims}`
              );

              await db
                .collection("marketeer_admins")
                .doc("userIds")
                .update({
                  [userId]: true,
                })
                .catch((err) => {
                  return functions.logger.error(err);
                });

              return functions.logger.log(
                `Added marketeer-admin token to ${userId}`
              );
            })
            .catch((err) => {
              return functions.logger.error(err);
            });
        } else {
          functions.logger.log(`${userId} already set`);
        }
      });
    } else if (newDataLength < previousDataLength) {
      Object.entries(previousData).map(async ([userId, value]) => {
        if (!Object.keys(newData).includes(userId)) {
          return await admin
            .auth()
            .setCustomUserClaims(userId, null)
            .then(() => {
              return functions.logger.log(
                `Removed marketeer-admin token from ${userId}`
              );
            })
            .catch((err) => {
              return functions.logger.error(err);
            });
        }
      });
    } else {
      functions.logger.log("No user IDs");
    }
  });

exports.editUserStoreRoles = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    const { roles, userId, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId || !roles || !storeId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    let newStoreIds = { [storeId]: roles };
    /*
    const previousUserCustomClaims = (await admin.auth().getUser(userId))
      .customClaims;

    if (previousUserCustomClaims.storeIds) {
      newStoreIds = {
        ...previousUserCustomClaims.storeIds,
        [storeId]: roles,
      };
    }*/

    return await admin
      .auth()
      .setCustomUserClaims(userId, {
        storeIds: {
          ...newStoreIds,
        },
      })
      .then(async () => {
        await db
          .collection("stores")
          .doc(storeId)
          .update({
            [`users.${userId}`]: roles,
          });

        return {
          s: 200,
          m: `Successfully added roles (${roles.map((role, index) => {
            return `${role}${roles.length - 1 !== index ? ", " : ""}`;
          })}) for ${storeId} to ${userId}!`,
        };
      });
  });
