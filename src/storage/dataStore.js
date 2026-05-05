const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const dataFilePath =
  process.env.DATA_FILE || path.join(__dirname, "..", "..", "data", "storage.json");

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
    await fs.access(dataFilePath);
  } catch {
    await fs.writeFile(dataFilePath, JSON.stringify(defaultData, null, 2), "utf8");
  }
}

async function readData() {
  await ensureDataFile();
  const raw = await fs.readFile(dataFilePath, "utf8");
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
  await ensureDataFile();
  const payload = {
    jobs: Array.isArray(nextData.jobs) ? nextData.jobs : [],
    setting: nextData.setting || null,
  };
  await fs.writeFile(dataFilePath, JSON.stringify(payload, null, 2), "utf8");
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
  dataFilePath,
};
