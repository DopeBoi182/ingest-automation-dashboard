const { readData, dataFilePath } = require("../storage/dataStore");

async function connectDb() {
  await readData();
  return { type: "json", file: dataFilePath };
}

module.exports = { connectDb };
