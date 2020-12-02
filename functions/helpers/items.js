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

module.exports = {
  getTotalItemOptionsPrice,
};
