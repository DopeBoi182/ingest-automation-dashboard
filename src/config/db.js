const { readData, getDataFilePath } = require("../storage/dataStore");
const { connectSqlServer } = require("./sqlserver");
const env = require("./env");

async function connectDb() {
  await readData();
  const sqlServer = env.kometDisabled
    ? { enabled: false, connected: false, skippedByKometDisabled: true }
    : await connectSqlServer();
  return { type: "lowdb", file: getDataFilePath(), sqlServer };
}

module.exports = { connectDb };
