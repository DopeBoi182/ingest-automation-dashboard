const express = require("express");
const fs = require("fs");
const multer = require("multer");
const env = require("../config/env");
const { getOrCreateGlobalSetting } = require("../utils/settings");
const {
  submitExtractJob,
  submitExtractJobWithFile,
  getJobStatus,
  cancelJob,
} = require("../services/ingestorClient");
const {
  getAllJobs,
  getQueuedJobs,
  getFinishedJobs,
  getJobsWithRemoteId,
  getByJobId,
  getQueuedById,
  getActiveProcessingJob,
  getNextQueuedJob,
  createQueuedJobsFromUrls,
  createQueuedJobsFromFiles,
  updateJobById,
  deleteQueuedById,
  clearQueuedJobs,
} = require("../storage/jobRepository");

const router = express.Router();
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "cancelled", "error"]);
const uploadDir = env.uploadDir;
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

function logJobsInfo(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(`[JobsFlow] ${action}`, meta);
}

function logJobsError(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error(`[JobsFlow] ${action} failed`, {
    ...meta,
    message: error?.message,
    status: error?.response?.status || error?.status,
    detail: error?.response?.data,
  });
}

function parseUrlInput(urls) {
  if (Array.isArray(urls)) return urls.map((x) => String(x).trim()).filter(Boolean);
  return String(urls || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function fromUnixSeconds(value) {
  if (!value) return null;
  return new Date(Number(value) * 1000);
}

function normalizeQueueStatus(remoteStatus, fallback = "processing") {
  const status = String(remoteStatus || "").toLowerCase();
  if (status === "completed") return "completed";
  if (["failed", "error"].includes(status)) return "failed";
  if (["canceled", "cancelled"].includes(status)) return "canceled";
  return fallback;
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

async function cleanupUploadedFile(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return;
  try {
    await fs.promises.unlink(normalized);
    logJobsInfo("cleanupUploadedFile.success", { filePath: normalized });
  } catch (error) {
    if (error.code !== "ENOENT") {
      logJobsError("cleanupUploadedFile", error, { filePath: normalized });
    }
  }
}

async function cleanupUploadedFiles(files) {
  const allFiles = Array.isArray(files) ? files : [];
  await Promise.all(
    allFiles.map((file) => cleanupUploadedFile(file?.path || file?.file_path || ""))
  );
}

function normalizeUploadedFiles(files) {
  return files.map((file) => ({
    file_name: file.originalname || file.filename,
    file_path: file.path,
    file_mime: file.mimetype || "",
    file_size: file.size || 0,
  }));
}

async function startQueueItem(item, setting) {
  const isFileInput = String(item.input_type || "url") === "file";
  logJobsInfo("startQueueItem.begin", {
    queueId: String(item?._id || ""),
    inputType: isFileInput ? "file" : "url",
    source: isFileInput ? item?.file_name || "" : item?.file_url || "",
  });
  try {
    const remote = isFileInput
      ? await submitExtractJobWithFile(item, setting)
      : await submitExtractJob(item.file_url, setting);
    const patch = mapRemoteToJobPatch(item.file_url, remote, "processing");
    const saved = await updateJobById(item._id, {
      ...patch,
      queue_status: "processing",
      started_at: new Date(),
      finished_at: null,
      queue_order: null,
      file_path: isFileInput ? "" : item.file_path || "",
    });
    if (isFileInput) {
      await cleanupUploadedFile(item.file_path);
    }
    logJobsInfo("startQueueItem.success", {
      queueId: String(item?._id || ""),
      inputType: isFileInput ? "file" : "url",
      jobId: saved?.job_id || "",
      queueStatus: saved?.queue_status || "",
      remoteStatus: saved?.status || "",
    });
    return saved;
  } catch (error) {
    logJobsError("startQueueItem", error, {
      queueId: String(item?._id || ""),
      inputType: isFileInput ? "file" : "url",
      source: isFileInput ? item?.file_name || "" : item?.file_url || "",
    });
    const saved = await updateJobById(item._id, {
      status: "failed",
      queue_status: "failed",
      stage: "extract_failed",
      error: error.response?.data ? JSON.stringify(error.response.data) : error.message,
      finished_at: new Date(),
    });
    if (String(item.input_type || "url") === "file") {
      await cleanupUploadedFile(item.file_path);
    }
    return saved;
  }
}

async function startNextQueuedJob({ forcedQueueId = null } = {}) {
  logJobsInfo("startNextQueuedJob.begin", { forcedQueueId: forcedQueueId || "" });
  const active = await getActiveProcessingJob();
  if (active) {
    logJobsInfo("startNextQueuedJob.skip", {
      reason: "already_processing",
      activeJobId: active.job_id || "",
      activeQueueId: String(active._id || ""),
    });
    return { started: false, reason: "already_processing", active };
  }

  const setting = await getOrCreateGlobalSetting();
  let forcedUsed = false;

  while (true) {
    let nextJob = null;
    if (forcedQueueId && !forcedUsed) {
      nextJob = await getQueuedById(forcedQueueId);
      forcedUsed = true;
    }
    if (!nextJob) nextJob = await getNextQueuedJob();
    if (!nextJob) {
      logJobsInfo("startNextQueuedJob.skip", { reason: "queue_empty" });
      return { started: false, reason: "queue_empty" };
    }

    const startedJob = await startQueueItem(nextJob, setting);
    if (startedJob.queue_status === "processing") {
      logJobsInfo("startNextQueuedJob.success", {
        queueId: String(nextJob?._id || ""),
        jobId: startedJob?.job_id || "",
      });
      return { started: true, job: startedJob };
    }
    if (forcedQueueId && forcedUsed) {
      logJobsInfo("startNextQueuedJob.skip", {
        reason: "forced_start_failed",
        queueId: String(nextJob?._id || ""),
      });
      return { started: false, reason: "forced_start_failed", job: startedJob };
    }
  }
}

async function refreshActiveProcessingJob() {
  const active = await getActiveProcessingJob();
  logJobsInfo("refreshActiveProcessingJob.begin", {
    hasActive: Boolean(active),
    activeJobId: active?.job_id || "",
  });
  if (!active) return { active: null, updated: false, nextStarted: false };
  if (!active.job_id) {
    const marked = await updateJobById(active._id, {
      queue_status: "failed",
      status: "failed",
      stage: "missing_job_id",
      error: "Missing remote job_id for processing item.",
      finished_at: new Date(),
    });
    const next = await startNextQueuedJob();
    return { active: marked, updated: true, nextStarted: Boolean(next.started), next };
  }

  try {
    const remote = await getJobStatus(active.job_id);
    const patch = mapRemoteToJobPatch(active.file_url, remote, "processing");
    const isTerminal = TERMINAL_STATUSES.has(String(remote.status || "").toLowerCase());
    const saved = await updateJobById(active._id, {
      ...patch,
      queue_status: normalizeQueueStatus(remote.status, "processing"),
      started_at: active.started_at || new Date(),
      finished_at: isTerminal ? new Date() : null,
      queue_order: null,
    });

    if (!isTerminal) {
      logJobsInfo("refreshActiveProcessingJob.success", {
        activeJobId: active.job_id,
        remoteStatus: remote?.status || "",
        terminal: false,
      });
      return { active: saved, updated: true, nextStarted: false };
    }
    const next = await startNextQueuedJob();
    logJobsInfo("refreshActiveProcessingJob.success", {
      activeJobId: active.job_id,
      remoteStatus: remote?.status || "",
      terminal: true,
      nextStarted: Boolean(next.started),
    });
    return { active: saved, updated: true, nextStarted: Boolean(next.started), next };
  } catch (error) {
    logJobsError("refreshActiveProcessingJob", error, {
      activeJobId: active?.job_id || "",
    });
    return {
      active,
      updated: false,
      nextStarted: false,
      error: error.response?.data || error.message,
    };
  }
}

async function refreshJobById(job) {
  if (!job?.job_id) {
    throw new Error("Job has no remote job_id to refresh.");
  }
  const remote = await getJobStatus(job.job_id);
  const patch = mapRemoteToJobPatch(job.file_url, remote, job.queue_status || "processing");
  const isTerminal = TERMINAL_STATUSES.has(String(remote.status || "").toLowerCase());
  return updateJobById(job._id, {
    ...patch,
    queue_status: normalizeQueueStatus(remote.status, job.queue_status || "processing"),
    started_at: job.started_at || new Date(),
    finished_at: isTerminal ? new Date() : null,
  });
}

router.post("/queue", async (req, res, next) => {
  try {
    const urls = parseUrlInput(req.body?.urls);
    logJobsInfo("POST /queue.begin", { urlCount: urls.length });
    if (!urls.length) {
      return res.status(400).json({ message: "urls is required (comma-separated)." });
    }

    const created = await createQueuedJobsFromUrls(urls);
    const trigger = await startNextQueuedJob();
    logJobsInfo("POST /queue.success", {
      queuedCount: created.length,
      triggerStarted: Boolean(trigger?.started),
      triggerReason: trigger?.reason || "",
    });
    res.json({ data: created, trigger });
  } catch (error) {
    logJobsError("POST /queue", error);
    next(error);
  }
});

router.post("/queue/files", upload.array("file"), async (req, res, next) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    logJobsInfo("POST /queue/files.begin", {
      fileCount: files.length,
      fileNames: files.map((file) => file.originalname || file.filename),
      uploadDir,
    });
    if (!files.length) {
      return res.status(400).json({ message: "file is required as a non-empty upload field." });
    }

    const payload = normalizeUploadedFiles(files);

    const created = await createQueuedJobsFromFiles(payload);
    const trigger = await startNextQueuedJob();
    logJobsInfo("POST /queue/files.success", {
      queuedCount: created.length,
      triggerStarted: Boolean(trigger?.started),
      triggerReason: trigger?.reason || "",
    });
    return res.json({ data: created, trigger });
  } catch (error) {
    logJobsError("POST /queue/files", error, {
      fileCount: Array.isArray(req.files) ? req.files.length : 0,
      uploadDir,
    });
    await cleanupUploadedFiles(req.files);
    next(error);
  }
});

router.post("/ingest/files", upload.array("file"), async (req, res, next) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    logJobsInfo("POST /ingest/files.begin", {
      fileCount: files.length,
      fileNames: files.map((file) => file.originalname || file.filename),
      uploadDir,
    });
    if (!files.length) {
      return res.status(400).json({ message: "file is required as a non-empty upload field." });
    }
    const payload = normalizeUploadedFiles(files);
    const created = await createQueuedJobsFromFiles(payload);
    const trigger = await startNextQueuedJob();
    logJobsInfo("POST /ingest/files.success", {
      queuedCount: created.length,
      triggerStarted: Boolean(trigger?.started),
      triggerReason: trigger?.reason || "",
    });
    return res.json({ data: created, trigger });
  } catch (error) {
    logJobsError("POST /ingest/files", error, {
      fileCount: Array.isArray(req.files) ? req.files.length : 0,
      uploadDir,
    });
    await cleanupUploadedFiles(req.files);
    next(error);
  }
});

