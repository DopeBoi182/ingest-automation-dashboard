const { Curl } = require("node-libcurl");
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

function toSeconds(timeoutMs, defaultValue) {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(1, Math.ceil(parsed / 1000));
}

function normalizeHeaders(headers = {}) {
  return Object.entries(headers)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`);
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

function request({
  method = "GET",
  endpoint,
  headers = {},
  body,
  httpPost,
  timeoutMs = env.requestTimeoutMs,
  connectTimeoutMs = Math.min(env.requestTimeoutMs, 5000),
  throwOnHttpError = true,
}) {
  const httpMethod = String(method || "GET").toUpperCase();
  const url = buildUrl(endpoint);
  const requestHeaders = { ...headers };
  let payload = body;

  if (
    payload !== undefined &&
    payload !== null &&
    !Buffer.isBuffer(payload) &&
    typeof payload !== "string" &&
    !httpPost
  ) {
    payload = JSON.stringify(payload);
    if (!requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }
  }

  const curlHeaders = normalizeHeaders(requestHeaders);

  return new Promise((resolve, reject) => {
    const curl = new Curl();
    curl.setOpt("URL", url);
    curl.setOpt("CUSTOMREQUEST", httpMethod);
    curl.setOpt("FOLLOWLOCATION", true);
    curl.setOpt("CONNECTTIMEOUT", toSeconds(connectTimeoutMs, 5));
    curl.setOpt("TIMEOUT", toSeconds(timeoutMs, 10));

    if (curlHeaders.length) {
      curl.setOpt("HTTPHEADER", curlHeaders);
    }

    if (httpPost) {
      curl.setOpt("HTTPPOST", httpPost);
    } else if (payload !== undefined && payload !== null) {
      curl.setOpt("POSTFIELDS", payload);
    }

    curl.on("end", function onEnd(statusCode, data, responseHeaders) {
      try {
        const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
        const response = {
          status: statusCode,
          data: tryParseJson(raw),
          headers: responseHeaders || {},
        };

        if (throwOnHttpError && statusCode >= 400) {
          reject(buildHttpError({ method: httpMethod, url, response }));
          return;
        }

        resolve(response);
      } finally {
        this.close();
      }
    });

    curl.on("error", function onError(err, errorCode) {
      const error = new Error(err?.message || "Request failed");
      error.code = err?.code || errorCode;
      reject(error);
      this.close();
    });

    curl.perform();
  });
}

function createMultipartFields(fields = {}, filePart = null) {
  const items = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({
      name,
      contents: String(value),
    }));

  if (filePart?.filePath) {
    const fileEntry = {
      name: filePart.fieldName || "file",
      file: filePart.filePath,
    };
    if (filePart.fileName) fileEntry.filename = filePart.fileName;
    if (filePart.mimeType) fileEntry.type = filePart.mimeType;
    items.push(fileEntry);
  }

  return items;
}

module.exports = {
  request,
  createMultipartFields,
};
