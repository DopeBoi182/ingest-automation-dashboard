const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const express = require("express");

const router = express.Router();

const DOWNLOAD_ROOT = path.resolve(process.cwd(), "downloads");

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
  const normalizedSinglePath = String(singlePath || "").trim();
  if (!normalizedBaseUrl) throw new Error("baseUrl is required.");
  if (!normalizedSinglePath) throw new Error("singlePath is required.");
  return `${normalizedBaseUrl}${encodeURIComponent(normalizedSinglePath)}`;
}

function ensureFileName(singlePath) {
  const normalized = String(singlePath || "").trim().replaceAll("\\", "/");
  const fileName = path.basename(normalized);
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
    const cookies = String(req.body?.cookies || "").trim();
    const downloadDir = String(req.body?.downloadDir || "").trim();
    const singlePath = String(req.body?.singlePath || "").trim();

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

module.exports = router;
