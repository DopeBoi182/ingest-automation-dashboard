const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const express = require("express");

const router = express.Router();

const DOWNLOAD_ROOT = path.resolve(process.cwd(), "downloads");
const REPORT_ROOT = path.resolve(DOWNLOAD_ROOT, "reports");
const MAX_BATCH_ITEMS = 5000;
const MAX_PAGE_SIZE = 200;
const batchRuns = new Map();

function logKometInfo(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log("[KometDownload]", {
    at: new Date().toISOString(),
    level: "info",
    action,
    ...meta,
  });
}

function logKometError(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error("[KometDownload]", {
    at: new Date().toISOString(),
    level: "error",
    action,
    message: error?.message || "Unknown error",
    detail: error?.detail || null,
    status: error?.status || null,
    ...meta,
  });
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

function toRunSummary(run) {
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

function toRunItemResponse(runId, item) {
  const canDownload = item.status === "downloaded" && item.savedPath;
  return {
    itemId: item.itemId,
    index: item.index,
    relativePath: item.relativePath,
    status: item.status,
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

async function processBatchRun(run) {
  logKometInfo("batch.start", {
    runId: run.runId,
    total: run.total,
    downloadDir: run.downloadDirRaw,
  });

  for (const item of run.items) {
    item.status = "processing";
    item.startedAt = new Date().toISOString();

    try {
      const fileName = ensureFileName(item.relativePath);
      const targetPath = path.join(run.targetDir, fileName);
      const alreadyExists = await fsp
        .access(targetPath)
        .then(() => true)
        .catch(() => false);

      if (alreadyExists) {
        item.status = "skipped";
        item.savedAs = fileName;
        item.savedPath = targetPath;
        item.skipReason = "already_exists";
        run.skipped += 1;
      } else {
        const url = buildDownloadUrl(run.baseUrl, item.relativePath);
        const result = await downloadBinaryToFile({
          url,
          cookieHeader: run.cookies,
          targetPath,
          timeoutMs: 30000,
        });
        item.status = "downloaded";
        item.savedAs = fileName;
        item.savedPath = targetPath;
        item.bytes = result.bytes;
        run.success += 1;
      }
    } catch (error) {
      item.status = "failed";
      item.error = error?.detail || error?.message || "Unexpected download error";
      run.failed += 1;
      logKometError("batch.item.failed", error, {
        runId: run.runId,
        index: item.index,
        relativePath: item.relativePath,
      });
    } finally {
      item.completedAt = new Date().toISOString();
      run.processed += 1;
      run.updatedAt = item.completedAt;
    }
  }

  run.completedAt = new Date().toISOString();
  run.state = "completed";

  const successRows = run.items.filter((item) => item.status === "downloaded");
  const failedRows = run.items.filter((item) => item.status === "failed");
  const skippedRows = run.items.filter((item) => item.status === "skipped");

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

  logKometInfo("batch.complete", {
    runId: run.runId,
    total: run.total,
    processed: run.processed,
    success: run.success,
    failed: run.failed,
    skipped: run.skipped,
    reportPaths: run.reportPaths,
  });
}

function downloadBinaryToFile({ url, cookieHeader, targetPath, timeoutMs = 30000 }) {
  const urlObject = new URL(url);
  const requestModule = urlObject.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
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
          res.on("end", () => {
            const upstreamBody = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
            reject(
              Object.assign(new Error(`Upstream HTTP ${statusCode}`), {
                status: statusCode,
                detail: upstreamBody || "Upstream request failed.",
                contentType,
              })
            );
          });
          return;
        }

        const fileStream = fs.createWriteStream(targetPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(async () => {
            try {
              const stat = await fsp.stat(targetPath);
              resolve({
                statusCode,
                contentType,
                bytes: stat.size,
              });
            } catch (error) {
              reject(error);
            }
          });
        });

        fileStream.on("error", async (error) => {
          try {
            await fsp.unlink(targetPath);
          } catch {
            // ignore cleanup error
          }
          reject(error);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

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

    if (!baseUrl) return res.status(400).json({ message: "baseUrl is required." });
    if (!cookies) return res.status(400).json({ message: "cookies is required." });
    if (!downloadDir) return res.status(400).json({ message: "downloadDir is required." });
    if (!paths.length) return res.status(400).json({ message: "paths is required." });
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
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      reportPaths: null,
      items: paths.map((item, index) => ({
        itemId: crypto.randomUUID(),
        index: index + 1,
        relativePath: item,
        status: "queued",
        error: null,
        skipReason: null,
        savedAs: null,
        savedPath: null,
        bytes: 0,
        startedAt: null,
        completedAt: null,
      })),
    };

    batchRuns.set(runId, run);
    setImmediate(async () => {
      try {
        await processBatchRun(run);
      } catch (error) {
        run.state = "failed";
        run.completedAt = new Date().toISOString();
        logKometError("batch.fatal", error, { runId: run.runId });
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

router.get("/batch/:runId/status", async (req, res) => {
  const runId = String(req.params?.runId || "").trim();
  const run = batchRuns.get(runId);
  if (!run) {
    return res.status(404).json({ message: "runId not found." });
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
  const run = batchRuns.get(runId);
  if (!run) {
    return res.status(404).json({ message: "runId not found." });
  }

  const item = run.items.find((row) => row.itemId === itemId);
  if (!item || !item.savedPath || item.status !== "downloaded") {
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
    const downloadDir = String(req.query?.downloadDir || "").trim();
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

    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const fullPath = path.join(targetDir, name);
      // eslint-disable-next-line no-await-in-loop
      const stat = await fsp.stat(fullPath);
      files.push({
        name,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        downloadUrl: `./api/komet-download/downloaded/file?downloadDir=${encodeURIComponent(
          downloadDir
        )}&name=${encodeURIComponent(name)}`,
      });
    }

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
    const downloadDir = String(req.query?.downloadDir || "").trim();
    const name = normalizeWhitespace(req.query?.name || "");
    if (!downloadDir) return res.status(400).json({ message: "downloadDir is required." });
    if (!name) return res.status(400).json({ message: "name is required." });

    const targetDir = ensureSafeDownloadDir(downloadDir);
    const filePath = path.resolve(targetDir, name);
    if (filePath !== targetDir && !filePath.startsWith(`${targetDir}${path.sep}`)) {
      return res.status(400).json({ message: "Invalid file path." });
    }
    return res.download(filePath, name);
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: "Request failed",
      detail: error?.detail || error?.message || "Unexpected server error",
    });
  }
});

module.exports = router;
