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

function normalizeOptionalFilePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (path.isAbsolute(raw)) return raw;
  return path.join(process.cwd(), raw);
}

function normalizeS3TlsMode(value) {
  const raw = String(value || "secure").trim().toLowerCase();
  if (["secure", "insecure", "ca"].includes(raw)) return raw;
  return "secure";
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
  s3FileMetadataBaseUrl: (process.env.S3_FILE_METADATA_BASE_URL || "").replace(/\/$/, ""),
  s3FileMetadataPath: (process.env.S3_FILE_METADATA_PATH || "api/v1/file-metadata").replace(
    /^\/+/,
    ""
  ),
  s3TlsMode: normalizeS3TlsMode(process.env.S3_TLS_MODE),
  s3InsecureSkipVerify: toBool(process.env.S3_INSECURE_SKIP_VERIFY, false),
  s3CaCertPath: normalizeOptionalFilePath(process.env.S3_CA_CERT_PATH),
  sqlServerEnabled: toBool(process.env.SQLSERVER_ENABLED, false),
  sqlServerConnectionString: process.env.SQLSERVER_CONNECTION_STRING || "",
  sqlServerHost: process.env.SQLSERVER_HOST || "",
  sqlServerPort: toNumber(process.env.SQLSERVER_PORT, 1433),
  sqlServerDatabase: process.env.SQLSERVER_DATABASE || "",
  sqlServerUser: process.env.SQLSERVER_USER || "",
  sqlServerPassword: process.env.SQLSERVER_PASSWORD || "",
  sqlServerEncrypt: toBool(process.env.SQLSERVER_ENCRYPT, true),
  sqlServerTrustServerCertificate: toBool(process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE, false),
  sqlServerConnectionTimeoutMs: toNumber(process.env.SQLSERVER_CONNECTION_TIMEOUT_MS, 15000),
  sqlServerRequestTimeoutMs: toNumber(process.env.SQLSERVER_REQUEST_TIMEOUT_MS, 30000),
  sqlServerPoolMax: toNumber(process.env.SQLSERVER_POOL_MAX, 10),
  sqlServerPoolMin: toNumber(process.env.SQLSERVER_POOL_MIN, 0),
  sqlServerPoolIdleTimeoutMs: toNumber(process.env.SQLSERVER_POOL_IDLE_TIMEOUT_MS, 30000),
};

env.s3ServiceUrl = normalizeHostToServiceUrl(env.s3Host, env.s3UseHttps);

module.exports = env;
