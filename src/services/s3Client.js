const fs = require("fs");
const https = require("https");
const { S3Client, GetObjectCommand, ListObjectsV2Command, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const env = require("../config/env");

let cachedClient = null;

function logS3Info(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(`[S3][client] ${action}`, meta);
}

function logS3Error(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error(`[S3][client] ${action} failed`, {
    ...meta,
    message: error?.message,
    name: error?.name,
    code: error?.code,
  });
}

function resolveTlsMode() {
  if (env.s3InsecureSkipVerify) return "insecure";
  return env.s3TlsMode;
}

function getS3RequestHandler() {
  const tlsMode = resolveTlsMode();
  const endpoint = String(env.s3ServiceUrl || "").toLowerCase();
  const isHttpsEndpoint = endpoint.startsWith("https://");
  if (!isHttpsEndpoint) {
    return { requestHandler: undefined, tlsMode };
  }

  if (tlsMode === "insecure") {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    return {
      requestHandler: new NodeHttpHandler({ httpsAgent }),
      tlsMode,
    };
  }

  if (tlsMode === "ca") {
    if (!env.s3CaCertPath) {
      throw new Error("S3_CA_CERT_PATH is required when S3_TLS_MODE=ca.");
    }
    const ca = fs.readFileSync(env.s3CaCertPath, "utf8");
    const httpsAgent = new https.Agent({ rejectUnauthorized: true, ca });
    return {
      requestHandler: new NodeHttpHandler({ httpsAgent }),
      tlsMode,
    };
  }

  return { requestHandler: undefined, tlsMode: "secure" };
}

function getS3Client() {
  if (cachedClient) return cachedClient;
  const { requestHandler, tlsMode } = getS3RequestHandler();
  logS3Info("getS3Client.create", {
    region: env.s3Region,
    endpoint: env.s3ServiceUrl || "",
    forcePathStyle: env.s3ForcePathStyle,
    hasAccessKeyId: Boolean(env.s3AccessKeyId),
    hasSecretAccessKey: Boolean(env.s3SecretAccessKey),
    tlsMode,
  });
  const s3Config = {
    region: env.s3Region,
    endpoint: env.s3ServiceUrl || undefined,
    forcePathStyle: env.s3ForcePathStyle,
    credentials: {
      accessKeyId: env.s3AccessKeyId,
      secretAccessKey: env.s3SecretAccessKey,
    },
  };
  if (requestHandler) {
    s3Config.requestHandler = requestHandler;
  }
  cachedClient = new S3Client(s3Config);
  return cachedClient;
}

function validateS3Config() {
  const missing = [];
  if (!env.s3Bucket) missing.push("Storage__S3__Bucket");
  if (!env.s3AccessKeyId) missing.push("Storage__S3__AccessKeyId");
  if (!env.s3SecretAccessKey) missing.push("Storage__S3__SecretAccessKey");
  if (!env.s3ServiceUrl) missing.push("Storage__S3__Host");
  if (resolveTlsMode() === "ca" && !env.s3CaCertPath) missing.push("S3_CA_CERT_PATH");

  if (missing.length) {
    logS3Info("validateS3Config.missing_keys", { missing });
    throw new Error(`Missing required S3 environment keys: ${missing.join(", ")}`);
  }
}

function sanitizeS3Error(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Unknown S3 error",
    code: error?.code || error?.Code || null,
    detail: error?.$metadata || null,
  };
}

async function checkS3Connectivity() {
  const start = Date.now();
  logS3Info("checkS3Connectivity.begin", {
    bucket: env.s3Bucket,
    endpoint: env.s3ServiceUrl,
  });
  try {
    validateS3Config();
    const client = getS3Client();
    await client.send(
      new HeadBucketCommand({
        Bucket: env.s3Bucket,
      })
    );
    const latencyMs = Date.now() - start;
    const result = {
      ok: true,
      provider: env.s3Provider,
      bucket: env.s3Bucket,
      endpoint: env.s3ServiceUrl,
      tlsMode: resolveTlsMode(),
      latencyMs,
      timestamp: new Date().toISOString(),
    };
    logS3Info("checkS3Connectivity.success", result);
    return result;
  } catch (error) {
    const latencyMs = Date.now() - start;
    const sanitized = sanitizeS3Error(error);
    logS3Error("checkS3Connectivity", error, {
      bucket: env.s3Bucket,
      endpoint: env.s3ServiceUrl,
      latencyMs,
      tlsMode: resolveTlsMode(),
    });
    return {
      ok: false,
      provider: env.s3Provider,
      bucket: env.s3Bucket,
      endpoint: env.s3ServiceUrl,
      tlsMode: resolveTlsMode(),
      latencyMs,
      timestamp: new Date().toISOString(),
      error: sanitized,
    };
  }
}

