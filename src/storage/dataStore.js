const fs = require("fs/promises");
const { constants: fsConstants } = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const env = require("../config/env");

let dataFilePath = env.dataFile;
let db = null;
let dbReadyPromise = null;
let lowdbModulesPromise = null;

const defaultData = {
  jobs: [],
  setting: null,
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
  return {
    jobs: Array.isArray(data.jobs) ? data.jobs : [],
    setting: data.setting || null,
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

async function createDb(filePath) {
  const { Low, JSONFile } = await loadLowdbModules();
  const adapter = new JSONFile(filePath);
  const instance = new Low(adapter, deepClone(defaultData));
  await instance.read();
  instance.data = normalizeDataShape(instance.data);
  await instance.write();
  return instance;
}

async function switchToFallbackPath(error) {
  const fallbackPath = path.join(os.tmpdir(), "automation_ai_ingestion", "storage.json");
  if (dataFilePath === fallbackPath) throw error;

  // eslint-disable-next-line no-console
  console.warn(
    `[DataStore] Cannot access DATA_FILE at "${dataFilePath}" (${error.code}). Falling back to "${fallbackPath}".`
  );
  dataFilePath = fallbackPath;
  db = null;
  dbReadyPromise = null;
  await ensureDataFile(dataFilePath);
}

async function resolveDb() {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      try {
        await ensureDataFile(dataFilePath);
        db = await createDb(dataFilePath);
      } catch (error) {
        if (!isPermissionError(error)) throw error;
        await switchToFallbackPath(error);
        db = await createDb(dataFilePath);
      }
      return db;
    })();
  }
  return dbReadyPromise;
}

async function readData() {
  let activeDb;
  try {
    activeDb = await resolveDb();
    await activeDb.read();
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await switchToFallbackPath(error);
    activeDb = await resolveDb();
    await activeDb.read();
  }
  activeDb.data = normalizeDataShape(activeDb.data);
  return deepClone(activeDb.data);
}

async function writeData(nextData) {
  const payload = normalizeDataShape(nextData);
  let activeDb;
  try {
    activeDb = await resolveDb();
    activeDb.data = payload;
    await activeDb.write();
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await switchToFallbackPath(error);
    activeDb = await resolveDb();
    activeDb.data = payload;
    await activeDb.write();
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
