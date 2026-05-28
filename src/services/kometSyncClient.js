const path = require("path");
const { request, createMultipartFields } = require("./externalHttpClient");
const env = require("../config/env");

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toBearerToken(rawToken) {
  const token = normalizeWhitespace(rawToken);
  if (!token) return "";
  if (/^bearer\s+/i.test(token)) return token;
  return `Bearer ${token}`;
}

function inferMimeType(fileName) {
  const ext = String(path.extname(fileName || "")).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".csv") return "text/csv";
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function uploadFileToKometSync({
  token,
  folderId,
  fileName,
  filePath,
  pathValue,
  timeoutMs = 120000,
}) {
  const authorization = toBearerToken(token);
  if (!authorization) {
    throw new Error("token is required.");
  }

  const cleanFolderId = normalizeWhitespace(folderId || env.kometSyncDefaultFolderId);
  if (!cleanFolderId) {
    throw new Error("folderId is required.");
  }

  const cleanFileName = normalizeWhitespace(fileName);
  if (!cleanFileName) {
    throw new Error("fileName is required.");
  }

  const cleanPath = normalizeWhitespace(pathValue);
  if (!cleanPath) {
    throw new Error("pathValue is required.");
  }

  return request({
    method: "POST",
    endpoint: env.kometSyncUploadEndpoint,
    headers: {
      Authorization: authorization,
      accept: "text/plain",
    },
    httpPost: createMultipartFields(
      {
        FolderId: cleanFolderId,
        FileName: cleanFileName,
        Path: cleanPath,
      },
      {
        fieldName: "File",
        filePath,
        fileName: cleanFileName,
        mimeType: inferMimeType(cleanFileName),
      }
    ),
    timeoutMs,
  });
}

module.exports = {
  uploadFileToKometSync,
};
