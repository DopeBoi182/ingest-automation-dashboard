const express = require("express");
const Job = require("../models/Job");
const { getOrCreateGlobalSetting } = require("../utils/settings");
const { submitExtractJob, getJobStatus, cancelJob } = require("../services/ingestorClient");

const router = express.Router();

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

function mapJobData(fileUrl, payload) {
  return {
    file_url: fileUrl,
    job_id: payload.job_id,
    status: payload.status || "created",
    stage: payload.stage || "",
    progress: payload.progress ?? 0,
    resource_key: payload.resource_key || "",
    error: payload.error || null,
    raw_response: payload,
    created_at_remote: fromUnixSeconds(payload.created_at),
    updated_at_remote: fromUnixSeconds(payload.updated_at),
  };
}

router.post("/ingest", async (req, res, next) => {
  try {
    const urls = parseUrlInput(req.body?.urls);
    if (!urls.length) {
      return res.status(400).json({ message: "urls is required (comma-separated)." });
    }

    const setting = await getOrCreateGlobalSetting();
    const results = [];

    for (const url of urls) {
      try {
        const remote = await submitExtractJob(url, setting);
        const jobPayload = mapJobData(url, remote);
        const saved = await Job.findOneAndUpdate(
          { job_id: jobPayload.job_id },
          { $set: jobPayload },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        results.push({ file_url: url, ok: true, data: saved });
      } catch (error) {
        results.push({
          file_url: url,
          ok: false,
          error: error.response?.data || error.message,
        });
      }
    }

    res.json({ data: results });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (_req, res, next) => {
  try {
    const jobs = await Job.find().sort({ updatedAt: -1, createdAt: -1 });
    res.json({ data: jobs });
  } catch (error) {
    next(error);
  }
});

router.post("/:jobId/refresh", async (req, res, next) => {
  try {
    const job = await Job.findOne({ job_id: req.params.jobId });
    if (!job) return res.status(404).json({ message: "Job not found." });

    const remote = await getJobStatus(job.job_id);
    const update = mapJobData(job.file_url, remote);
    const saved = await Job.findOneAndUpdate({ job_id: job.job_id }, { $set: update }, { new: true });

    res.json({ data: saved });
  } catch (error) {
    next(error);
  }
});

router.post("/refresh-all", async (_req, res, next) => {
  try {
    const jobs = await Job.find().sort({ createdAt: 1 });
    const results = [];

    for (const job of jobs) {
      try {
        const remote = await getJobStatus(job.job_id);
        const update = mapJobData(job.file_url, remote);
        const saved = await Job.findOneAndUpdate(
          { job_id: job.job_id },
          { $set: update },
          { new: true }
        );
        results.push({ job_id: job.job_id, ok: true, data: saved });
      } catch (error) {
        results.push({
          job_id: job.job_id,
          ok: false,
          error: error.response?.data || error.message,
        });
      }
    }

    res.json({ data: results });
  } catch (error) {
    next(error);
  }
});

router.post("/:jobId/cancel", async (req, res, next) => {
  try {
    const job = await Job.findOne({ job_id: req.params.jobId });
    if (!job) return res.status(404).json({ message: "Job not found." });

    const remote = await cancelJob(job.job_id);
    const update = mapJobData(job.file_url, remote);
    const saved = await Job.findOneAndUpdate({ job_id: job.job_id }, { $set: update }, { new: true });

    res.json({ data: saved });
  } catch (error) {
    next(error);
  }
});

router.post("/cancel-all", async (_req, res, next) => {
  try {
    const jobs = await Job.find().sort({ createdAt: 1 });
    const results = [];

    for (const job of jobs) {
      try {
        const remote = await cancelJob(job.job_id);
        const update = mapJobData(job.file_url, remote);
        const saved = await Job.findOneAndUpdate(
          { job_id: job.job_id },
          { $set: update },
          { new: true }
        );
        results.push({ job_id: job.job_id, ok: true, data: saved });
      } catch (error) {
        results.push({
          job_id: job.job_id,
          ok: false,
          error: error.response?.data || error.message,
        });
      }
    }

    res.json({ data: results });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
