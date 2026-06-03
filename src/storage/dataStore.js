const fs = require("fs/promises");
const { constants: fsConstants } = require("fs");
const path = require("path");
const crypto = require("crypto");
const env = require("../config/env");

let dataFilePath = env.dataFile;
let db = null;
let dbReadyPromise = null;
let lowdbModulesPromise = null;

const defaultData = {
  jobs: [],
  setting: null,
  kometDownload: {
    batchRuns: [],
    syncRuns: [],
    syncFileStates: [],
  },
};

let writeQueue = Promise.resolve();

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDataShape(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const kometDownload =
    data.kometDownload && typeof data.kometDownload === "object" ? data.kometDownload : {};
  return {
    jobs: Array.isArray(data.jobs) ? data.jobs : [],
    setting: data.setting || null,
    kometDownload: {
      batchRuns: Array.isArray(kometDownload.batchRuns) ? kometDownload.batchRuns : [],
      syncRuns: Array.isArray(kometDownload.syncRuns) ? kometDownload.syncRuns : [],
      syncFileStates: Array.isArray(kometDownload.syncFileStates)
        ? kometDownload.syncFileStates
        : [],
    },
  };
}

async function loadLowdbModules() {
  if (!lowdbModulesPromise) {
    lowdbModulesPromise = Promise.all([import("lowdb"), import("lowdb/node")]).then(
      ([core, node]) => ({
        Low: core.Low,
        JSONFile: node.JSONFile,
      })
    );
  }
  return lowdbModulesPromise;
}

async function ensureDataFile(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(filePath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2), "utf8");
  }
}

function isPermissionError(error) {
  return ["EACCES", "EPERM", "EROFS"].includes(error?.code);
}

function createStorageAccessError(error, phase = "access") {
  const code = error?.code || "UNKNOWN";
  const wrapped = new Error(
    `[DataStore] Cannot ${phase} DATA_FILE at "${dataFilePath}" (${code}). ` +
      "Fix DATA_FILE path/permissions. Fallback storage is disabled."
  );
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}

async function createDb(filePath) {
  const { Low, JSONFile } = await loadLowdbModules();
  const adapter = new JSONFile(filePath);
  const instance = new Low(adapter, deepClone(defaultData));
  await instance.read();
  instance.data = normalizeDataShape(instance.data);
  await instance.write();
  return instance;
}

async function resolveDb() {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      try {
        await ensureDataFile(dataFilePath);
        db = await createDb(dataFilePath);
      } catch (error) {
        if (isPermissionError(error)) {
          throw createStorageAccessError(error, "initialize");
        }
        throw error;
      }
      return db;
    })();
  }
  return dbReadyPromise;
}

async function readData() {
  const activeDb = await resolveDb();
  try {
    await activeDb.read();
  } catch (error) {
    if (isPermissionError(error)) {
      throw createStorageAccessError(error, "read");
    }
    throw error;
  }
  activeDb.data = normalizeDataShape(activeDb.data);
  return deepClone(activeDb.data);
}

async function writeData(nextData) {
  const payload = normalizeDataShape(nextData);
  const activeDb = await resolveDb();
  activeDb.data = payload;
  try {
    await activeDb.write();
  } catch (error) {
    if (isPermissionError(error)) {
      throw createStorageAccessError(error, "write");
    }
    throw error;
  }
}

function getDataFilePath() {
  return dataFilePath;
}

async function updateData(updater) {
  writeQueue = writeQueue.then(async () => {
    const current = await readData();
    const result = await updater(current);
    if (!result || typeof result !== "object") {
      throw new Error("Data updater must return an object.");
    }
    await writeData(result.data || current);
    return result.result;
  });
  return writeQueue;
}

module.exports = {
  readData,
  writeData,
  updateData,
  generateId,
  getDataFilePath,
};
