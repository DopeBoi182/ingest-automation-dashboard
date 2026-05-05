const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
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

function getS3Client() {
  if (cachedClient) return cachedClient;
  logS3Info("getS3Client.create", {
    region: env.s3Region,
    endpoint: env.s3ServiceUrl || "",
    forcePathStyle: env.s3ForcePathStyle,
    hasAccessKeyId: Boolean(env.s3AccessKeyId),
    hasSecretAccessKey: Boolean(env.s3SecretAccessKey),
  });
  cachedClient = new S3Client({
    region: env.s3Region,
    endpoint: env.s3ServiceUrl || undefined,
    forcePathStyle: env.s3ForcePathStyle,
    credentials: {
      accessKeyId: env.s3AccessKeyId,
      secretAccessKey: env.s3SecretAccessKey,
    },
  });
  return cachedClient;
}

function validateS3Config() {
  const missing = [];
  if (!env.s3Bucket) missing.push("Storage__S3__Bucket");
  if (!env.s3AccessKeyId) missing.push("Storage__S3__AccessKeyId");
  if (!env.s3SecretAccessKey) missing.push("Storage__S3__SecretAccessKey");
  if (!env.s3ServiceUrl) missing.push("Storage__S3__Host");

  if (missing.length) {
    logS3Info("validateS3Config.missing_keys", { missing });
    throw new Error(`Missing required S3 environment keys: ${missing.join(", ")}`);
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
  const url = await generatePresignedUrl({ key, ttlSeconds });
  logS3Info("buildUrlForKey.success", { key, mode });
  return url;
}

module.exports = {
  listObjectKeys,
  buildUrlForKey,
  validateS3Config,
};
