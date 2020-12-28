const functions = require("firebase-functions");
const { firestore } = require("firebase-admin");
const { db, admin } = require("./util/admin");
const { getCurrentTimestamp } = require("./helpers/time");
const { functionsRegionHttps } = require("./util/config");
const moment = require("moment");
const { createDisbursementInvoicePdf } = require("./helpers/pdf");
require("moment-timezone");

exports.forceSendDisbursementInvoicePdfs = async (req, res) => {
  const {
    headers,
    body: { weekStartFormatted, weekEndFormatted, additionalEmailText },
  } = req;

  if (headers.pass !== "tA7#$WC#fiT&") {
    throw new Error("Error: Password mismatch");
  }

  const timeStamp = firestore.Timestamp.now().toMillis();
  const now = moment(timeStamp, "x");
  const weekStart = moment(weekStartFormatted, "MMDDYYYY")
    .tz("Etc/GMT+8")
    .subtract(1, "weeks")
    .weekday(6)
    .startOf("day")
    .format("x");
  const weekEnd = moment(weekEndFormatted, "MMDDYYYY")
    .tz("Etc/GMT+8")
    .weekday(5)
    .endOf("day")
    .format("x");

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
            const { onlineBanking, mrspeedy } = latestDisbursementData;
            const invoiceNumber = `${companyInitials}-${merchantId.slice(
              -7
            )}-${weekStartFormatted}${weekEndFormatted}-DI`;
            const invoiceStatus = "PROCESSING PAYMENT";
            const dateIssued = now
              .clone()
              .tz("Etc/GMT+8")
              .format("MMMM DD, YYYY");
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

                await querySnapshot.docs.forEach((documentSnapshot, index) => {
                  const orderPayment = {
                    ...documentSnapshot.data(),
                    orderId: documentSnapshot.id,
                  };

                  if (orderPayment.updatedAt <= weekEnd) {
                    dragonpayOrders.push(orderPayment);
                  }
                });

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
                  .where("mrspeedyBookingData.order.status", "==", "completed")
                  .where("paymentMethod", "==", "COD")
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

                        if (mrspeedyOrder.updatedAt <= weekEnd) {
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
                      mrspeedy,
                      onlineBanking,
                      additionalEmailText,
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
};

exports.merchantFormatConvert = async (req, res) => {
  const { headers, body } = req;

  try {
    if (headers.pass !== "tA7#$WC#fiT&") {
      throw new Error("Error: Password mismatch");
    }

    const { storeId, itemDoc } = body;

    functions.logger.log(body);

    return await db
      .collection("stores")
      .doc(storeId)
      .collection("items")
      .doc(itemDoc)
      .get()
      .then((document) => {
        const documentData = document.data();
        const items = documentData.items;

        const newItems = items.map((item, index) => {
          if (item.image) {
            functions.logger.log(
              item.image,
              item.image.replace("merchants", "stores")
            );
          }

          const newItem = {
            ...item,
            image: item.image
              ? item.image.replace("merchants", "stores")
              : null,
          };

          return newItem;
        });

        return newItems;
      })
      .then((newItems) => {
        return db
          .collection("stores")
          .doc(storeId)
          .collection("items")
          .doc(itemDoc)
          .set({ items: newItems }, { merge: true });
      });
  } catch (e) {
    functions.logger.error(e);
    res.status(500).json({ m: e });
  }
};

exports.executeNewDeliveryFormat = async (req, res) => {
  const { headers, body } = req;

  try {
    if (headers.pass !== "tA7#$WC#fiT&") {
      throw new Error("Error: Password mismatch");
    }

    return await db
      .collection("stores")
      .get()
      .then(async (querySnapshot) => {
        const stores = {};

        await querySnapshot.docs.forEach((document, index) => {
          stores[document.id] = document.data();
        });

        return stores;
      })
      .then((stores) => {
        return Object.entries(stores).map(async ([storeId, storeData]) => {
          const {
            deliveryMethods,
            paymentMethods,
            ownDeliveryServiceFee,
          } = storeData;
          const newData = JSON.parse(JSON.stringify(storeData));
          newData.availableDeliveryMethods = {
            ["Own Delivery"]: {
              activated: false,
              deliveryPrice: ownDeliveryServiceFee
                ? ownDeliveryServiceFee
                : null,
            },
            ["Mr. Speedy"]: { activated: false },
          };
          newData.availablePaymentMethods = {
            ["COD"]: { activated: false },
            ["Online Banking"]: { activated: false },
          };
          newData.deliveryDiscount = {
            activated: false,
            discountAmount: null,
            minimumOrderAmount: null,
          };

          if (deliveryMethods) {
            await deliveryMethods.map((deliveryMethod, index) => {
              if (newData.availableDeliveryMethods[deliveryMethod]) {
                newData.availableDeliveryMethods[
                  deliveryMethod
                ].activated = true;
              }
            });
          }

          if (paymentMethods) {
            await paymentMethods.map((paymentMethod, index) => {
              if (newData.availablePaymentMethods[paymentMethod]) {
                newData.availablePaymentMethods[paymentMethod].activated = true;
              }
            });
          }

          return db
            .collection("stores")
            .doc(storeId)
            .set(
              {
                ...newData,
                updatedAt: await getCurrentTimestamp(),
              },
              { merge: true }
            );
        });
      });
  } catch (e) {
    functions.logger.error(e);
    res.status(500).json({ m: e });
  }
};

exports.executePayout = functionsRegionHttps.onCall(async (data, context) => {
  const { disbursementDateRange } = data;

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
    });
});

