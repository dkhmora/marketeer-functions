const getTotalItemOptionsPrice = (item, itemSnapshot) => {
  const { options } = itemSnapshot;
  const { selectedOptions } = item;
  let totelOptionsPrice = 0;

  Object.values(selectedOptions).map((optionData) => {
    Object.entries(optionData).map(([optionTitle, selectedSelections]) => {
      Object.keys(selectedSelections).map((selectedSelectionTitle) => {
        if (options[optionTitle] && options[optionTitle].selection) {
          const selectionSnapshot = options[optionTitle].selection.find(
            (selection) => selection.title === selectedSelectionTitle
          );

          totalOptionsPrice += selectionSnapshot.price;
        }
      });
    });
  });

  return totelOptionsPrice;
};

module.exports = {
  getTotalItemOptionsPrice,
};
