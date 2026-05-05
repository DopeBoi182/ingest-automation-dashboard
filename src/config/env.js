const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

function toBool(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return String(value).toLowerCase() === "true";
}

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function normalizeHostToServiceUrl(host, useHttps) {
  if (!host) return "";
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return host;
  }
  return `${useHttps ? "https" : "http"}://${host}`;
}

function normalizeBasePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "/") return "";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function normalizeUploadDir(value) {
  const raw = String(value || "").trim();
  if (!raw) return path.join(process.cwd(), "data", "uploads");
  if (path.isAbsolute(raw)) return raw;
  return path.join(process.cwd(), raw);
}

function normalizeDataFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return path.join(process.cwd(), "data", "storage.json");
  if (path.isAbsolute(raw)) return raw;
  return path.join(process.cwd(), raw);
}

const env = {
  port: toNumber(process.env.PORT, 9001),
  appBasePath: normalizeBasePath(process.env.APP_BASE_PATH),
  uploadDir: normalizeUploadDir(process.env.UPLOAD_DIR),
  dataFile: normalizeDataFile(process.env.DATA_FILE),
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
  s3Provider: process.env.Storage__Provider || "S3",
  s3UseHttps: toBool(process.env.USE_HTTPS, true),
  s3ForcePathStyle: toBool(process.env.FORCE_PATH_STYLE, true),
  s3PresignTtlSeconds: toNumber(process.env.PRESIGN_TTL_SECONDS, 900),
  s3Host: process.env.Storage__S3__Host || "",
  s3Region: process.env.Storage__S3__Region || "ap-south-1",
  s3AccessKeyId: process.env.Storage__S3__AccessKeyId || "",
  s3SecretAccessKey: process.env.Storage__S3__SecretAccessKey || "",
  s3Bucket: process.env.Storage__S3__Bucket || "",
  s3PublicBaseUrl: (process.env.S3_PUBLIC_BASE_URL || "").replace(/\/$/, ""),
};

env.s3ServiceUrl = normalizeHostToServiceUrl(env.s3Host, env.s3UseHttps);

module.exports = env;
