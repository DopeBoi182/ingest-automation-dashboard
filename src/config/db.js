const { readData, getDataFilePath } = require("../storage/dataStore");

async function connectDb() {
  await readData();
  return { type: "json", file: getDataFilePath() };
}

module.exports = { connectDb };
