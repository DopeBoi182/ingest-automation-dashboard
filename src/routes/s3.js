const express = require("express");
const Job = require("../models/Job");
const { getOrCreateGlobalSetting } = require("../utils/settings");
const { submitExtractJob } = require("../services/ingestorClient");
const { listObjectKeys, buildUrlForKey, validateS3Config } = require("../services/s3Client");
const env = require("../config/env");

const router = express.Router();

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

async function getActiveProcessingJob() {
  return Job.findOne({ queue_status: "processing" }).sort({ started_at: 1, createdAt: 1 });
}

async function getNextQueuedJob() {
  return Job.findOne({ queue_status: "queued" }).sort({ queue_order: 1, createdAt: 1 });
}

async function startQueueItem(item, setting) {
  try {
    const remote = await submitExtractJob(item.file_url, setting);
    const patch = mapRemoteToJobPatch(item.file_url, remote, "processing");
    return Job.findByIdAndUpdate(
      item._id,
      {
        $set: {
          ...patch,
          queue_status: "processing",
          started_at: new Date(),
          finished_at: null,
          queue_order: null,
        },
      },
      { new: true }
    );
  } catch (error) {
    return Job.findByIdAndUpdate(
      item._id,
      {
        $set: {
          status: "failed",
          queue_status: "failed",
          stage: "extract_failed",
          error: error.response?.data ? JSON.stringify(error.response.data) : error.message,
          finished_at: new Date(),
        },
      },
      { new: true }
    );
  }
}

async function startNextQueuedJob() {
  const active = await getActiveProcessingJob();
  if (active) return { started: false, reason: "already_processing", active };

  const setting = await getOrCreateGlobalSetting();
  while (true) {
    const nextJob = await getNextQueuedJob();
    if (!nextJob) return { started: false, reason: "queue_empty" };

    const startedJob = await startQueueItem(nextJob, setting);
    if (startedJob.queue_status === "processing") return { started: true, job: startedJob };
  }
}

router.get("/health", (_req, res) => {
  try {
    validateS3Config();
    res.json({
      data: {
        ok: true,
        provider: env.s3Provider,
        bucket: env.s3Bucket,
        endpoint: env.s3ServiceUrl,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
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

    if (!["presigned", "public"].includes(mode)) {
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

    if (!keys.length) {
      return res.status(400).json({ message: "keys is required as a non-empty array." });
    }
    if (!["presigned", "public"].includes(mode)) {
      return res.status(400).json({ message: "mode must be 'presigned' or 'public'." });
    }

    const urls = await Promise.all(keys.map((key) => buildUrlForKey({ key, mode, ttlSeconds })));

    const maxOrderDoc = await Job.findOne({ queue_order: { $ne: null } })
      .sort({ queue_order: -1 })
      .select({ queue_order: 1 });
    let nextOrder = maxOrderDoc?.queue_order ?? 0;

    const docs = urls.map((url) => {
      nextOrder += 1;
      return {
        file_url: url,
        status: "queued",
        stage: "queued",
        progress: 0,
        queue_status: "queued",
        queue_order: nextOrder,
      };
    });

    const created = await Job.insertMany(docs, { ordered: true });
    const trigger = await startNextQueuedJob();

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
    next(error);
  }
});

module.exports = router;
