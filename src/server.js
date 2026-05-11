const app = require("./app");
const env = require("./config/env");
const { connectDb } = require("./config/db");

async function start() {
  const dbInfo = await connectDb();
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Server running at http://localhost:${env.port} (base path: ${env.appBasePath || "/"})`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[Storage] ${dbInfo.type} (${dbInfo.file}) | [SQLServer] ${
        dbInfo.sqlServer.enabled ? "enabled and connected" : "disabled"
      }`
    );
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", error);
  process.exit(1);
});
