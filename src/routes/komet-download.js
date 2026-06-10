const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const express = require("express");
const env = require("../config/env");
const { uploadFileToKometSync } = require("../services/kometSyncClient");
const {
  upsertBatchRun,
  getBatchRun,
  getBatchRunsByState,
  getLatestBatchRunByDownloadDir,
  upsertSyncRun,
  getSyncRun,
  getLatestSyncRunByDownloadDir,
  upsertSyncFileState,
  getSyncFileState: getPersistedSyncFileState,
  getSyncFileStateMap,
} = require("../storage/kometDownloadRepository");

const router = express.Router();

const DOWNLOAD_ROOT = path.resolve(process.cwd(), "downloads");
const REPORT_ROOT = path.resolve(DOWNLOAD_ROOT, "reports");
const MAX_BATCH_ITEMS = Math.max(1000, env.kometDownloadMaxBatchItems || 10000);
const MAX_PAGE_SIZE = 200;
const LOG_BUFFER_MAX = 500;
const ITEM_TIMEOUT_MS = Math.max(30000, env.kometDownloadItemTimeoutMs || 120000);
const MAX_DOWNLOAD_RETRIES = Math.max(0, env.kometDownloadMaxRetries || 2);

const activeBatchWorkers = new Set();

const sseClients = new Set();
const logBuffer = [];

