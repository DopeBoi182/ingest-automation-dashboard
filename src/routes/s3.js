const express = require("express");
const { getOrCreateGlobalSetting } = require("../utils/settings");
const { submitExtractJob } = require("../services/ingestorClient");
const {
  listObjectKeys,
  listObjects,
  buildUrlForKey,
  validateS3Config,
  checkS3Connectivity,
} = require("../services/s3Client");
const env = require("../config/env");
const {
  getActiveProcessingJob,
  getNextQueuedJob,
  createQueuedJobsFromUrls,
  updateJobById,
} = require("../storage/jobRepository");

const router = express.Router();

function logS3Info(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(`[S3][routes] ${action}`, meta);
}

function logS3Error(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error(`[S3][routes] ${action} failed`, {
    ...meta,
    message: error?.message,
    status: error?.response?.status || error?.status,
    detail: error?.response?.data,
  });
}

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function isFileLikeKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return false;
  if (normalized.endsWith("/")) return false;
  const lastSegment = normalized.split("/").pop() || "";
  return Boolean(lastSegment.trim());
}

function normalizeQueueStatus(remoteStatus, fallback = "processing") {
  const status = String(remoteStatus || "").toLowerCase();
  if (status === "completed") return "completed";
  if (["failed", "error"].includes(status)) return "failed";
  if (["canceled", "cancelled"].includes(status)) return "canceled";
  return fallback;
}

function fromUnixSeconds(value) {
  if (!value) return null;
  return new Date(Number(value) * 1000);
}

function mapRemoteToJobPatch(fileUrl, payload, fallbackQueueStatus = "processing") {
  const queueStatus = normalizeQueueStatus(payload.status, fallbackQueueStatus);
  return {
    file_url: fileUrl,
    job_id: payload.job_id || null,
    status: payload.status || "created",
    stage: payload.stage || "",
    progress: payload.progress ?? 0,
    resource_key: payload.resource_key || "",
    error: payload.error || null,
    raw_response: payload,
    created_at_remote: fromUnixSeconds(payload.created_at),
    updated_at_remote: fromUnixSeconds(payload.updated_at),
    queue_status: queueStatus,
    started_at: queueStatus === "processing" ? new Date() : null,
    finished_at: ["completed", "failed", "canceled"].includes(queueStatus) ? new Date() : null,
  };
}

async function startQueueItem(item, setting) {
  logS3Info("startQueueItem.begin", {
    queueId: String(item?._id || ""),
    fileUrl: item?.file_url || "",
  });
  try {
    const remote = await submitExtractJob(item.file_url, setting);
    const patch = mapRemoteToJobPatch(item.file_url, remote, "processing");
    const updated = await updateJobById(item._id, {
      ...patch,
      queue_status: "processing",
      started_at: new Date(),
      finished_at: null,
      queue_order: null,
    });
    logS3Info("startQueueItem.success", {
      queueId: String(item?._id || ""),
      jobId: updated?.job_id || "",
      status: updated?.status || "",
    });
    return updated;
  } catch (error) {
    logS3Error("startQueueItem", error, {
      queueId: String(item?._id || ""),
      fileUrl: item?.file_url || "",
    });
    return updateJobById(item._id, {
      status: "failed",
      queue_status: "failed",
      stage: "extract_failed",
      error: error.response?.data ? JSON.stringify(error.response.data) : error.message,
      finished_at: new Date(),
    });
  }
}

async function startNextQueuedJob() {
  const active = await getActiveProcessingJob();
  if (active) {
    logS3Info("startNextQueuedJob.skip", {
      reason: "already_processing",
      activeJobId: active.job_id || "",
    });
    return { started: false, reason: "already_processing", active };
  }

  const setting = await getOrCreateGlobalSetting();
  while (true) {
    const nextJob = await getNextQueuedJob();
    if (!nextJob) {
      logS3Info("startNextQueuedJob.skip", { reason: "queue_empty" });
      return { started: false, reason: "queue_empty" };
    }

    const startedJob = await startQueueItem(nextJob, setting);
    if (startedJob.queue_status === "processing") {
      logS3Info("startNextQueuedJob.success", {
        queueId: String(nextJob?._id || ""),
        jobId: startedJob?.job_id || "",
      });
      return { started: true, job: startedJob };
    }
  }
}