router.post("/ingest", async (req, res, next) => {
  try {
    const urls = parseUrlInput(req.body?.urls);
    logJobsInfo("POST /ingest.begin", { urlCount: urls.length });
    if (!urls.length) {
      return res.status(400).json({ message: "urls is required (comma-separated)." });
    }

    const created = await createQueuedJobsFromUrls(urls);
    const trigger = await startNextQueuedJob();
    logJobsInfo("POST /ingest.success", {
      queuedCount: created.length,
      triggerStarted: Boolean(trigger?.started),
      triggerReason: trigger?.reason || "",
    });
    res.json({ data: created, trigger });
  } catch (error) {
    logJobsError("POST /ingest", error);
    next(error);
  }
});

router.get("/process", async (_req, res, next) => {
  try {
    const active = await getActiveProcessingJob();
    res.json({ data: active });
  } catch (error) {
    next(error);
  }
});

router.get("/queue", async (_req, res, next) => {
  try {
    const queued = await getQueuedJobs();
    res.json({ data: queued });
  } catch (error) {
    next(error);
  }
});

router.delete("/queue/:id", async (req, res, next) => {
  try {
    const deleted = await deleteQueuedById(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Queued item not found." });
    }
    return res.json({ data: deleted });
  } catch (error) {
    next(error);
  }
});

