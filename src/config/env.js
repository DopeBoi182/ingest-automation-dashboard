const dotenv = require("dotenv");

dotenv.config();

function toBool(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return String(value).toLowerCase() === "true";
}

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const env = {
  port: toNumber(process.env.PORT, 9001),
  mongoUri:
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/automation_ai_ingestion",
  externalBaseUrl: process.env.EXTERNAL_BASE_URL || "http://16.79.175.142:806",
  extractEndpoint: process.env.EXTRACT_ENDPOINT || "/api/v1/jobs/extract",
  statusEndpointPrefix: process.env.STATUS_ENDPOINT_PREFIX || "/api/v1/jobs",
  qnaEndpoint: process.env.QNA_ENDPOINT || "/api/v1/chat/qna",
  defaultProvider: process.env.DEFAULT_PROVIDER || "bedrock",
  defaultPrompt:
    process.env.DEFAULT_PROMPT ||
    "You are an OCR-style extractor. Return only what is visibly present in the document.",
  defaultChunkSize: toNumber(process.env.DEFAULT_CHUNK_SIZE, 1000),
  defaultChunkOverlap: toNumber(process.env.DEFAULT_CHUNK_OVERLAP, 200),
  defaultEmbed: toBool(process.env.DEFAULT_EMBED, true),
  defaultVdbCollection: process.env.DEFAULT_VDB_COLLECTION || "docs",
  defaultCallbackUrl: process.env.DEFAULT_CALLBACK_URL || "http://localhost:9001/callback",
  defaultVectorGroup: process.env.DEFAULT_VECTOR_GROUP || "staging",
  defaultKnowledgeSource: process.env.DEFAULT_KNOWLEDGE_SOURCE || "repo-demo",
  defaultKnowledgeTags:
    process.env.DEFAULT_KNOWLEDGE_TAGS || "Oil & Gas Production,Process Engineering",
  defaultForce: toBool(process.env.DEFAULT_FORCE, true),
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 60000),
};

module.exports = env;
