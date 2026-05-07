const { readData, getDataFilePath } = require("../storage/dataStore");

async function connectDb() {
  await readData();
  return { type: "lowdb", file: getDataFilePath() };
}

module.exports = { connectDb };
