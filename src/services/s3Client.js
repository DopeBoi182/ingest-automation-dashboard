const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const env = require("../config/env");

let cachedClient = null;

function getS3Client() {
  if (cachedClient) return cachedClient;
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
    throw new Error(`Missing required S3 environment keys: ${missing.join(", ")}`);
  }
}

async function listObjectKeys({ prefix = "", continuationToken, maxKeys = 1000 }) {
  validateS3Config();
  const client = getS3Client();
  const command = new ListObjectsV2Command({
    Bucket: env.s3Bucket,
    Prefix: prefix,
    ContinuationToken: continuationToken,
    MaxKeys: Math.min(Math.max(maxKeys, 1), 1000),
  });

  const response = await client.send(command);
  const keys = (response.Contents || []).map((item) => item.Key).filter(Boolean);
  return {
    keys,
    isTruncated: Boolean(response.IsTruncated),
    nextContinuationToken: response.NextContinuationToken || null,
  };
}

function buildPublicUrlFromKey(key) {
  if (!env.s3PublicBaseUrl) {
    throw new Error("S3_PUBLIC_BASE_URL is required for public URL mode.");
  }
  const encodedKey = String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${env.s3PublicBaseUrl}/${encodedKey}`;
}

async function generatePresignedUrl({ key, ttlSeconds }) {
  validateS3Config();
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: env.s3Bucket,
    Key: key,
  });
  return getSignedUrl(client, command, {
    expiresIn: ttlSeconds ?? env.s3PresignTtlSeconds,
  });
}

async function buildUrlForKey({ key, mode = "presigned", ttlSeconds }) {
  if (mode === "public") {
    return buildPublicUrlFromKey(key);
  }
  return generatePresignedUrl({ key, ttlSeconds });
}

module.exports = {
  listObjectKeys,
  buildUrlForKey,
  validateS3Config,
};
