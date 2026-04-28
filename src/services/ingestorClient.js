const axios = require("axios");
const FormData = require("form-data");
const env = require("../config/env");

const client = axios.create({
  baseURL: env.externalBaseUrl,
  timeout: env.requestTimeoutMs,
});

async function submitExtractJob(fileUrl, setting) {
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

  const response = await client.post(env.extractEndpoint, form, {
    headers: form.getHeaders(),
  });
  return response.data;
}

async function getJobStatus(jobId) {
  const response = await client.get(`${env.statusEndpointPrefix}/${jobId}`);
  return response.data;
}

async function askQna(payload) {
  const response = await client.post(env.qnaEndpoint, payload);
  return response.data;
}

module.exports = {
  submitExtractJob,
  getJobStatus,
  askQna,
};
