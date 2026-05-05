const express = require("express");
const axios = require("axios");
const env = require("../config/env");

const router = express.Router();

const HEALTH_PATHS = [
  "/api/v1/health",
  "/api/v1/health/redis",
  "/api/v1/health/readiness",
  "/api/v1/health/readiness?strict=true",
  "/api/v1/health/vdb",
];

const client = axios.create({
  baseURL: env.externalBaseUrl,
  timeout: env.requestTimeoutMs,
  validateStatus: () => true,
});

function logHealthInfo(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(`[HealthChecker] ${action}`, meta);
}

function logHealthError(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error(`[HealthChecker] ${action} failed`, {
    ...meta,
    message: error?.message,
    status: error?.response?.status || error?.status,
    detail: error?.response?.data,
  });
}

async function checkOne(path) {
  const startedAt = Date.now();
  try {
    const response = await client.get(path);
    const latencyMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 300;
    const result = {
      path,
      ok,
      statusCode: response.status,
      latencyMs,
      data: response.data,
      error: ok ? null : `HTTP ${response.status}`,
    };
    logHealthInfo("checkOne.result", {
      path,
      ok,
      statusCode: response.status,
      latencyMs,
    });
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    logHealthError("checkOne", error, { path, latencyMs });
    return {
      path,
      ok: false,
      statusCode: error?.response?.status || null,
      latencyMs,
      data: null,
      error: error?.message || "Request failed",
    };
  }
}

router.get("/", async (_req, res) => {
  logHealthInfo("GET /api/healthchecker.begin", {
    baseUrl: env.externalBaseUrl,
    totalChecks: HEALTH_PATHS.length,
  });

  const checks = await Promise.all(HEALTH_PATHS.map((path) => checkOne(path)));
  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;

  logHealthInfo("GET /api/healthchecker.complete", {
    total: checks.length,
    passed,
    failed,
  });

  res.json({
    data: {
      baseUrl: env.externalBaseUrl,
      checks,
      summary: {
        total: checks.length,
        passed,
        failed,
      },
    },
  });
});

module.exports = router;
