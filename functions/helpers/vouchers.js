const functions = require("firebase-functions");
const { db } = require("../util/admin");

async function getVoucherOrderDiscount(voucherId, subTotal) {
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

module.exports = {
  getVoucherOrderDiscount,
};
