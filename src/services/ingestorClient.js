const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const env = require("../config/env");

const client = axios.create({
  baseURL: env.externalBaseUrl,
  timeout: env.requestTimeoutMs,
});

function logIngestorInfo(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(`[IngestorClient] ${action}`, meta);
}

function logIngestorError(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error(`[IngestorClient] ${action} failed`, {
    ...meta,
    message: error?.message,
    status: error?.response?.status || error?.status,
    detail: error?.response?.data,
  });
}

async function submitExtractJob(fileUrl, setting) {
  logIngestorInfo("submitExtractJob.begin", {
    externalBaseUrl: env.externalBaseUrl,
    endpoint: env.extractEndpoint,
    hasFileUrl: Boolean(String(fileUrl || "").trim()),
    provider: setting?.provider || "",
    knowledgeSource: setting?.knowledge_source || "",
  });
  const form = new FormData();
  form.append("url", fileUrl);
  form.append("provider", setting.provider);
  form.append("prompt", setting.prompt);
  form.append("chunk_size", String(setting.chunk_size));
  form.append("chunk_overlap", String(setting.chunk_overlap));
  form.append("embed", String(Boolean(setting.embed)));
  form.append("vdb_collection", setting.vdb_collection);
  form.append("callback_url", setting.callback_url || "");
  form.append("vector_group", setting.vector_group);
  form.append("knowledge_source", setting.knowledge_source);
  form.append("knowledge_tags", JSON.stringify(setting.knowledge_tags || []));
  form.append("force", String(Boolean(setting.force)));

  try {
    const response = await client.post(env.extractEndpoint, form, {
      headers: form.getHeaders(),
    });
    logIngestorInfo("submitExtractJob.success", {
      statusCode: response?.status,
      remoteJobId: response?.data?.job_id || "",
      remoteStatus: response?.data?.status || "",
    });
    return response.data;
  } catch (error) {
    logIngestorError("submitExtractJob", error, {
      endpoint: env.extractEndpoint,
      fileUrl,
    });
    throw error;
  }
}

async function submitExtractJobWithFile(fileInput, setting) {
  logIngestorInfo("submitExtractJobWithFile.begin", {
    externalBaseUrl: env.externalBaseUrl,
    endpoint: env.extractEndpoint,
    fileName: fileInput?.file_name || "",
    filePath: fileInput?.file_path || "",
    fileMime: fileInput?.file_mime || "",
    fileSize: fileInput?.file_size || 0,
    provider: setting?.provider || "",
  });
  const form = new FormData();
  const filePath = String(fileInput?.file_path || "").trim();
  if (!filePath) {
    throw new Error("Missing file_path for file-based ingestion.");
  }
  form.append("file", fs.createReadStream(filePath), {
    filename: fileInput?.file_name || path.basename(filePath),
    contentType: fileInput?.file_mime || undefined,
  });
  form.append("provider", setting.provider);
  form.append("prompt", setting.prompt);
  form.append("chunk_size", String(setting.chunk_size));
  form.append("chunk_overlap", String(setting.chunk_overlap));
  form.append("embed", String(Boolean(setting.embed)));
  form.append("vdb_collection", setting.vdb_collection);
  form.append("callback_url", setting.callback_url || "");
  form.append("vector_group", setting.vector_group);
  form.append("knowledge_source", setting.knowledge_source);
  form.append("knowledge_tags", JSON.stringify(setting.knowledge_tags || []));
  form.append("force", String(Boolean(setting.force)));

  try {
    const response = await client.post(env.extractEndpoint, form, {
      headers: form.getHeaders(),
    });
    logIngestorInfo("submitExtractJobWithFile.success", {
      statusCode: response?.status,
      remoteJobId: response?.data?.job_id || "",
      remoteStatus: response?.data?.status || "",
    });
    return response.data;
  } catch (error) {
    logIngestorError("submitExtractJobWithFile", error, {
      endpoint: env.extractEndpoint,
      fileName: fileInput?.file_name || "",
      filePath: fileInput?.file_path || "",
    });
    throw error;
  }
}

async function getJobStatus(jobId) {
  logIngestorInfo("getJobStatus.begin", {
    externalBaseUrl: env.externalBaseUrl,
    endpoint: `${env.statusEndpointPrefix}/${jobId}`,
    jobId,
  });
  try {
    const response = await client.get(`${env.statusEndpointPrefix}/${jobId}`);
    logIngestorInfo("getJobStatus.success", {
      statusCode: response?.status,
      jobId,
      remoteStatus: response?.data?.status || "",
    });
    return response.data;
  } catch (error) {
    logIngestorError("getJobStatus", error, { jobId });
    throw error;
  }
}

async function cancelJob(jobId) {
  logIngestorInfo("cancelJob.begin", {
    externalBaseUrl: env.externalBaseUrl,
    endpoint: `${env.statusEndpointPrefix}/${jobId}/cancel`,
    jobId,
  });
  try {
    const response = await client.post(`${env.statusEndpointPrefix}/${jobId}/cancel`);
    logIngestorInfo("cancelJob.success", {
      statusCode: response?.status,
      jobId,
      remoteStatus: response?.data?.status || "",
    });
    return response.data;
  } catch (error) {
    logIngestorError("cancelJob", error, { jobId });
    throw error;
  }
}

async function askQna(payload) {
  logIngestorInfo("askQna.begin", {
    externalBaseUrl: env.externalBaseUrl,
    endpoint: env.qnaEndpoint,
    hasQuestion: Boolean(String(payload?.question || "").trim()),
  });
  try {
    const response = await client.post(env.qnaEndpoint, payload);
    logIngestorInfo("askQna.success", { statusCode: response?.status });
    return response.data;
  } catch (error) {
    logIngestorError("askQna", error);
    throw error;
  }
}

module.exports = {
  submitExtractJob,
  submitExtractJobWithFile,
  getJobStatus,
  cancelJob,
  askQna,
};
