const { firestore } = require("firebase-admin");
const moment = require("moment");

exports.getCurrentTimestamp = async () => {
  return firestore.Timestamp.now().toMillis();
};

exports.getCurrentWeeklyPeriodFromTimestamp = async (timestamp) => {
  let weekStart = await moment(timestamp, "x")
    .tz("Etc/GMT+8")
    .subtract(1, "weeks")
    .weekday(6)
    .startOf("day")
    .format("MMDDYYYY");
  let weekEnd = moment(timestamp, "x")
    .tz("Etc/GMT+8")
    .weekday(5)
    .endOf("day")
    .format("MMDDYYYY");

  if (timestamp > moment(weekEnd, "MMDDYYYY").format("x")) {
    weekStart = moment(weekStart, "MMDDYYYY")
      .add(1, "weeks")
      .format("MMDDYYYY");

    weekEnd = moment(weekEnd, "MMDDYYYY").add(1, "weeks").format("MMDDYYYY");
  }

  return { weekStart, weekEnd };
};