router.delete("/queue", async (_req, res, next) => {
  try {
    const result = await clearQueuedJobs();
    return res.json({ data: { deletedCount: result.deletedCount } });
  } catch (error) {
    next(error);
  }
});

router.get("/finished", async (_req, res, next) => {
  try {
    const finished = await getFinishedJobs();
    res.json({ data: finished });
  } catch (error) {
    next(error);
  }
});

router.post("/process/trigger", async (_req, res, next) => {
  try {
    const result = await startNextQueuedJob();
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.post("/process/tick", async (_req, res, next) => {
  try {
    const result = await refreshActiveProcessingJob();
    if (!result.active) {
      const startResult = await startNextQueuedJob();
      return res.json({ data: { ...result, startedFromIdle: startResult } });
    }
    return res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.post("/:jobId/refresh", async (req, res, next) => {
  try {
    const job = await getByJobId(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found." });
    const saved = await refreshJobById(job);
    if (["completed", "failed", "canceled"].includes(saved.queue_status)) {
      await startNextQueuedJob();
    }
    res.json({ data: saved });
  } catch (error) {
    next(error);
  }
});

router.post("/refresh-all", async (_req, res, next) => {
  try {
    const jobs = await getJobsWithRemoteId();
    const results = [];

    for (const job of jobs) {
      try {
        const saved = await refreshJobById(job);
        results.push({ job_id: job.job_id, ok: true, data: saved });
      } catch (error) {
        results.push({
          job_id: job.job_id,
          ok: false,
          error: error.response?.data || error.message,
        });
      }
    }

    await startNextQueuedJob();
    res.json({ data: results });
  } catch (error) {
    next(error);
  }
});

router.post("/queue/:id/force-replace", async (req, res, next) => {
  try {
    const target = await getQueuedById(req.params.id);
    if (!target) return res.status(404).json({ message: "Queued item not found." });

    const active = await getActiveProcessingJob();
    if (active) {
      if (!active.job_id) {
        return res.status(409).json({
          message: "Current processing job has no remote job_id, cannot safely force replace.",
        });
      }

      let remote;
      try {
        remote = await cancelJob(active.job_id);
      } catch (error) {
        return res.status(400).json({
          message: "Failed to cancel current processing job.",
          detail: error.response?.data || error.message,
        });
      }

      const cancelPatch = mapRemoteToJobPatch(active.file_url, remote, "canceled");
      await updateJobById(active._id, {
        ...cancelPatch,
        queue_status: "canceled",
        finished_at: new Date(),
      });
    }
    const queued = await getQueuedJobs();
    const minOrder = queued.length ? Math.min(...queued.map((x) => x.queue_order ?? 1)) : 1;
    const forcedOrder = minOrder - 1;
    await updateJobById(target._id, { queue_order: forcedOrder });

    const started = await startNextQueuedJob({ forcedQueueId: target._id });
    res.json({ data: started });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (_req, res, next) => {
  try {
    const jobs = await getAllJobs();
    res.json({ data: jobs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
