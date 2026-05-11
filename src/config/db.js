const { readData, getDataFilePath } = require("../storage/dataStore");
const { connectSqlServer } = require("./sqlserver");

async function connectDb() {
  await readData();
  const sqlServer = await connectSqlServer();
  return { type: "lowdb", file: getDataFilePath(), sqlServer };
}

module.exports = { connectDb };
