const fs = require("fs/promises");
const { constants: fsConstants } = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const env = require("../config/env");

let dataFilePath = env.dataFile;
let dataFileReadyPromise = null;

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

async function ensureDataFile() {
  const dir = path.dirname(dataFilePath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(dataFilePath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    await fs.writeFile(dataFilePath, JSON.stringify(defaultData, null, 2), "utf8");
  }
}

function isPermissionError(error) {
  return ["EACCES", "EPERM", "EROFS"].includes(error?.code);
}

async function resolveDataFilePath() {
  if (!dataFileReadyPromise) {
    dataFileReadyPromise = (async () => {
      try {
        await ensureDataFile();
      } catch (error) {
        if (!isPermissionError(error)) throw error;

        const fallbackPath = path.join(os.tmpdir(), "automation_ai_ingestion", "storage.json");
        // eslint-disable-next-line no-console
        console.warn(
          `[DataStore] Cannot access DATA_FILE at "${dataFilePath}" (${error.code}). Falling back to "${fallbackPath}".`
        );
        dataFilePath = fallbackPath;
        await ensureDataFile();
      }
    })();
  }

  await dataFileReadyPromise;
  return dataFilePath;
}

async function switchToFallbackPath(error) {
  const fallbackPath = path.join(os.tmpdir(), "automation_ai_ingestion", "storage.json");
  if (dataFilePath === fallbackPath) throw error;

  // eslint-disable-next-line no-console
  console.warn(
    `[DataStore] Cannot access DATA_FILE at "${dataFilePath}" (${error.code}). Falling back to "${fallbackPath}".`
  );
  dataFilePath = fallbackPath;
  dataFileReadyPromise = null;
  await resolveDataFilePath();
}

async function readData() {
  const activeDataFilePath = await resolveDataFilePath();
  let raw;
  try {
    raw = await fs.readFile(activeDataFilePath, "utf8");
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await switchToFallbackPath(error);
    raw = await fs.readFile(await resolveDataFilePath(), "utf8");
  }
  if (!raw.trim()) return deepClone(defaultData);
  try {
    const parsed = JSON.parse(raw);
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      setting: parsed.setting || null,
    };
  } catch {
    return deepClone(defaultData);
  }
}

async function writeData(nextData) {
  const activeDataFilePath = await resolveDataFilePath();
  const payload = {
    jobs: Array.isArray(nextData.jobs) ? nextData.jobs : [],
    setting: nextData.setting || null,
  };
  try {
    await fs.writeFile(activeDataFilePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await switchToFallbackPath(error);
    await fs.writeFile(await resolveDataFilePath(), JSON.stringify(payload, null, 2), "utf8");
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
