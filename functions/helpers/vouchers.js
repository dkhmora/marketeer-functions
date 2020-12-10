const functions = require("firebase-functions");
const { db } = require("../util/admin");

async function getVoucherOrderDiscount(voucherId, subTotal) {
  if (voucherId && voucherId !== undefined) {
    const clientConfigRef = db.collection("application").doc("client_config");
    const clientConfigData = (await clientConfigRef.get()).data();
    const voucherData = clientConfigData?.vouchers?.[voucherId];

    if (!voucherData) {
      throw new Error("Voucher does not exist");
    }

    if (voucherData?.discount?.percentage !== undefined) {
      const orderDiscount = voucherData.discount.percentage * subTotal;

      return Math.min(voucherData?.discount?.maxAmount || 0, orderDiscount);
    }

    return voucherData?.discount?.amount;
  }
}

async function getVoucherDetails(voucherId, subTotal) {
  if (voucherId && voucherId !== undefined) {
    console.log("hgaha", voucherId);
    const clientConfigRef = db.collection("application").doc("client_config");
    const clientConfigData = (await clientConfigRef.get()).data();
    const voucherData = clientConfigData?.vouchers?.[voucherId];

    if (!voucherData) {
      throw new Error("Voucher does not exist");
    }

    return { ...voucherData };
  }
}

async function getAppliedVoucherDetails(
  vouchersApplied,
  subTotal,
  claimedVouchers
) {
  let appliedVoucherDetails = { delivery: null, order: null };

  if (vouchersApplied !== undefined) {
    return Promise.all(
      Object.entries(vouchersApplied).map(async ([voucherType, voucherId]) => {
        const voucherData = await getVoucherDetails(voucherId);
        if (voucherData) {
          const { type, minimumOrderAmount, title, maxUses } = voucherData;

          const claimedVoucherRemainingUses = claimedVouchers[voucherId];
          const usageNumber = maxUses - claimedVoucherRemainingUses + 1;

          if (claimedVoucherRemainingUses === undefined) {
            throw new Error(
              `Error: User has not claimed the applied voucher ${title}`
            );
          }

          if (claimedVoucherRemainingUses <= 0) {
            throw new Error(
              `Error: Voucher ${title} has reached maximum usage for this user`
            );
          }

          if (minimumOrderAmount > subTotal) {
            throw new Error(
              `Error: Voucher ${title} has not reached the minimum order amount`
            );
          }

          if (
            (voucherType === "delivery" && type !== "delivery_discount") ||
            (voucherType === "order" && type !== "order_discount")
          ) {
            throw new Error(`Error: Voucher ${title} is not supported`);
          }

          appliedVoucherDetails[voucherType] = {
            ...voucherData,
            usageNumber,
            voucherId,
          };
        }
      })
    ).then(() => {
      return appliedVoucherDetails;
    });
  }

  return null;
}

module.exports = {
  getVoucherOrderDiscount,
  getVoucherDetails,
  getAppliedVoucherDetails,
};