async function listObjectKeys({ prefix = "", continuationToken, maxKeys = 1000 }) {
  const safeMaxKeys = Math.min(Math.max(maxKeys, 1), 1000);
  logS3Info("listObjectKeys.begin", {
    bucket: env.s3Bucket,
    prefix,
    maxKeys: safeMaxKeys,
    hasContinuationToken: Boolean(continuationToken),
  });
  try {
    validateS3Config();
    const client = getS3Client();
    const command = new ListObjectsV2Command({
      Bucket: env.s3Bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: safeMaxKeys,
    });

    const response = await client.send(command);
    const keys = (response.Contents || []).map((item) => item.Key).filter(Boolean);
    logS3Info("listObjectKeys.success", {
      count: keys.length,
      isTruncated: Boolean(response.IsTruncated),
      hasNextContinuationToken: Boolean(response.NextContinuationToken),
    });
    return {
      keys,
      isTruncated: Boolean(response.IsTruncated),
      nextContinuationToken: response.NextContinuationToken || null,
    };
  } catch (error) {
    logS3Error("listObjectKeys", error, {
      bucket: env.s3Bucket,
      prefix,
      maxKeys: safeMaxKeys,
    });
    throw error;
  }
}

async function listObjects({ prefix = "", continuationToken, maxKeys = 1000 }) {
  const safeMaxKeys = Math.min(Math.max(maxKeys, 1), 1000);
  logS3Info("listObjects.begin", {
    bucket: env.s3Bucket,
    prefix,
    maxKeys: safeMaxKeys,
    hasContinuationToken: Boolean(continuationToken),
  });
  try {
    validateS3Config();
    const client = getS3Client();
    const command = new ListObjectsV2Command({
      Bucket: env.s3Bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: safeMaxKeys,
    });

    const response = await client.send(command);
    const objects = (response.Contents || [])
      .filter((item) => Boolean(item?.Key))
      .map((item) => ({
        key: item.Key,
        size: item.Size ?? 0,
        lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null,
        etag: item.ETag ? String(item.ETag).replace(/^"|"$/g, "") : null,
        storageClass: item.StorageClass || null,
      }));

    logS3Info("listObjects.success", {
      count: objects.length,
      isTruncated: Boolean(response.IsTruncated),
      hasNextContinuationToken: Boolean(response.NextContinuationToken),
    });
    return {
      objects,
      isTruncated: Boolean(response.IsTruncated),
      nextContinuationToken: response.NextContinuationToken || null,
    };
  } catch (error) {
    logS3Error("listObjects", error, {
      bucket: env.s3Bucket,
      prefix,
      maxKeys: safeMaxKeys,
    });
    throw error;
  }
}

function buildPublicUrlFromKey(key) {
  if (!env.s3PublicBaseUrl) {
    logS3Info("buildPublicUrlFromKey.missing_public_base_url");
    throw new Error("S3_PUBLIC_BASE_URL is required for public URL mode.");
  }
  const encodedKey = String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${env.s3PublicBaseUrl}/${encodedKey}`;
  logS3Info("buildPublicUrlFromKey.success", { key });
  return url;
}

function buildFileMetadataUrlFromKey(key) {
  if (!env.s3FileMetadataBaseUrl) {
    logS3Info("buildFileMetadataUrlFromKey.missing_base_url");
    throw new Error("S3_FILE_METADATA_BASE_URL is required for metadata mode.");
  }
  const params = new URLSearchParams({ fileKey: String(key) });
  const url = `${env.s3FileMetadataBaseUrl}/${env.s3FileMetadataPath}?${params.toString()}`;
  logS3Info("buildFileMetadataUrlFromKey.success", { key });
  return url;
}

async function generatePresignedUrl({ key, ttlSeconds }) {
  const expiresIn = ttlSeconds ?? env.s3PresignTtlSeconds;
  logS3Info("generatePresignedUrl.begin", {
    bucket: env.s3Bucket,
    key,
    expiresIn,
  });
  try {
    validateS3Config();
    const client = getS3Client();
    const command = new GetObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
    });
    const url = await getSignedUrl(client, command, { expiresIn });
    logS3Info("generatePresignedUrl.success", { key, expiresIn });
    return url;
  } catch (error) {
    logS3Error("generatePresignedUrl", error, {
      bucket: env.s3Bucket,
      key,
      expiresIn,
    });
    throw error;
  }
}

async function buildUrlForKey({ key, mode = "presigned", ttlSeconds }) {
  logS3Info("buildUrlForKey.begin", { key, mode });
  if (mode === "public") {
    return buildPublicUrlFromKey(key);
  }
  if (mode === "metadata") {
    return buildFileMetadataUrlFromKey(key);
  }
  const url = await generatePresignedUrl({ key, ttlSeconds });
  logS3Info("buildUrlForKey.success", { key, mode });
  return url;
}

module.exports = {
  listObjectKeys,
  listObjects,
  buildUrlForKey,
  validateS3Config,
  checkS3Connectivity,
};