function broadcastLog(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function logKometInfo(action, meta = {}) {
  const entry = {
    at: new Date().toISOString(),
    level: "info",
    action,
    ...meta,
  };
  // eslint-disable-next-line no-console
  console.log("[KometDownload]", entry);
  broadcastLog(entry);
}

function logKometError(action, error, meta = {}) {
  const entry = {
    at: new Date().toISOString(),
    level: "error",
    action,
    message: error?.message || "Unknown error",
    detail: error?.detail || null,
    status: error?.status || null,
    ...meta,
  };
  // eslint-disable-next-line no-console
  console.error("[KometDownload]", entry);
  broadcastLog(entry);
}

function isSafeSegment(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (path.isAbsolute(raw)) return false;
  if (raw.includes("\0")) return false;
  const normalized = raw.replaceAll("\\", "/");
  return !normalized.split("/").some((segment) => segment === "..");
}

function ensureSafeDownloadDir(downloadDir) {
  const normalized = String(downloadDir || "").trim();
  if (!isSafeSegment(normalized)) {
    throw new Error("downloadDir must be a relative safe path under downloads/.");
  }
  const finalDir = path.resolve(DOWNLOAD_ROOT, normalized);
  if (finalDir !== DOWNLOAD_ROOT && !finalDir.startsWith(`${DOWNLOAD_ROOT}${path.sep}`)) {
    throw new Error("downloadDir escapes downloads/ root.");
  }
  return finalDir;
}

function buildDownloadUrl(baseUrl, singlePath) {
  const normalizedBaseUrl = String(baseUrl || "").trim();
  const normalizedSinglePath = cleanRelativePath(singlePath);
  if (!normalizedBaseUrl) throw new Error("baseUrl is required.");
  if (!normalizedSinglePath) throw new Error("singlePath is required.");
  return `${normalizedBaseUrl}${encodeURIComponent(normalizedSinglePath)}`;
}

function ensureFileName(singlePath) {
  const normalized = cleanRelativePath(singlePath).replaceAll("\\", "/");
  const fileName = normalizeWhitespace(path.basename(normalized));
  if (!fileName || fileName === "." || fileName === "..") {
    throw new Error("singlePath must include a valid file name.");
  }
  return fileName;
}

async function getUniqueFilePath(baseDir, originalFileName) {
  const extension = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, extension);

  let counter = 0;
  while (counter < 10000) {
    const candidateName =
      counter === 0 ? originalFileName : `${baseName}_${counter}${extension}`;
    const candidatePath = path.join(baseDir, candidateName);
    // eslint-disable-next-line no-await-in-loop
    const exists = await fsp
      .access(candidatePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidatePath;
    counter += 1;
  }

  throw new Error("Too many duplicate files in target directory.");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanFileName(value) {
  return String(value || "").trim();
}

function cleanRelativePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .replace(/^,+|,+$/g, "")
    .trim();
}

function sanitizeCookieHeader(rawCookie) {
  return String(rawCookie || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("'", "")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePathsInput(pathsInput) {
  const rawItems = Array.isArray(pathsInput)
    ? pathsInput
    : String(pathsInput || "")
        .split(/[\n,]+/g)
        .map((item) => item);
  return rawItems
    .map((item) => cleanRelativePath(item))
    .filter((item) => Boolean(item));
}

function parsePage(value, fallback = 1) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseLimit(value, fallback = 25) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function paginate(items, page, limit) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * limit;
  const sliced = items.slice(start, start + limit);
  return {
    items: sliced,
    page: safePage,
    limit,
    totalItems,
    totalPages,
  };
}

function getDownloadStatus(item) {
  return item.downloadStatus || item.status || "queued";
}

function getSyncStatus(item) {
  return item.syncStatus || "idle";
}

function isDownloadTerminal(status) {
  return ["downloaded", "failed", "skipped"].includes(status);
}

function isSyncTerminal(status) {
  return ["synced", "failed", "skipped"].includes(status);
}

function recomputeBatchRunSummary(run) {
  let downloadProcessed = 0;
  let downloadSuccess = 0;
  let downloadFailed = 0;
  let downloadSkipped = 0;
  let syncProcessed = 0;
  let syncSuccess = 0;
  let syncFailed = 0;
  let syncSkipped = 0;
  let syncTotal = 0;

  for (const item of run.items) {
    const downloadStatus = getDownloadStatus(item);
    const syncStatus = getSyncStatus(item);
    if (isDownloadTerminal(downloadStatus)) downloadProcessed += 1;
    if (downloadStatus === "downloaded") downloadSuccess += 1;
    if (downloadStatus === "failed") downloadFailed += 1;
    if (downloadStatus === "skipped") downloadSkipped += 1;

    if (downloadStatus === "downloaded") {
      syncTotal += 1;
      if (isSyncTerminal(syncStatus)) syncProcessed += 1;
      if (syncStatus === "synced") syncSuccess += 1;
      if (syncStatus === "failed") syncFailed += 1;
      if (syncStatus === "skipped") syncSkipped += 1;
    }
  }

  run.downloadProcessed = downloadProcessed;
  run.downloadSuccess = downloadSuccess;
  run.downloadFailed = downloadFailed;
  run.downloadSkipped = downloadSkipped;
  run.syncTotal = syncTotal;
  run.syncProcessed = syncProcessed;
  run.syncSuccess = syncSuccess;
  run.syncFailed = syncFailed;
  run.syncSkipped = syncSkipped;
  // Keep backward-compatible counters.
  run.processed = downloadProcessed;
  run.success = downloadSuccess;
  run.failed = downloadFailed;
  run.skipped = downloadSkipped;
}

function toRunSummary(run) {
  return {
    runId: run.runId,
    state: run.state,
    total: run.total,
    processed: run.downloadProcessed ?? run.processed,
    success: run.downloadSuccess ?? run.success,
    failed: run.downloadFailed ?? run.failed,
    skipped: run.downloadSkipped ?? run.skipped,
    download: {
      total: run.total,
      processed: run.downloadProcessed ?? run.processed,
      success: run.downloadSuccess ?? run.success,
      failed: run.downloadFailed ?? run.failed,
      skipped: run.downloadSkipped ?? run.skipped ?? 0,
    },
    sync: {
      enabled: Boolean(run.autoSync),
      total: run.syncTotal ?? 0,
      processed: run.syncProcessed ?? 0,
      success: run.syncSuccess ?? 0,
      failed: run.syncFailed ?? 0,
      skipped: run.syncSkipped ?? 0,
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs: run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null,
  };
}

function toRunItemResponse(runId, item) {
  const downloadStatus = getDownloadStatus(item);
  const syncStatus = getSyncStatus(item);
  const canDownload = downloadStatus === "downloaded" && item.savedPath;
  return {
    itemId: item.itemId,
    index: item.index,
    relativePath: item.relativePath,
    status: downloadStatus,
    downloadStatus,
    syncStatus,
    syncResult: item.syncResult || null,
    bytes: item.bytes || 0,
    error: item.error || null,
    skipReason: item.skipReason || null,
    savedAs: item.savedAs || null,
    savedPath: item.savedPath || null,
    downloadUrl: canDownload ? `./api/komet-download/batch/${runId}/files/${item.itemId}` : null,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
  };
}

function toSyncRunItemResponse(item) {
  return {
    itemId: item.itemId,
    index: item.index,
    name: item.name,
    status: item.status,
    result: item.result || null,
    error: item.error || null,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
  };
}

function toSyncRunSummary(run) {
  return {
    runId: run.runId,
    state: run.state,
    total: run.total,
    processed: run.processed,
    success: run.success,
    failed: run.failed,
    skipped: run.skipped,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs: run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null,
  };
}

async function setSyncFileState(downloadDir, name, patch = {}) {
  await upsertSyncFileState(downloadDir, name, patch);
}

async function getSyncFileState(downloadDir, name) {
  return getPersistedSyncFileState(downloadDir, name);
}

async function listDownloadedFiles(targetDir) {
  const entries = await fsp.readdir(targetDir, { withFileTypes: true });
  const fileEntries = entries.filter((entry) => {
    if (!entry.isFile()) return false;
    const name = cleanFileName(entry.name);
    return Boolean(name);
  });
  const results = await Promise.all(
    fileEntries.map(async (entry) => {
      const name = cleanFileName(entry.name);
      const fullPath = path.join(targetDir, entry.name);
      const stat = await fsp.stat(fullPath);
      return {
        name,
        filePath: fullPath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
  );
  return results;
}

async function resolveSafeDownloadedFile(downloadDir, rawName) {
  const cleanDownloadDir = cleanRelativePath(downloadDir);
  const cleanName = cleanFileName(rawName);
  if (!cleanDownloadDir) {
    throw Object.assign(new Error("downloadDir is required."), { status: 400 });
  }
  if (!cleanName) {
    throw Object.assign(new Error("name is required."), { status: 400 });
  }

  const targetDir = ensureSafeDownloadDir(cleanDownloadDir);
  const candidate = path.resolve(targetDir, cleanName);
  if (candidate !== targetDir && !candidate.startsWith(`${targetDir}${path.sep}`)) {
    throw Object.assign(new Error("Invalid file path."), { status: 400 });
  }
  const exists = await fsp
    .access(candidate)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw Object.assign(new Error("File not found."), { status: 404 });
  }

  return {
    downloadDir: cleanDownloadDir,
    targetDir,
    name: cleanName,
    filePath: candidate,
  };
}

async function writeReportFile(prefix, run, rows) {
  await fsp.mkdir(REPORT_ROOT, { recursive: true });
  const filePath = path.join(REPORT_ROOT, `${prefix}-${run.runId}.txt`);
  const header = [
    `runId: ${run.runId}`,
    `downloadDir: ${run.downloadDirRaw}`,
    `startedAt: ${run.startedAt}`,
    `completedAt: ${run.completedAt || new Date().toISOString()}`,
    `total: ${run.total}`,
    `processed: ${run.processed}`,
    `success: ${run.success}`,
    `failed: ${run.failed}`,
    `skipped: ${run.skipped}`,
    "",
  ];
  const body =
    rows.length > 0
      ? rows
          .map((item) => {
            const detail = item.error || item.skipReason || "";
            return `${item.index}. ${item.relativePath}${detail ? ` | ${detail}` : ""}`;
          })
          .join("\n")
      : "(none)";
  await fsp.writeFile(filePath, `${header.join("\n")}${body}\n`, "utf8");
  return filePath;
}

function normalizeBatchRunShape(run) {
  run.items = Array.isArray(run.items) ? run.items : [];
  run.autoSync = Boolean(run.autoSync);
  run.syncToken = normalizeWhitespace(run.syncToken || "");
  run.syncFolderId = normalizeWhitespace(run.syncFolderId || env.kometSyncDefaultFolderId);
  run.itemTimeoutMs = Math.max(30000, Number(run.itemTimeoutMs) || ITEM_TIMEOUT_MS);
  run.maxRetries = Math.max(0, Number(run.maxRetries) || MAX_DOWNLOAD_RETRIES);
  for (const item of run.items) {
    item.downloadStatus = getDownloadStatus(item);
    item.status = item.downloadStatus;
    item.syncStatus = getSyncStatus(item);
    item.syncResult = item.syncResult || null;
    item.retries = Number(item.retries) || 0;
    item.error = item.error || null;
    item.skipReason = item.skipReason || null;
  }
  recomputeBatchRunSummary(run);
}

function isBatchRunFinished(run) {
  if (!Array.isArray(run.items) || !run.items.length) return true;
  for (const item of run.items) {
    const downloadStatus = getDownloadStatus(item);
    const syncStatus = getSyncStatus(item);
    if (!isDownloadTerminal(downloadStatus)) return false;
    if (downloadStatus === "downloaded" && run.autoSync && !isSyncTerminal(syncStatus)) return false;
  }
  return true;
}

async function processBatchItem(run, item) {
  const downloadStatus = getDownloadStatus(item);
  if (isDownloadTerminal(downloadStatus)) return;

  item.downloadStatus = "processing";
  item.status = "processing";
  item.startedAt = new Date().toISOString();
  item.error = null;
  item.skipReason = null;

  try {
    const fileName = ensureFileName(item.relativePath);
    const targetPath = path.join(run.targetDir, fileName);
    const alreadyExists = await fsp
      .access(targetPath)
      .then(() => true)
      .catch(() => false);

    if (alreadyExists) {
      item.downloadStatus = "skipped";
      item.status = "skipped";
      item.savedAs = fileName;
      item.savedPath = targetPath;
      item.skipReason = "already_exists";
      item.syncStatus = "skipped";
      item.syncResult = "Skipped because file already exists locally";
      await setSyncFileState(run.downloadDirRaw, fileName, {
        status: "skipped",
        result: item.syncResult,
      });
    } else {
      const url = buildDownloadUrl(run.baseUrl, item.relativePath);
      const result = await downloadBinaryToFile({
        url,
        cookieHeader: run.cookies,
        targetPath,
        timeoutMs: run.itemTimeoutMs,
      });
      item.downloadStatus = "downloaded";
      item.status = "downloaded";
      item.savedAs = fileName;
      item.savedPath = targetPath;
      item.bytes = result.bytes;
      item.syncStatus = run.autoSync ? "queued" : "idle";
      item.syncResult = run.autoSync ? "Queued for auto sync" : "Auto sync disabled";
    }
  } catch (error) {
    item.downloadStatus = "failed";
    item.status = "failed";
    item.error = error?.detail || error?.message || "Unexpected download error";
    logKometError("batch.item.failed", error, {
      runId: run.runId,
      index: item.index,
      relativePath: item.relativePath,
    });
  } finally {
    item.completedAt = new Date().toISOString();
  }
}

async function syncBatchItem(run, item) {
  if (!run.autoSync) return;
  if (getDownloadStatus(item) !== "downloaded") return;
  if (isSyncTerminal(getSyncStatus(item))) return;
  if (!item.savedPath || !item.savedAs) return;

  if (!run.syncToken) {
    item.syncStatus = "failed";
    item.syncResult = "Missing sync token";
    return;
  }

  const existing = await getSyncFileState(run.downloadDirRaw, item.savedAs);
  if (existing && ["synced", "skipped"].includes(existing.status)) {
    item.syncStatus = "skipped";
    item.syncResult = `Bypass duplicate (${existing.status})`;
    return;
  }

  item.syncStatus = "processing";
  item.syncResult = "Sync in progress";
  await setSyncFileState(run.downloadDirRaw, item.savedAs, {
    status: "processing",
    result: `Auto sync ${item.index}/${run.total}`,
  });

  try {
    const uploadResponse = await uploadFileToKometSync({
      token: run.syncToken,
      folderId: run.syncFolderId,
      fileName: item.savedAs,
      filePath: item.savedPath,
      pathValue: run.downloadDirRaw,
    });
    item.syncStatus = "synced";
    item.syncResult = `HTTP ${uploadResponse.status}`;
    await setSyncFileState(run.downloadDirRaw, item.savedAs, {
      status: "synced",
      result: item.syncResult,
    });
  } catch (error) {
    item.syncStatus = "failed";
    item.syncResult = error?.message || "Sync failed";
    await setSyncFileState(run.downloadDirRaw, item.savedAs, {
      status: "failed",
      result: item.syncResult,
    });
    logKometError("batch.item.sync.failed", error, {
      runId: run.runId,
      index: item.index,
      name: item.savedAs,
    });
  }
}

async function finalizeBatchRun(run) {
  run.completedAt = new Date().toISOString();
  run.state = run.downloadFailed > 0 || run.syncFailed > 0 ? "completed_with_errors" : "completed";
  const successRows = run.items.filter((item) => getDownloadStatus(item) === "downloaded");
  const failedRows = run.items.filter((item) => getDownloadStatus(item) === "failed");
  const skippedRows = run.items.filter((item) => getDownloadStatus(item) === "skipped");
  try {
    const successReportPath = await writeReportFile("laporan_download_berhasil", run, successRows);
    const failedReportPath = await writeReportFile("laporan_download_gagal", run, failedRows);
    const skippedReportPath = await writeReportFile("laporan_download_skip", run, skippedRows);
    run.reportPaths = {
      successReportPath,
      failedReportPath,
      skippedReportPath,
    };
  } catch (error) {
    logKometError("batch.report.failed", error, {
      runId: run.runId,
    });
  }
  recomputeBatchRunSummary(run);
  run.updatedAt = new Date().toISOString();
  await upsertBatchRun(run);
  logKometInfo("batch.complete", {
    runId: run.runId,
    total: run.total,
    download: {
      processed: run.downloadProcessed,
      success: run.downloadSuccess,
      failed: run.downloadFailed,
      skipped: run.downloadSkipped,
    },
    sync: {
      processed: run.syncProcessed,
      success: run.syncSuccess,
      failed: run.syncFailed,
      skipped: run.syncSkipped,
    },
    reportPaths: run.reportPaths,
  });
}

async function processBatchRun(run) {
  normalizeBatchRunShape(run);
  run.state = "running";
  logKometInfo("batch.start", {
    runId: run.runId,
    total: run.total,
    downloadDir: run.downloadDirRaw,
    autoSync: run.autoSync,
  });

  while (!isBatchRunFinished(run)) {
    let progressed = false;
    for (const item of run.items) {
      if (isBatchRunFinished(run)) break;
      const downloadStatus = getDownloadStatus(item);
      if (!isDownloadTerminal(downloadStatus)) {
        const startedAtMs = Date.parse(item.startedAt || "") || 0;
        if (
          downloadStatus === "processing" &&
          startedAtMs > 0 &&
          Date.now() - startedAtMs > run.itemTimeoutMs
        ) {
          item.retries += 1;
          if (item.retries > run.maxRetries) {
            item.downloadStatus = "failed";
            item.status = "failed";
            item.error = `Exceeded retry limit (${run.maxRetries})`;
            item.completedAt = new Date().toISOString();
          } else {
            item.downloadStatus = "queued";
            item.status = "queued";
          }
        }
        if (getDownloadStatus(item) === "queued") {
          // eslint-disable-next-line no-await-in-loop
          await processBatchItem(run, item);
          progressed = true;
        }
      }

      if (getDownloadStatus(item) === "downloaded" && run.autoSync && !isSyncTerminal(getSyncStatus(item))) {
        // eslint-disable-next-line no-await-in-loop
        await syncBatchItem(run, item);
        progressed = true;
      }

      recomputeBatchRunSummary(run);
      run.updatedAt = new Date().toISOString();
      // eslint-disable-next-line no-await-in-loop
      await upsertBatchRun(run);
    }

    if (!progressed) {
      // No progress means remaining processing items are waiting for timeout/retry.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  await finalizeBatchRun(run);
}

function startBatchWorker(run, source = "trigger") {
  if (!run?.runId) return;
  if (activeBatchWorkers.has(run.runId)) return;
  activeBatchWorkers.add(run.runId);
  setImmediate(async () => {
    try {
      await processBatchRun(run);
    } catch (error) {
      run.state = "failed";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      recomputeBatchRunSummary(run);
      await upsertBatchRun(run);
      logKometError("batch.fatal", error, { runId: run.runId, source });
    } finally {
      activeBatchWorkers.delete(run.runId);
    }
  });
}

async function resumeRunningBatchWorkers() {
  const runs = await getBatchRunsByState("running");
  for (const run of runs) {
    normalizeBatchRunShape(run);
    startBatchWorker(run, "recovery");
    logKometInfo("batch.recovered", {
      runId: run.runId,
      downloadDir: run.downloadDirRaw,
      total: run.total,
    });
  }
}

async function processSyncRun(run) {
  logKometInfo("sync.batch.start", {
    runId: run.runId,
    downloadDir: run.downloadDir,
    total: run.total,
  });

  for (const item of run.items) {
    item.status = "processing";
    item.startedAt = new Date().toISOString();
    // eslint-disable-next-line no-await-in-loop
    await setSyncFileState(run.downloadDir, item.name, {
      status: "processing",
      result: `Processing ${item.index}/${run.total}`,
    });

    try {
      const uploadResponse = await uploadFileToKometSync({
        token: run.token,
        folderId: run.folderId,
        fileName: item.name,
        filePath: item.filePath,
        pathValue: run.pathValue,
      });
      item.status = "synced";
      item.result = `HTTP ${uploadResponse.status}`;
      run.success += 1;
      // eslint-disable-next-line no-await-in-loop
      await setSyncFileState(run.downloadDir, item.name, {
        status: "synced",
        result: item.result,
      });
    } catch (error) {
      item.status = "failed";
      item.error = error?.message || "Sync failed";
      run.failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await setSyncFileState(run.downloadDir, item.name, {
        status: "failed",
        result: item.error,
      });
      logKometError("sync.batch.item.failed", error, {
        runId: run.runId,
        name: item.name,
        index: item.index,
      });
    } finally {
      item.completedAt = new Date().toISOString();
      run.processed += 1;
      run.updatedAt = item.completedAt;
      // eslint-disable-next-line no-await-in-loop
      await upsertSyncRun(run);
    }
  }

  run.completedAt = new Date().toISOString();
  run.state = "completed";
  await upsertSyncRun(run);
  logKometInfo("sync.batch.complete", {
    runId: run.runId,
    total: run.total,
    processed: run.processed,
    success: run.success,
    failed: run.failed,
    skipped: run.skipped,
  });
}

function downloadBinaryToFile({ url, cookieHeader, targetPath, timeoutMs = 30000 }) {
  const urlObject = new URL(url);
  const requestModule = urlObject.protocol === "https:" ? https : http;
  const tempPath = `${targetPath}.part`;

  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanupTemp = async () => {
      try {
        await fsp.unlink(tempPath);
      } catch {
        // ignore cleanup error
      }
    };
    const finishWithError = async (error) => {
      if (finished) return;
      finished = true;
      await cleanupTemp();
      reject(error);
    };

    const req = requestModule.request(
      {
        protocol: urlObject.protocol,
        hostname: urlObject.hostname,
        port: urlObject.port || undefined,
        path: `${urlObject.pathname}${urlObject.search}`,
        method: "GET",
        headers: {
          Cookie: String(cookieHeader || ""),
          Accept: "*/*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        },
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        const contentType = String(res.headers?.["content-type"] || "");

        if (statusCode >= 400) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", async () => {
            const upstreamBody = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
            await finishWithError(
              Object.assign(new Error(`Upstream HTTP ${statusCode}`), {
                status: statusCode,
                detail: upstreamBody || "Upstream request failed.",
                contentType,
              })
            );
          });
          return;
        }

        const fileStream = fs.createWriteStream(tempPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(async () => {
            try {
              const stat = await fsp.stat(tempPath);
              if (!Number.isFinite(stat.size) || stat.size <= 0) {
                throw new Error("Downloaded file is empty.");
              }
              await fsp.rename(tempPath, targetPath);
              if (finished) return;
              finished = true;
              resolve({
                statusCode,
                contentType,
                bytes: stat.size,
              });
            } catch (error) {
              await finishWithError(error);
            }
          });
        });

        fileStream.on("error", async (error) => {
          await finishWithError(error);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on("error", async (error) => {
      await finishWithError(error);
    });
    req.end();
  });
}

router.get("/logs/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  // Replay last N buffered entries so newly connected clients see recent history.
  if (logBuffer.length) {
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  }

  sseClients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
      sseClients.delete(res);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

router.post("/test", async (req, res) => {
  const startedAt = Date.now();
  const traceId = crypto.randomUUID();

  try {
    const baseUrl = String(req.body?.baseUrl || "").trim();
    const cookies = sanitizeCookieHeader(req.body?.cookies || "");
    const downloadDir = String(req.body?.downloadDir || "").trim();
    const singlePath = cleanRelativePath(req.body?.singlePath || "");

    if (!baseUrl) {
      return res.status(400).json({ message: "baseUrl is required." });
    }
    if (!cookies) {
      return res.status(400).json({ message: "cookies is required." });
    }
    if (!downloadDir) {
      return res.status(400).json({ message: "downloadDir is required." });
    }
    if (!singlePath) {
      return res.status(400).json({ message: "singlePath is required." });
    }

    const targetDir = ensureSafeDownloadDir(downloadDir);
    await fsp.mkdir(targetDir, { recursive: true });

    const url = buildDownloadUrl(baseUrl, singlePath);
    const fileName = ensureFileName(singlePath);
    const targetPath = await getUniqueFilePath(targetDir, fileName);
    const savedAs = path.basename(targetPath);

    const downloadResult = await downloadBinaryToFile({
      url,
      cookieHeader: cookies,
      targetPath,
      timeoutMs: 30000,
    });

    return res.json({
      data: {
        traceId,
        url,
        statusCode: downloadResult.statusCode,
        contentType: downloadResult.contentType,
        bytes: downloadResult.bytes,
        savedAs,
        savedPath: targetPath,
        elapsedMs: Date.now() - startedAt,
      },
      debug: {
        traceId,
        downloadRoot: DOWNLOAD_ROOT,
        requestedDir: downloadDir,
        resolvedDir: targetDir,
        singlePath,
      },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
      debug: {
        traceId,
        elapsedMs: Date.now() - startedAt,
      },
    });
  }
});

router.post("/batch/start", async (req, res) => {
  const traceId = crypto.randomUUID();
  try {
    const baseUrl = String(req.body?.baseUrl || "").trim();
    const cookies = sanitizeCookieHeader(req.body?.cookies || "");
    const downloadDir = String(req.body?.downloadDir || "").trim();
    const paths = parsePathsInput(req.body?.paths);
    const autoSync = Boolean(req.body?.autoSync);
    const syncToken = normalizeWhitespace(req.body?.syncToken || "");
    const syncFolderId = normalizeWhitespace(req.body?.syncFolderId || env.kometSyncDefaultFolderId);

    if (!baseUrl) return res.status(400).json({ message: "baseUrl is required." });
    if (!cookies) return res.status(400).json({ message: "cookies is required." });
    if (!downloadDir) return res.status(400).json({ message: "downloadDir is required." });
    if (!paths.length) return res.status(400).json({ message: "paths is required." });
    if (autoSync && !syncToken) return res.status(400).json({ message: "syncToken is required." });
    if (autoSync && !syncFolderId) return res.status(400).json({ message: "syncFolderId is required." });
    if (paths.length > MAX_BATCH_ITEMS) {
      return res.status(400).json({
        message: `paths exceeds max allowed items (${MAX_BATCH_ITEMS}).`,
      });
    }

    const targetDir = ensureSafeDownloadDir(downloadDir);
    await fsp.mkdir(targetDir, { recursive: true });

    const runId = crypto.randomUUID();
    const run = {
      runId,
      traceId,
      state: "running",
      baseUrl,
      cookies,
      downloadDirRaw: downloadDir,
      targetDir,
      total: paths.length,
      autoSync,
      syncToken,
      syncFolderId,
      itemTimeoutMs: ITEM_TIMEOUT_MS,
      maxRetries: MAX_DOWNLOAD_RETRIES,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      downloadProcessed: 0,
      downloadSuccess: 0,
      downloadFailed: 0,
      downloadSkipped: 0,
      syncTotal: 0,
      syncProcessed: 0,
      syncSuccess: 0,
      syncFailed: 0,
      syncSkipped: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      reportPaths: null,
      items: paths.map((item, index) => ({
        itemId: crypto.randomUUID(),
        index: index + 1,
        relativePath: item,
        downloadStatus: "queued",
        status: "queued",
        syncStatus: "idle",
        syncResult: null,
        error: null,
        skipReason: null,
        retries: 0,
        savedAs: null,
        savedPath: null,
        bytes: 0,
        startedAt: null,
        completedAt: null,
      })),
    };

    normalizeBatchRunShape(run);
    await upsertBatchRun(run);
    startBatchWorker(run, "trigger");

    return res.json({
      data: {
        runId,
        total: run.total,
        state: run.state,
        autoSync: run.autoSync,
      },
      debug: { traceId },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
      debug: { traceId },
    });
  }
});

router.get("/batch/:runId/status", async (req, res) => {
  const runId = String(req.params?.runId || "").trim();
  const run = await getBatchRun(runId);
  if (!run) {
    return res.status(404).json({ message: "runId not found." });
  }
  normalizeBatchRunShape(run);
  if (run.state === "running") {
    startBatchWorker(run, "status-poll");
  }

  const page = parsePage(req.query?.page, 1);
  const limit = parseLimit(req.query?.limit, 25);
  const paged = paginate(run.items, page, limit);

  return res.json({
    data: {
      summary: toRunSummary(run),
      items: paged.items.map((item) => toRunItemResponse(run.runId, item)),
      page: paged.page,
      limit: paged.limit,
      totalItems: paged.totalItems,
      totalPages: paged.totalPages,
      reportPaths: run.reportPaths,
    },
  });
});

router.get("/batch/:runId/files/:itemId", async (req, res) => {
  const runId = String(req.params?.runId || "").trim();
  const itemId = String(req.params?.itemId || "").trim();
  const run = await getBatchRun(runId);
  if (!run) {
    return res.status(404).json({ message: "runId not found." });
  }

  const item = run.items.find((row) => row.itemId === itemId);
  if (!item || !item.savedPath || getDownloadStatus(item) !== "downloaded") {
    return res.status(404).json({ message: "File is not available for download." });
  }

  const resolved = path.resolve(item.savedPath);
  if (resolved !== DOWNLOAD_ROOT && !resolved.startsWith(`${DOWNLOAD_ROOT}${path.sep}`)) {
    return res.status(400).json({ message: "Invalid file path." });
  }
  return res.download(resolved, item.savedAs || path.basename(resolved));
});

router.get("/downloaded", async (req, res) => {
  try {
    const downloadDir = cleanRelativePath(req.query?.downloadDir || "");
    if (!downloadDir) return res.status(400).json({ message: "downloadDir is required." });

    const targetDir = ensureSafeDownloadDir(downloadDir);
    const exists = await fsp
      .access(targetDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return res.json({
        data: {
          downloadDir,
          files: [],
          page: 1,
          limit: parseLimit(req.query?.limit, 25),
          totalItems: 0,
          totalPages: 1,
        },
      });
    }

    const [fileEntries, syncStateMap] = await Promise.all([
      listDownloadedFiles(targetDir),
      getSyncFileStateMap(downloadDir),
    ]);

    const files = fileEntries.map((entry) => {
      const syncState = syncStateMap.get(entry.name.toLowerCase()) || null;
      return {
        name: entry.name,
        bytes: entry.bytes,
        modifiedAt: entry.modifiedAt,
        syncStatus: syncState?.status || "idle",
        syncResult: syncState?.result || null,
        syncUpdatedAt: syncState?.updatedAt || null,
        downloadUrl: `./api/komet-download/downloaded/file?downloadDir=${encodeURIComponent(
          downloadDir
        )}&name=${encodeURIComponent(entry.name)}`,
      };
    });

    files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    const page = parsePage(req.query?.page, 1);
    const limit = parseLimit(req.query?.limit, 25);
    const paged = paginate(files, page, limit);

    return res.json({
      data: {
        downloadDir,
        files: paged.items,
        page: paged.page,
        limit: paged.limit,
        totalItems: paged.totalItems,
        totalPages: paged.totalPages,
      },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

router.get("/downloaded/file", async (req, res) => {
  try {
    const fileInfo = await resolveSafeDownloadedFile(req.query?.downloadDir, req.query?.name);
    return res.download(fileInfo.filePath, fileInfo.name);
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

router.get("/state", async (req, res) => {
  try {
    const downloadDir = cleanRelativePath(req.query?.downloadDir || "");
    if (!downloadDir) return res.status(400).json({ message: "downloadDir is required." });

    const [batchRun, syncRun] = await Promise.all([
      getLatestBatchRunByDownloadDir(downloadDir),
      getLatestSyncRunByDownloadDir(downloadDir),
    ]);

    return res.json({
      data: {
        downloadDir,
        batch: batchRun
          ? {
              runId: batchRun.runId,
              summary: toRunSummary(batchRun),
            }
          : null,
        sync: syncRun
          ? {
              runId: syncRun.runId,
              summary: toSyncRunSummary(syncRun),
            }
          : null,
      },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

router.post("/sync/single", async (req, res) => {
  try {
    const token = normalizeWhitespace(req.body?.token || "");
    const folderId = normalizeWhitespace(req.body?.folderId || env.kometSyncDefaultFolderId);
    const fileInfo = await resolveSafeDownloadedFile(req.body?.downloadDir, req.body?.name);
    const pathValue = fileInfo.downloadDir;

    if (!token) return res.status(400).json({ message: "token is required." });
    if (!folderId) return res.status(400).json({ message: "folderId is required." });

    await setSyncFileState(fileInfo.downloadDir, fileInfo.name, {
      status: "processing",
      result: "Sync in progress",
    });

    const upstream = await uploadFileToKometSync({
      token,
      folderId,
      fileName: fileInfo.name,
      filePath: fileInfo.filePath,
      pathValue,
    });

    await setSyncFileState(fileInfo.downloadDir, fileInfo.name, {
      status: "synced",
      result: `HTTP ${upstream.status}`,
    });

    return res.json({
      data: {
        name: fileInfo.name,
        downloadDir: fileInfo.downloadDir,
        status: "synced",
        result: `HTTP ${upstream.status}`,
      },
    });
  } catch (error) {
    const downloadDir = cleanRelativePath(req.body?.downloadDir || "");
    const name = cleanFileName(req.body?.name || "");
    if (downloadDir && name) {
      await setSyncFileState(downloadDir, name, {
        status: "failed",
        result: error?.message || "Sync failed",
      });
    }
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

router.post("/sync/batch/start", async (req, res) => {
  const traceId = crypto.randomUUID();
  try {
    const token = normalizeWhitespace(req.body?.token || "");
    const folderId = normalizeWhitespace(req.body?.folderId || env.kometSyncDefaultFolderId);
    const downloadDir = cleanRelativePath(req.body?.downloadDir || "");
    if (!token) return res.status(400).json({ message: "token is required." });
    if (!folderId) return res.status(400).json({ message: "folderId is required." });
    if (!downloadDir) return res.status(400).json({ message: "downloadDir is required." });

    const targetDir = ensureSafeDownloadDir(downloadDir);
    const exists = await fsp
      .access(targetDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return res.status(404).json({
        message: "downloadDir does not exist.",
        detail: `Directory "downloads/${downloadDir}" was not found on the server. Run a batch download first to create it.`,
      });
    }

    const files = await listDownloadedFiles(targetDir);
    if (!files.length) return res.status(400).json({ message: "No files found in downloadDir." });
    if (files.length > MAX_BATCH_ITEMS) {
      return res.status(400).json({
        message: `File count exceeds max allowed items (${MAX_BATCH_ITEMS}).`,
      });
    }

    const runId = crypto.randomUUID();
    const run = {
      runId,
      traceId,
      state: "running",
      token,
      folderId,
      downloadDir,
      targetDir,
      pathValue: downloadDir,
      total: files.length,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      items: files
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry, index) => ({
          itemId: crypto.randomUUID(),
          index: index + 1,
          name: entry.name,
          filePath: entry.filePath,
          status: "queued",
          result: null,
          error: null,
          startedAt: null,
          completedAt: null,
        })),
    };

    for (const item of run.items) {
      // eslint-disable-next-line no-await-in-loop
      await setSyncFileState(downloadDir, item.name, {
        status: "queued",
        result: "Queued for bulk sync",
      });
    }

    await upsertSyncRun(run);
    setImmediate(async () => {
      try {
        await processSyncRun(run);
      } catch (error) {
        run.state = "failed";
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await upsertSyncRun(run);
        logKometError("sync.batch.fatal", error, { runId: run.runId });
      }
    });

    return res.json({
      data: {
        runId,
        total: run.total,
        state: run.state,
      },
      debug: { traceId },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
      debug: { traceId },
    });
  }
});

router.get("/raw-files", async (req, res) => {
  try {
    const dir = cleanRelativePath(req.query?.dir || "");

    let targetDir;
    if (!dir) {
      targetDir = DOWNLOAD_ROOT;
    } else {
      if (!isSafeSegment(dir)) {
        return res.status(400).json({ message: "dir must be a relative safe path under downloads/." });
      }
      targetDir = path.resolve(DOWNLOAD_ROOT, dir);
      if (targetDir !== DOWNLOAD_ROOT && !targetDir.startsWith(`${DOWNLOAD_ROOT}${path.sep}`)) {
        return res.status(400).json({ message: "dir escapes downloads/ root." });
      }
    }

    const exists = await fsp
      .access(targetDir)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      return res.json({
        data: { dir, entries: [], totalEntries: 0, exists: false },
      });
    }

    const dirents = await fsp.readdir(targetDir, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
      const name = cleanFileName(dirent.name);
      if (!name) continue;
      const fullPath = path.join(targetDir, dirent.name);
      const isDir = dirent.isDirectory();
      const isFile = dirent.isFile();
      if (!isDir && !isFile) continue;

      // eslint-disable-next-line no-await-in-loop
      const stat = await fsp.stat(fullPath);
      const relPath = dir ? `${dir}/${name}` : name;

      entries.push({
        name,
        type: isDir ? "dir" : "file",
        bytes: isFile ? stat.size : null,
        modifiedAt: stat.mtime.toISOString(),
        relPath,
        downloadUrl: isFile
          ? `./api/komet-download/raw-files/download?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`
          : null,
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return res.json({
      data: { dir, entries, totalEntries: entries.length, exists: true },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

router.get("/raw-files/download", async (req, res) => {
  try {
    const dir = cleanRelativePath(req.query?.dir || "");
    const name = cleanFileName(req.query?.name || "");

    if (!name) return res.status(400).json({ message: "name is required." });

    let targetDir;
    if (!dir) {
      targetDir = DOWNLOAD_ROOT;
    } else {
      if (!isSafeSegment(dir)) {
        return res.status(400).json({ message: "dir must be a relative safe path." });
      }
      targetDir = path.resolve(DOWNLOAD_ROOT, dir);
      if (targetDir !== DOWNLOAD_ROOT && !targetDir.startsWith(`${DOWNLOAD_ROOT}${path.sep}`)) {
        return res.status(400).json({ message: "dir escapes downloads/ root." });
      }
    }

    const filePath = path.resolve(targetDir, name);
    if (!filePath.startsWith(`${DOWNLOAD_ROOT}${path.sep}`)) {
      return res.status(400).json({ message: "Invalid file path." });
    }

    const exists = await fsp
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return res.status(404).json({ message: "File not found." });

    return res.download(filePath, name);
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

router.get("/sync/batch/:runId/status", async (req, res) => {
  const runId = normalizeWhitespace(req.params?.runId || "");
  const run = await getSyncRun(runId);
  if (!run) return res.status(404).json({ message: "runId not found." });

  const page = parsePage(req.query?.page, 1);
  const limit = parseLimit(req.query?.limit, 25);
  const paged = paginate(run.items, page, limit);
  return res.json({
    data: {
      summary: {
        ...toSyncRunSummary(run),
      },
      items: paged.items.map((item) => toSyncRunItemResponse(item)),
      page: paged.page,
      limit: paged.limit,
      totalItems: paged.totalItems,
      totalPages: paged.totalPages,
    },
  });
});

setImmediate(() => {
  resumeRunningBatchWorkers().catch((error) => {
    logKometError("batch.recovery.fatal", error);
  });
});

module.exports = router;
