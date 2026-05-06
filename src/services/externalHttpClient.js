const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const env = require("../config/env");

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function buildUrl(endpoint) {
  const raw = String(endpoint || "").trim();
  if (!raw) {
    throw new Error("endpoint is required.");
  }
  if (isAbsoluteUrl(raw)) return raw;
  return new URL(raw, env.externalBaseUrl).toString();
}

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (!key || value === undefined || value === null) return acc;
    acc[key] = String(value);
    return acc;
  }, {});
}

function tryParseJson(payload) {
  const raw = String(payload || "").trim();
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildHttpError({ method, url, response }) {
  const message =
    typeof response?.data === "string" && response.data
      ? response.data
      : `HTTP ${response?.status || 500} for ${method} ${url}`;
  const error = new Error(message);
  error.status = response?.status || 500;
  error.response = response;
  return error;
}

function getRequestModule(urlObject) {
  return urlObject.protocol === "https:" ? https : http;
}

function toMultipartFieldEntries(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({
      name,
      value: String(value),
    }));
}

function createBoundary() {
  return `----automation-ai-ingestion-${crypto.randomBytes(12).toString("hex")}`;
}

function waitForDrainIfNeeded(req, canContinueWriting) {
  if (canContinueWriting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    req.once("drain", resolve);
    req.once("error", reject);
  });
}

async function writePart(req, chunk) {
  const continueWriting = req.write(chunk);
  await waitForDrainIfNeeded(req, continueWriting);
}

async function writeMultipartBody(req, multipart, boundary) {
  const fields = Array.isArray(multipart?.fields) ? multipart.fields : [];
  const filePart = multipart?.file || null;

  for (const field of fields) {
    await writePart(req, `--${boundary}\r\n`);
    await writePart(req, `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`);
    await writePart(req, `${field.value}\r\n`);
  }

  if (filePart?.filePath) {
    const fileName = filePart.fileName || path.basename(filePart.filePath);
    const mimeType = filePart.mimeType || "application/octet-stream";
    await writePart(req, `--${boundary}\r\n`);
    await writePart(
      req,
      `Content-Disposition: form-data; name="${filePart.fieldName || "file"}"; filename="${fileName}"\r\n`
    );
    await writePart(req, `Content-Type: ${mimeType}\r\n\r\n`);

    const fileStream = fs.createReadStream(filePart.filePath);
    for await (const chunk of fileStream) {
      await writePart(req, chunk);
    }
    await writePart(req, "\r\n");
  }

  await writePart(req, `--${boundary}--\r\n`);
}

function normalizeMultipart(httpPost) {
  if (!httpPost) return null;
  const fields = Array.isArray(httpPost.fields) ? httpPost.fields : [];
  const file = httpPost.file || null;
  return { fields, file };
}

function request({
  method = "GET",
  endpoint,
  headers = {},
  body,
  httpPost,
  timeoutMs = env.requestTimeoutMs,
  throwOnHttpError = true,
}) {
  const httpMethod = String(method || "GET").toUpperCase();
  const url = buildUrl(endpoint);
  const urlObject = new URL(url);
  const requestModule = getRequestModule(urlObject);
  const requestHeaders = { ...headers };
  let payload = body;
  const multipart = normalizeMultipart(httpPost);

  if (multipart) {
    const boundary = createBoundary();
    requestHeaders["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    payload = { boundary, multipart };
  } else if (
    payload !== undefined &&
    payload !== null &&
    !Buffer.isBuffer(payload) &&
    typeof payload !== "string"
  ) {
    payload = JSON.stringify(payload);
    if (!requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }
  }

  const normalizedHeaders = normalizeHeaders(requestHeaders);

  return new Promise((resolve, reject) => {
    const req = requestModule.request(
      {
        protocol: urlObject.protocol,
        hostname: urlObject.hostname,
        port: urlObject.port || undefined,
        path: `${urlObject.pathname}${urlObject.search}`,
        method: httpMethod,
        headers: normalizedHeaders,
      },
      async (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const response = {
            status: res.statusCode || 0,
            data: tryParseJson(raw),
            headers: res.headers || {},
          };

          if (throwOnHttpError && response.status >= 400) {
            reject(buildHttpError({ method: httpMethod, url, response }));
            return;
          }

          resolve(response);
        });
      }
    );

    const effectiveTimeoutMs = Number(timeoutMs);
    if (Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0) {
      req.setTimeout(effectiveTimeoutMs, () => {
        req.destroy(new Error(`Request timeout after ${effectiveTimeoutMs}ms`));
      });
    }

    req.on("error", (err) => {
      const error = new Error(err?.message || "Request failed");
      error.code = err?.code;
      reject(error);
    });

    (async () => {
      try {
        if (payload?.boundary && payload?.multipart) {
          await writeMultipartBody(req, payload.multipart, payload.boundary);
          req.end();
          return;
        }

        if (payload !== undefined && payload !== null) {
          req.end(payload);
          return;
        }

        req.end();
      } catch (error) {
        req.destroy(error);
      }
    })().catch((error) => {
      req.destroy(error);
    });
  });
}

function createMultipartFields(fields = {}, filePart = null) {
  const multipart = {
    fields: toMultipartFieldEntries(fields),
    file: null,
  };

  if (filePart?.filePath) {
    multipart.file = {
      fieldName: filePart.fieldName || "file",
      filePath: filePart.filePath,
      fileName: filePart.fileName || path.basename(filePart.filePath),
      mimeType: filePart.mimeType || "application/octet-stream",
    };
  }

  return multipart;
}

module.exports = {
  request,
  createMultipartFields,
};
