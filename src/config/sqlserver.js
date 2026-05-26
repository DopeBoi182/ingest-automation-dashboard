const mssql = require("mssql");
const env = require("./env");

let sqlPool = null;
let connectPromise = null;
let runtimeTrustServerCertificate;

function toBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).trim().toLowerCase() === "true";
}

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseConnectionString(connectionString) {
  const entries = String(connectionString || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eqIndex = part.indexOf("=");
      if (eqIndex === -1) return acc;
      const key = part.slice(0, eqIndex).trim().toLowerCase();
      const value = part.slice(eqIndex + 1).trim();
      acc[key] = value;
      return acc;
    }, {});

  const rawServer = entries.server || entries["data source"] || "";
  const [serverHost, serverPort] = rawServer.split(",").map((value) => value?.trim());

  return {
    server: serverHost || "",
    port: toNumber(serverPort, env.sqlServerPort),
    database: entries.database || entries["initial catalog"] || "",
    user: entries["user id"] || entries.uid || entries.user || "",
    password: entries.password || entries.pwd || "",
    options: {
      encrypt: toBool(entries.encrypt, env.sqlServerEncrypt),
      trustServerCertificate: toBool(
        entries.trustservercertificate,
        env.sqlServerTrustServerCertificate
      ),
    },
  };
}

function getMissingRequiredFields() {
  if (String(env.sqlServerConnectionString || "").trim()) return [];
  const requiredFields = [
    ["SQLSERVER_HOST", env.sqlServerHost],
    ["SQLSERVER_DATABASE", env.sqlServerDatabase],
    ["SQLSERVER_USER", env.sqlServerUser],
    ["SQLSERVER_PASSWORD", env.sqlServerPassword],
  ];

  return requiredFields.filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
}

function buildSqlServerConfig() {
  const fromConnectionString = String(env.sqlServerConnectionString || "").trim();
  const trustServerCertificate =
    runtimeTrustServerCertificate === undefined
      ? env.sqlServerTrustServerCertificate
      : runtimeTrustServerCertificate;

  if (fromConnectionString) {
    const parsed = parseConnectionString(fromConnectionString);
    return {
      server: parsed.server,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      password: parsed.password,
      options: {
        encrypt: parsed.options.encrypt,
        trustServerCertificate:
          runtimeTrustServerCertificate === undefined
            ? parsed.options.trustServerCertificate
            : runtimeTrustServerCertificate,
      },
      connectionTimeout: env.sqlServerConnectionTimeoutMs,
      requestTimeout: env.sqlServerRequestTimeoutMs,
      pool: {
        max: env.sqlServerPoolMax,
        min: env.sqlServerPoolMin,
        idleTimeoutMillis: env.sqlServerPoolIdleTimeoutMs,
      },
    };
  }

  return {
    server: env.sqlServerHost,
    port: env.sqlServerPort,
    database: env.sqlServerDatabase,
    user: env.sqlServerUser,
    password: env.sqlServerPassword,
    options: {
      encrypt: env.sqlServerEncrypt,
      trustServerCertificate,
    },
    connectionTimeout: env.sqlServerConnectionTimeoutMs,
    requestTimeout: env.sqlServerRequestTimeoutMs,
    pool: {
      max: env.sqlServerPoolMax,
      min: env.sqlServerPoolMin,
      idleTimeoutMillis: env.sqlServerPoolIdleTimeoutMs,
    },
  };
}

function validateSqlServerConfig() {
  const missingFields = getMissingRequiredFields();
  if (missingFields.length > 0) {
    throw new Error(
      `SQL Server is enabled but missing required environment variables: ${missingFields.join(", ")}`
    );
  }
}

async function connectSqlServer() {
  if (!env.sqlServerEnabled) {
    return { enabled: false, connected: false };
  }

  if (sqlPool) {
    return { enabled: true, connected: true };
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      validateSqlServerConfig();
      const pool = new mssql.ConnectionPool(buildSqlServerConfig());
      pool.on("error", (error) => {
        // eslint-disable-next-line no-console
        console.error("[SQLServer] Pool error:", error);
      });
      await pool.connect();
      sqlPool = pool;
      return sqlPool;
    })().catch((error) => {
      sqlPool = null;
      connectPromise = null;
      throw error;
    });
  }

  await connectPromise;
  return { enabled: true, connected: true };
}

function getSqlServerPool() {
  if (!sqlPool) {
    throw new Error("SQL Server pool is not initialized. Call connectSqlServer() first.");
  }
  return sqlPool;
}

async function closeSqlServer() {
  if (!sqlPool) {
    connectPromise = null;
    return;
  }
  const pool = sqlPool;
  sqlPool = null;
  connectPromise = null;
  await pool.close();
}

async function reconnectSqlServer() {
  await closeSqlServer();
  return connectSqlServer();
}

function setSqlServerRuntimeTrustServerCertificate(value) {
  if (value === undefined || value === null || value === "") {
    runtimeTrustServerCertificate = undefined;
    return;
  }
  runtimeTrustServerCertificate = Boolean(value);
}

function getSqlServerConnectionConfig() {
  const config = buildSqlServerConfig();
  return {
    enabled: env.sqlServerEnabled,
    connected: Boolean(sqlPool),
    server: config.server,
    port: config.port,
    database: config.database,
    encrypt: config.options.encrypt,
    trustServerCertificate: config.options.trustServerCertificate,
    trustServerCertificateSource:
      runtimeTrustServerCertificate === undefined ? "env" : "runtime",
  };
}

module.exports = {
  connectSqlServer,
  getSqlServerPool,
  closeSqlServer,
  reconnectSqlServer,
  setSqlServerRuntimeTrustServerCertificate,
  getSqlServerConnectionConfig,
};
