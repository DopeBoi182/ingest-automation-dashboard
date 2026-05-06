const path = require("path");
const env = require("../config/env");
const { request, createMultipartFields } = require("./externalHttpClient");

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
  const fields = {
    url: fileUrl,
    provider: setting.provider,
    prompt: setting.prompt,
    chunk_size: String(setting.chunk_size),
    chunk_overlap: String(setting.chunk_overlap),
    embed: String(Boolean(setting.embed)),
    vdb_collection: setting.vdb_collection,
    callback_url: setting.callback_url || "",
    vector_group: setting.vector_group,
    knowledge_source: setting.knowledge_source,
    knowledge_tags: JSON.stringify(setting.knowledge_tags || []),
    force: String(Boolean(setting.force)),
  };

  try {
    const response = await request({
      method: "POST",
      endpoint: env.extractEndpoint,
      httpPost: createMultipartFields(fields),
      timeoutMs: env.requestTimeoutMs,
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
  const filePath = String(fileInput?.file_path || "").trim();
  if (!filePath) {
    throw new Error("Missing file_path for file-based ingestion.");
  }
  const fields = {
    provider: setting.provider,
    prompt: setting.prompt,
    chunk_size: String(setting.chunk_size),
    chunk_overlap: String(setting.chunk_overlap),
    embed: String(Boolean(setting.embed)),
    vdb_collection: setting.vdb_collection,
    callback_url: setting.callback_url || "",
    vector_group: setting.vector_group,
    knowledge_source: setting.knowledge_source,
    knowledge_tags: JSON.stringify(setting.knowledge_tags || []),
    force: String(Boolean(setting.force)),
  };

  try {
    const response = await request({
      method: "POST",
      endpoint: env.extractEndpoint,
      httpPost: createMultipartFields(fields, {
        fieldName: "file",
        filePath,
        fileName: fileInput?.file_name || path.basename(filePath),
        mimeType: fileInput?.file_mime || undefined,
      }),
      timeoutMs: env.requestTimeoutMs,
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
    const response = await request({
      method: "GET",
      endpoint: `${env.statusEndpointPrefix}/${jobId}`,
      timeoutMs: env.requestTimeoutMs,
    });
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
    const response = await request({
      method: "POST",
      endpoint: `${env.statusEndpointPrefix}/${jobId}/cancel`,
      timeoutMs: env.requestTimeoutMs,
    });
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
    const response = await request({
      method: "POST",
      endpoint: env.qnaEndpoint,
      body: payload,
      timeoutMs: env.requestTimeoutMs,
    });
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