router.get("/health", (_req, res) => {
  try {
    logS3Info("GET /health.begin");
    validateS3Config();
    logS3Info("GET /health.success", {
      provider: env.s3Provider,
      bucket: env.s3Bucket,
      endpoint: env.s3ServiceUrl,
    });
    res.json({
      data: {
        ok: true,
        provider: env.s3Provider,
        bucket: env.s3Bucket,
        endpoint: env.s3ServiceUrl,
      },
    });
  } catch (error) {
    logS3Error("GET /health", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/health/live", async (_req, res) => {
  try {
    logS3Info("GET /health/live.begin");
    const result = await checkS3Connectivity();
    if (!result.ok) {
      logS3Info("GET /health/live.fail", {
        bucket: result.bucket,
        endpoint: result.endpoint,
        tlsMode: result.tlsMode,
      });
      return res.status(503).json({
        message: "S3 connectivity check failed",
        detail: result.error?.message || "Unknown S3 connectivity error",
        data: result,
      });
    }

    logS3Info("GET /health/live.success", {
      bucket: result.bucket,
      endpoint: result.endpoint,
      latencyMs: result.latencyMs,
      tlsMode: result.tlsMode,
    });
    return res.json({ data: result });
  } catch (error) {
    logS3Error("GET /health/live", error);
    return res.status(500).json({
      message: "Failed to perform S3 connectivity check",
      detail: error?.message || "Unexpected error",
    });
  }
});

router.get("/files/urls", async (req, res, next) => {
  try {
    const prefix = String(req.query.prefix || "");
    const maxKeys = toNumber(req.query.maxKeys, 1000);
    const mode = String(req.query.mode || "presigned").toLowerCase();
    const ttlSeconds = toNumber(req.query.ttlSeconds, env.s3PresignTtlSeconds);
    const continuationToken = req.query.continuationToken
      ? String(req.query.continuationToken)
      : undefined;
    logS3Info("GET /files/urls.begin", {
      prefix,
      maxKeys,
      mode,
      ttlSeconds,
      hasContinuationToken: Boolean(continuationToken),
    });

    if (!["presigned", "public"].includes(mode)) {
      logS3Info("GET /files/urls.invalid_mode", { mode });
      return res.status(400).json({ message: "mode must be 'presigned' or 'public'." });
    }

    const listed = await listObjectKeys({ prefix, maxKeys, continuationToken });
    const files = await Promise.all(
      listed.keys.filter(isFileLikeKey).map(async (key) => ({
        key,
        mode,
        url: await buildUrlForKey({ key, mode, ttlSeconds }),
      }))
    );
    logS3Info("GET /files/urls.success", {
      prefix,
      requestedMaxKeys: maxKeys,
      listedCount: listed.keys.length,
      fileCount: files.length,
      isTruncated: listed.isTruncated,
      hasNextContinuationToken: Boolean(listed.nextContinuationToken),
    });

    return res.json({
      data: {
        prefix,
        mode,
        ttlSeconds,
        count: files.length,
        isTruncated: listed.isTruncated,
        nextContinuationToken: listed.nextContinuationToken,
        files,
      },
    });
  } catch (error) {
    logS3Error("GET /files/urls", error, {
      prefix: String(req.query.prefix || ""),
      mode: String(req.query.mode || "presigned").toLowerCase(),
    });
    next(error);
  }
});

router.get("/files", async (req, res, next) => {
  try {
    const prefix = String(req.query.prefix || "");
    const maxKeys = toNumber(req.query.maxKeys, 1000);
    const dataMode = String(req.query.dataMode || "keys").toLowerCase();
    const mode = String(req.query.mode || "presigned").toLowerCase();
    const ttlSeconds = toNumber(req.query.ttlSeconds, env.s3PresignTtlSeconds);
    const continuationToken = req.query.continuationToken
      ? String(req.query.continuationToken)
      : undefined;
    logS3Info("GET /files.begin", {
      prefix,
      maxKeys,
      dataMode,
      mode,
      ttlSeconds,
      hasContinuationToken: Boolean(continuationToken),
    });

    if (!["keys", "full"].includes(dataMode)) {
      logS3Info("GET /files.invalid_data_mode", { dataMode });
      return res.status(400).json({ message: "dataMode must be 'keys' or 'full'." });
    }
    if (!["presigned", "public"].includes(mode)) {
      logS3Info("GET /files.invalid_mode", { mode });
      return res.status(400).json({ message: "mode must be 'presigned' or 'public'." });
    }

    const listed = await listObjects({ prefix, maxKeys, continuationToken });
    const fileItems = listed.objects.filter((item) => isFileLikeKey(item.key));
    const files = await Promise.all(
      fileItems.map(async (item) => {
        const generatedUrl = await buildUrlForKey({ key: item.key, mode, ttlSeconds });
        if (dataMode === "keys") {
          return {
            key: item.key,
            mode,
            url: generatedUrl,
          };
        }
        return {
          key: item.key,
          mode,
          url: generatedUrl,
          size: item.size,
          lastModified: item.lastModified,
          etag: item.etag,
          storageClass: item.storageClass,
        };
      })
    );

    logS3Info("GET /files.success", {
      prefix,
      requestedMaxKeys: maxKeys,
      dataMode,
      mode,
      ttlSeconds,
      listedCount: listed.objects.length,
      fileCount: files.length,
      isTruncated: listed.isTruncated,
      hasNextContinuationToken: Boolean(listed.nextContinuationToken),
    });

    return res.json({
      data: {
        prefix,
        dataMode,
        mode,
        ttlSeconds,
        count: files.length,
        isTruncated: listed.isTruncated,
        nextContinuationToken: listed.nextContinuationToken,
        files,
      },
    });
  } catch (error) {
    logS3Error("GET /files", error, {
      prefix: String(req.query.prefix || ""),
      dataMode: String(req.query.dataMode || "keys").toLowerCase(),
      mode: String(req.query.mode || "presigned").toLowerCase(),
    });
    next(error);
  }
});

router.post("/ingest", async (req, res, next) => {
  try {
    const keys = Array.isArray(req.body?.keys)
      ? req.body.keys.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const mode = String(req.body?.mode || "presigned").toLowerCase();
    const ttlSeconds = toNumber(req.body?.ttlSeconds, env.s3PresignTtlSeconds);
    logS3Info("POST /ingest.begin", {
      keyCount: keys.length,
      mode,
      ttlSeconds,
    });

    if (!keys.length) {
      logS3Info("POST /ingest.invalid_keys");
      return res.status(400).json({ message: "keys is required as a non-empty array." });
    }
    if (!["presigned", "public"].includes(mode)) {
      logS3Info("POST /ingest.invalid_mode", { mode });
      return res.status(400).json({ message: "mode must be 'presigned' or 'public'." });
    }

    const urls = await Promise.all(keys.map((key) => buildUrlForKey({ key, mode, ttlSeconds })));

    const created = await createQueuedJobsFromUrls(urls);
    const trigger = await startNextQueuedJob();
    logS3Info("POST /ingest.success", {
      mode,
      ttlSeconds,
      keyCount: keys.length,
      queuedCount: created.length,
      triggerStarted: Boolean(trigger?.started),
      triggerReason: trigger?.reason || "",
    });

    return res.json({
      data: {
        mode,
        ttlSeconds,
        count: created.length,
        keys,
        urls,
        queue: created,
        trigger,
      },
    });
  } catch (error) {
    logS3Error("POST /ingest", error, {
      keyCount: Array.isArray(req.body?.keys) ? req.body.keys.length : 0,
      mode: String(req.body?.mode || "presigned").toLowerCase(),
    });
    next(error);
  }
});

module.exports = router;