exports.editUserStoreRoles = functionsRegionHttps.onCall(
  async (data, context) => {
    const { roles, userId, storeId } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userId || !roles || !storeId) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    let newStoreIds = { [storeId]: roles };

    // User only manages one store
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
  }
);

exports.setUserAsMerchant = functionsRegionHttps.onCall(
  async (data, context) => {
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
        const storeRef = db.collection("stores").doc(storeId);
        // eslint-disable-next-line promise/no-nesting
        return await db
          .collection("merchants")
          .doc(userId)
          .get()
          .then(async (document) => {
            if (!document.exists) {
              const { storeName, storeCategory, merchantId } = (
                await storeRef.get()
              ).data();

              if (merchantId) {
                return {
                  s: 500,
                  m: `Error: ${storeId} already has an existing merchantId set!`,
                };
              }

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
                  storeName && storeCategory && storeId
                    ? {
                        [storeId]: {
                          name: storeName,
                          category: storeCategory,
                        },
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
          })
          .then((res) => {
            if (res.s === 500) {
              return res;
            }

            return storeRef.update({
              merchantId: userId,
            });
          })
          .then((res) => {
            if (res.s === 500) {
              return res;
            }

            return {
              s: 200,
              m: `Successfully added "merchant" role to ${userId}!`,
            };
          });
      });
  }
);

exports.assignStoreToMerchant = functionsRegionHttps.onCall(
  async (data, context) => {
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
  }
);

exports.getUserFromEmail = functionsRegionHttps.onCall(
  async (data, context) => {
    const { email } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!email) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    return admin.auth().getUserByEmail(email);
  }
);

exports.getUserFromUserId = functionsRegionHttps.onCall(
  async (data, context) => {
    const { userIds } = data;

    if (context.auth.token.role !== "marketeer-admin") {
      return { s: 400, m: "Error: User is not authorized for this action" };
    }

    if (!userIds) {
      return { s: 400, m: "Error: Incomplete data provided" };
    }

    return admin.auth().getUsers(userIds);
  }
);

exports.createStoreEmployeeAccount = functionsRegionHttps.onCall(
  async (data, context) => {
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
  }
);

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

exports.editUserStoreRoles = functionsRegionHttps.onCall(
  async (data, context) => {
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
  }
);
