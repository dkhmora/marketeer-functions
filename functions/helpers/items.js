const functions = require("firebase-functions");

const getTotalItemOptionsPrice = (item, itemSnapshot) => {
  const { selectedOptions } = item;
  let totalOptionsPrice = 0;

  if (selectedOptions) {
    Object.entries(selectedOptions).map(([optionTitle, optionData]) => {
      Object.entries(optionData).map(([selectionTitle, selectionPrice]) => {
        const option = itemSnapshot.options[optionTitle];

        if (option && option.selection) {
          const optionSnapshot = option.selection.find(
            (item) => item.title === selectionTitle
          );
          if (optionSnapshot !== undefined) {
            const optionPrice = optionSnapshot.price;

            if (selectionPrice !== optionPrice) {
              throw new Error("Option prices have changed. Please try again");
            }

            totalOptionsPrice += optionPrice;
          }
        }
      });
    });
  }

  return totalOptionsPrice;
};

const processStoreItems = async (cartItems, storeItemsSnapshot, storeName) => {
  return new Promise((res, rej) => {
    let newStoreItems = [...storeItemsSnapshot];
    let quantity = 0;
    let subTotal = 0;

    cartItems.map((cartItem) => {
      const storeItemIndex = newStoreItems.findIndex(
        (storeItem) => storeItem.itemId === cartItem.itemId
      );
      const storeItem = newStoreItems[storeItemIndex];
      const optionsPrice = getTotalItemOptionsPrice(cartItem, storeItem);
      const itemPrice = cartItem.discountedPrice
        ? cartItem.discountedPrice
        : cartItem.price;
      const totalItemPrice = itemPrice + optionsPrice;

      quantity += cartItem.quantity;
      subTotal += totalItemPrice * cartItem.quantity;
      storeItem.sales += cartItem.quantity;

      if (
        storeItem.price !== cartItem.price ||
        storeItem.discountedPrice !== cartItem.discountedPrice
      ) {
        rej(
          new Error(
            `Price for "${cartItem.name}" from "${storeName} has changed. Please try ordering again.`
          )
        );
      }

      if (storeItem.stock) {
        storeItem.stock -= cartItem.quantity;

        if (storeItem.stock < 0) {
          rej(
            new Error(
              `Not enough stocks for item "${cartItem.name}" from "${storeName}. Please update your cart."`
            )
          );
        }
      }
    });

    res({ quantity, subTotal, newStoreItems });
  });
};

module.exports = {
  getTotalItemOptionsPrice,
  processStoreItems,
};
