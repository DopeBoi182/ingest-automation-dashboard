const express = require("express");
const Job = require("../models/Job");
const { getOrCreateGlobalSetting } = require("../utils/settings");
const { submitExtractJob, getJobStatus, cancelJob } = require("../services/ingestorClient");

const router = express.Router();
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "cancelled", "error"]);

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

async function startNextQueuedJob({ forcedQueueId = null } = {}) {
  const active = await getActiveProcessingJob();
  if (active) return { started: false, reason: "already_processing", active };

  const setting = await getOrCreateGlobalSetting();
  let forcedUsed = false;

  while (true) {
    let nextJob = null;
    if (forcedQueueId && !forcedUsed) {
      nextJob = await Job.findOne({ _id: forcedQueueId, queue_status: "queued" });
      forcedUsed = true;
    }
    if (!nextJob) nextJob = await getNextQueuedJob();
    if (!nextJob) return { started: false, reason: "queue_empty" };

    const startedJob = await startQueueItem(nextJob, setting);
    if (startedJob.queue_status === "processing") return { started: true, job: startedJob };
    if (forcedQueueId && forcedUsed) return { started: false, reason: "forced_start_failed", job: startedJob };
  }
}

async function refreshActiveProcessingJob() {
  const active = await getActiveProcessingJob();
  if (!active) return { active: null, updated: false, nextStarted: false };
  if (!active.job_id) {
    const marked = await Job.findByIdAndUpdate(
      active._id,
      {
        $set: {
          queue_status: "failed",
          status: "failed",
          stage: "missing_job_id",
          error: "Missing remote job_id for processing item.",
          finished_at: new Date(),
        },
      },
      { new: true }
    );
    const next = await startNextQueuedJob();
    return { active: marked, updated: true, nextStarted: Boolean(next.started), next };
  }

  try {
    const remote = await getJobStatus(active.job_id);
    const patch = mapRemoteToJobPatch(active.file_url, remote, "processing");
    const isTerminal = TERMINAL_STATUSES.has(String(remote.status || "").toLowerCase());
    const saved = await Job.findByIdAndUpdate(
      active._id,
      {
        $set: {
          ...patch,
          queue_status: normalizeQueueStatus(remote.status, "processing"),
          started_at: active.started_at || new Date(),
          finished_at: isTerminal ? new Date() : null,
          queue_order: null,
        },
      },
      { new: true }
    );

    if (!isTerminal) return { active: saved, updated: true, nextStarted: false };
    const next = await startNextQueuedJob();
    return { active: saved, updated: true, nextStarted: Boolean(next.started), next };
  } catch (error) {
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
  return Job.findByIdAndUpdate(
    job._id,
    {
      $set: {
        ...patch,
        queue_status: normalizeQueueStatus(remote.status, job.queue_status || "processing"),
        started_at: job.started_at || new Date(),
        finished_at: isTerminal ? new Date() : null,
      },
    },
    { new: true }
  );
}

router.post("/queue", async (req, res, next) => {
  try {
    const urls = parseUrlInput(req.body?.urls);
    if (!urls.length) {
      return res.status(400).json({ message: "urls is required (comma-separated)." });
    }

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
    res.json({ data: created, trigger });
  } catch (error) {
    next(error);
  }
});

router.post("/ingest", async (req, res, next) => {
  try {
    const urls = parseUrlInput(req.body?.urls);
    if (!urls.length) {
      return res.status(400).json({ message: "urls is required (comma-separated)." });
    }

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
    res.json({ data: created, trigger });
  } catch (error) {
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
    const queued = await Job.find({ queue_status: "queued" }).sort({ queue_order: 1, createdAt: 1 });
    res.json({ data: queued });
  } catch (error) {
    next(error);
  }
});

router.get("/finished", async (_req, res, next) => {
  try {
    const finished = await Job.find({ queue_status: { $in: ["completed", "failed"] } }).sort({
      finished_at: -1,
      updatedAt: -1,
    });
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
    const job = await Job.findOne({ job_id: req.params.jobId });
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
    const jobs = await Job.find({ job_id: { $ne: null } }).sort({ createdAt: 1 });
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
    const target = await Job.findOne({ _id: req.params.id, queue_status: "queued" });
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
      await Job.findByIdAndUpdate(
        active._id,
        {
          $set: {
            ...cancelPatch,
            queue_status: "canceled",
            finished_at: new Date(),
          },
        },
        { new: true }
      );
    }

    const minOrderDoc = await Job.findOne({ queue_order: { $ne: null } })
      .sort({ queue_order: 1 })
      .select({ queue_order: 1 });
    const forcedOrder = (minOrderDoc?.queue_order ?? 1) - 1;
    await Job.findByIdAndUpdate(target._id, { $set: { queue_order: forcedOrder } });

    const started = await startNextQueuedJob({ forcedQueueId: target._id });
    res.json({ data: started });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (_req, res, next) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.json({ data: jobs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
