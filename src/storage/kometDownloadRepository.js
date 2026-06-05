const { readData, updateData } = require("./dataStore");

function nowIso() {
  return new Date().toISOString();
}

function cleanRelativePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .replace(/^,+|,+$/g, "")
    .trim();
}

function cleanFileName(value) {
  return String(value || "").trim();
}

function normalizeSyncStateKey(downloadDir, name) {
  return `${cleanRelativePath(downloadDir)}::${cleanFileName(name).toLowerCase()}`;
}

function toComparableTime(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

async function upsertBatchRun(run) {
  return updateData(async (data) => {
    const payload = { ...run, updatedAt: run.updatedAt || nowIso() };
    const rows = data.kometDownload.batchRuns;
    const index = rows.findIndex((item) => item.runId === payload.runId);
    if (index >= 0) rows[index] = payload;
    else rows.push(payload);
    return { data, result: payload };
  });
}

async function getBatchRun(runId) {
  const data = await readData();
  return data.kometDownload.batchRuns.find((item) => item.runId === runId) || null;
}

async function getLatestBatchRunByDownloadDir(downloadDir) {
  const normalized = cleanRelativePath(downloadDir);
  if (!normalized) return null;
  const data = await readData();
  const rows = data.kometDownload.batchRuns
    .filter((item) => cleanRelativePath(item.downloadDirRaw) === normalized)
    .sort(
      (a, b) =>
        toComparableTime(b.updatedAt || b.completedAt || b.startedAt) -
        toComparableTime(a.updatedAt || a.completedAt || a.startedAt)
    );
  return rows[0] || null;
}

async function upsertSyncRun(run) {
  return updateData(async (data) => {
    const payload = { ...run, updatedAt: run.updatedAt || nowIso() };
    const rows = data.kometDownload.syncRuns;
    const index = rows.findIndex((item) => item.runId === payload.runId);
    if (index >= 0) rows[index] = payload;
    else rows.push(payload);
    return { data, result: payload };
  });
}

async function getSyncRun(runId) {
  const data = await readData();
  return data.kometDownload.syncRuns.find((item) => item.runId === runId) || null;
}

async function getLatestSyncRunByDownloadDir(downloadDir) {
  const normalized = cleanRelativePath(downloadDir);
  if (!normalized) return null;
  const data = await readData();
  const rows = data.kometDownload.syncRuns
    .filter((item) => cleanRelativePath(item.downloadDir) === normalized)
    .sort(
      (a, b) =>
        toComparableTime(b.updatedAt || b.completedAt || b.startedAt) -
        toComparableTime(a.updatedAt || a.completedAt || a.startedAt)
    );
  return rows[0] || null;
}

async function upsertSyncFileState(downloadDir, name, patch = {}) {
  return updateData(async (data) => {
    const key = normalizeSyncStateKey(downloadDir, name);
    const rows = data.kometDownload.syncFileStates;
    const current = rows.find((item) => item.key === key);
    const next = {
      key,
      downloadDir: cleanRelativePath(downloadDir),
      name: cleanFileName(name),
      status: patch.status || current?.status || "queued",
      result: patch.result ?? current?.result ?? null,
      updatedAt: patch.updatedAt || nowIso(),
    };
    const index = rows.findIndex((item) => item.key === key);
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    return { data, result: next };
  });
}

async function getSyncFileState(downloadDir, name) {
  const data = await readData();
  const key = normalizeSyncStateKey(downloadDir, name);
  return data.kometDownload.syncFileStates.find((item) => item.key === key) || null;
}

async function getSyncFileStateMap(downloadDir) {
  const normalized = cleanRelativePath(downloadDir);
  const data = await readData();
  const map = new Map();
  for (const item of data.kometDownload.syncFileStates) {
    if (cleanRelativePath(item.downloadDir) === normalized) {
      map.set(cleanFileName(item.name).toLowerCase(), item);
    }
  }
  return map;
}

module.exports = {
  upsertBatchRun,
  getBatchRun,
  getLatestBatchRunByDownloadDir,
  upsertSyncRun,
  getSyncRun,
  getLatestSyncRunByDownloadDir,
  upsertSyncFileState,
  getSyncFileState,
  getSyncFileStateMap,
};
