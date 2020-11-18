const functions = require("firebase-functions");

const getTotalItemOptionsPrice = (item, itemSnapshot) => {
  const { selectedOptions } = item;
  let totalOptionsPrice = 0;

  functions.logger.log(
    "itemSnapshot.options, selectedOptions",
    itemSnapshot.options,
    selectedOptions
  );

  if (selectedOptions) {
    Object.entries(selectedOptions).map(([optionTitle, optionData]) => {
      functions.logger.log("optionTitle, optionData", optionTitle, optionData);
      Object.entries(optionData).map(([selectionTitle, selectionPrice]) => {
        functions.logger.log(
          "selectionTitle, selectionPrice",
          selectionTitle,
          selectionPrice
        );

        const option = itemSnapshot.options[optionTitle];
        functions.logger.log("option", option);

        if (option && option.selection) {
          const optionSnapshot = option.selection.find(
            (item) => item.title === selectionTitle
          );
          if (optionSnapshot !== undefined) {
            const optionPrice = optionSnapshot.price;

            if (selectionPrice !== optionPrice) {
              throw new Error("Option prices have changed. Please try again");
            }

            functions.logger.log("optionPrice", optionPrice);

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
