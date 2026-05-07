const { readData, updateData, generateId } = require("./dataStore");

function toComparableTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function nowIso() {
  return new Date().toISOString();
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const lowered = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "n", "off"].includes(lowered)) return false;
  return fallback;
}

function normalizeStoredJob(job) {
  return {
    ...job,
    vlm_ocr: toBoolean(job?.vlm_ocr, false),
  };
}

function normalizeUrlQueueInput(entry) {
  if (entry && typeof entry === "object") {
    const url = String(entry.url || entry.file_url || "").trim();
    return {
      url,
      vlm_ocr: toBoolean(entry.vlm_ocr, false),
    };
  }
  return {
    url: String(entry || "").trim(),
    vlm_ocr: false,
  };
}

function withTimestamps(job, patch) {
  const next = { ...job, ...patch, updatedAt: nowIso() };
  for (const [key, value] of Object.entries(next)) {
    if (value instanceof Date) {
      next[key] = value.toISOString();
    }
  }
  return next;
}

function sortQueued(a, b) {
  const qa = a.queue_order ?? Number.MAX_SAFE_INTEGER;
  const qb = b.queue_order ?? Number.MAX_SAFE_INTEGER;
  if (qa !== qb) return qa - qb;
  return toComparableTime(a.createdAt) - toComparableTime(b.createdAt);
}

function sortProcessing(a, b) {
  const sa = toComparableTime(a.started_at);
  const sb = toComparableTime(b.started_at);
  if (sa !== sb) return sa - sb;
  return toComparableTime(a.createdAt) - toComparableTime(b.createdAt);
}

async function getAllJobs() {
  const data = await readData();
  return data.jobs
    .map(normalizeStoredJob)
    .sort((a, b) => toComparableTime(b.createdAt) - toComparableTime(a.createdAt));
}

async function getQueuedJobs() {
  const data = await readData();
  return data.jobs.map(normalizeStoredJob).filter((x) => x.queue_status === "queued").sort(sortQueued);
}

async function getFinishedJobs() {
  const data = await readData();
  return data.jobs
    .map(normalizeStoredJob)
    .filter((x) => ["completed", "failed"].includes(x.queue_status))
    .sort((a, b) => {
      const fa = toComparableTime(a.finished_at);
      const fb = toComparableTime(b.finished_at);
      if (fa !== fb) return fb - fa;
      return toComparableTime(b.updatedAt) - toComparableTime(a.updatedAt);
    });
}

async function getJobsWithRemoteId() {
  const data = await readData();
  return data.jobs
    .map(normalizeStoredJob)
    .filter((x) => Boolean(x.job_id))
    .sort((a, b) => toComparableTime(a.createdAt) - toComparableTime(b.createdAt));
}

async function getByJobId(jobId) {
  const data = await readData();
  const job = data.jobs.find((x) => x.job_id === jobId) || null;
  return job ? normalizeStoredJob(job) : null;
}

async function getQueuedById(id) {
  const data = await readData();
  const job = data.jobs.find((x) => x._id === id && x.queue_status === "queued") || null;
  return job ? normalizeStoredJob(job) : null;
}

async function getActiveProcessingJob() {
  const data = await readData();
  const processing = data.jobs
    .map(normalizeStoredJob)
    .filter((x) => x.queue_status === "processing")
    .sort(sortProcessing);
  return processing[0] || null;
}

async function getNextQueuedJob() {
  const queued = await getQueuedJobs();
  return queued[0] || null;
}

async function createQueuedJobsFromUrls(urls) {
  return updateData(async (data) => {
    const maxOrder = data.jobs
      .map((x) => x.queue_order)
      .filter((x) => Number.isFinite(x))
      .reduce((acc, n) => Math.max(acc, n), 0);
    let nextOrder = maxOrder;
    const timestamp = nowIso();
    const created = urls.map((entry) => {
      const normalized = normalizeUrlQueueInput(entry);
      nextOrder += 1;
      return {
        _id: generateId(),
        file_url: normalized.url,
        input_type: "url",
        file_name: "",
        file_path: "",
        file_mime: "",
        file_size: 0,
        vlm_ocr: normalized.vlm_ocr,
        job_id: null,
        status: "queued",
        stage: "queued",
        progress: 0,
        resource_key: "",
        error: null,
        raw_response: {},
        created_at_remote: null,
        updated_at_remote: null,
        queue_status: "queued",
        queue_order: nextOrder,
        started_at: null,
        finished_at: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    data.jobs.push(...created);
    return { data, result: created };
  });
}

async function createQueuedJobsFromFiles(files) {
  return updateData(async (data) => {
    const maxOrder = data.jobs
      .map((x) => x.queue_order)
      .filter((x) => Number.isFinite(x))
      .reduce((acc, n) => Math.max(acc, n), 0);
    let nextOrder = maxOrder;
    const timestamp = nowIso();
    const created = files.map((file) => {
      nextOrder += 1;
      return {
        _id: generateId(),
        file_url: "",
        input_type: "file",
        file_name: String(file.file_name || "").trim(),
        file_path: String(file.file_path || "").trim(),
        file_mime: String(file.file_mime || "").trim(),
        file_size: Number(file.file_size) || 0,
        vlm_ocr: toBoolean(file.vlm_ocr, false),
        job_id: null,
        status: "queued",
        stage: "queued",
        progress: 0,
        resource_key: "",
        error: null,
        raw_response: {},
        created_at_remote: null,
        updated_at_remote: null,
        queue_status: "queued",
        queue_order: nextOrder,
        started_at: null,
        finished_at: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    data.jobs.push(...created);
    return { data, result: created };
  });
}

async function updateJobById(id, patch) {
  return updateData(async (data) => {
    const index = data.jobs.findIndex((x) => x._id === id);
    if (index < 0) return { data, result: null };
    data.jobs[index] = withTimestamps(data.jobs[index], patch);
    return { data, result: data.jobs[index] };
  });
}

async function deleteQueuedById(id) {
  return updateData(async (data) => {
    const index = data.jobs.findIndex((x) => x._id === id && x.queue_status === "queued");
    if (index < 0) return { data, result: null };
    const [deleted] = data.jobs.splice(index, 1);
    return { data, result: deleted };
  });
}

async function clearQueuedJobs() {
  return updateData(async (data) => {
    const before = data.jobs.length;
    data.jobs = data.jobs.filter((x) => x.queue_status !== "queued");
    const deletedCount = before - data.jobs.length;
    return { data, result: { deletedCount } };
  });
}

module.exports = {
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
};
