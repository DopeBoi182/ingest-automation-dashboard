# Automation AI Ingestion - Application Guide

This document explains how the application works and how to use it in daily operations.

## 1) What This App Does

`automation_ai_ingestion` is a web dashboard for document ingestion workflows.

It helps you:
- manage global ingestion settings,
- queue document URLs for extraction,
- process one ingestion job at a time (single worker),
- monitor active/queued/finished jobs,
- fetch S3 object links (presigned or public),
- send fetched S3 files directly to ingestion queue,
- ask QnA against ingested knowledge.

## 2) Main Pages

- Ingestion dashboard: `http://localhost:9001/`
- S3 fetcher page: `http://localhost:9001/s3.html`

## 3) How It Works (Flow)

### A. Ingestion Queue Flow
1. User submits one or many URLs.
2. URLs are saved to local JSON storage as `queued`.
3. If no active process exists, first queued item auto-starts.
4. App sends extract request to external extractor API.
5. Active process status is refreshed periodically (`tick` every 30s).
6. When a job finishes/fails/cancels, next queued item starts automatically.

### B. S3 Fetcher Flow
1. User lists S3 objects by prefix.
2. App generates URLs in selected mode:
   - `presigned` (temporary URL with TTL),
   - `public` (direct URL using `S3_PUBLIC_BASE_URL`).
3. Folder placeholders like `uploads/` are filtered out.
4. User ingests selected/all listed files directly into queue.

### C. Data Storage
- No MongoDB required.
- App state is stored in local file:
  - `data/storage.json`
- Stored content includes:
  - jobs (`queued`, `processing`, `completed`, `failed`, `canceled`)
  - global setting object

## 4) Requirements

- Node.js 18+ recommended
- Network access from server to:
  - extractor API (`EXTERNAL_BASE_URL`)
  - S3 endpoint (`Storage__S3__Host`)
- Valid AWS/S3 credentials if using S3 page

## 5) Setup

1. Install dependencies:
   - `npm install`
2. Copy env:
   - copy `.env.example` to `.env`
3. Fill required `.env` values.
4. Start app:
   - dev: `npm run dev`
   - prod: `npm start`

## 6) Environment Variables

## Core App
- `PORT` (default `9001`)
- `DATA_FILE` (default `data/storage.json`)

## Extractor API
- `EXTERNAL_BASE_URL`
- `EXTRACT_ENDPOINT`
- `STATUS_ENDPOINT_PREFIX`
- `QNA_ENDPOINT`
- `REQUEST_TIMEOUT_MS`

## Default Ingestion Settings
- `DEFAULT_PROVIDER`
- `DEFAULT_PROMPT`
- `DEFAULT_CHUNK_SIZE`
- `DEFAULT_CHUNK_OVERLAP`
- `DEFAULT_EMBED`
- `DEFAULT_VDB_COLLECTION`
- `DEFAULT_CALLBACK_URL`
- `DEFAULT_VECTOR_GROUP`
- `DEFAULT_KNOWLEDGE_SOURCE`
- `DEFAULT_KNOWLEDGE_TAGS`
- `DEFAULT_FORCE`

## S3 Integration
- `Storage__Provider` (use `S3`)
- `Storage__S3__Host` (example: `s3.us-east-1.amazonaws.com`)
- `Storage__S3__Region`
- `Storage__S3__AccessKeyId`
- `Storage__S3__SecretAccessKey`
- `Storage__S3__Bucket`
- `PRESIGN_TTL_SECONDS`
- `FORCE_PATH_STYLE` (AWS usually `false`)
- `USE_HTTPS` (`true` recommended)
- `S3_PUBLIC_BASE_URL` (required for `public` mode)
- `S3_TLS_MODE` (`secure` | `insecure` | `ca`, default `secure`)
- `S3_INSECURE_SKIP_VERIFY` (`true` forces insecure compatibility mode)
- `S3_CA_CERT_PATH` (required when `S3_TLS_MODE=ca`, PEM file path)

## SQL Server Integration (Optional)
- `SQLSERVER_ENABLED` (`true` to enable connection)
- `SQLSERVER_HOST` (required when enabled)
- `SQLSERVER_DATABASE` (required when enabled)
- `SQLSERVER_USER` (required when enabled)
- `SQLSERVER_PASSWORD` (required when enabled)
- `SQLSERVER_PORT` (default `1433`)
- `SQLSERVER_ENCRYPT` (default `true`)
- `SQLSERVER_TRUST_SERVER_CERTIFICATE` (default `false`)
- `SQLSERVER_CONNECTION_TIMEOUT_MS` (default `15000`)
- `SQLSERVER_REQUEST_TIMEOUT_MS` (default `30000`)
- `SQLSERVER_POOL_MAX` (default `10`)
- `SQLSERVER_POOL_MIN` (default `0`)
- `SQLSERVER_POOL_IDLE_TIMEOUT_MS` (default `30000`)

### TLS Mode Guidance
- `secure`: default production mode (`rejectUnauthorized=true`).
- `insecure`: compatibility mode for self-signed/non-trusted cert chains.
- `ca`: secure custom CA mode, where app trusts your provided CA bundle.
- Prefer `ca` for production private S3-compatible endpoints.

## 7) How To Use (Operator Guide)

### Step 1 - Configure Settings
1. Open `/`
2. In **Global Settings**, fill source/tags/provider/chunk params.
3. Click **Save Settings**.

### Step 2 - Add URLs Manually
1. In **Queue URLs**, enter comma-separated URLs.
2. Click **Add to Queue + Auto Start**.
3. Check tabs:
   - `Process` for active job,
   - `Queue` for waiting jobs,
   - `Finished` for completed/failed jobs.

### Step 3 - Use S3 Fetcher (Optional)
1. Open `/s3.html`.
2. Input prefix/max keys/mode/ttl.
3. Click **Generate URLs**.
4. Select files and click **Ingest Selected** (or **Ingest All**).
5. Click **Check S3 Health** to run live S3 connectivity probe.

### Step 4 - Queue Controls
- **Execute One**: trigger next queued item if idle.
- **Refresh All State**: sync statuses from external API.
- **Force Add to Process**: cancel current active, prioritize selected queued item.
- **Delete** (queue row): remove one queued item immediately.
- **Clear Queue**: remove all queued items immediately.

### Step 5 - Ask QnA
1. Use **Ask AI (QnA)** section on `/`.
2. Enter question and submit.

## 8) Main API Endpoints

## Jobs
- `POST /api/jobs/queue`
- `POST /api/jobs/ingest`
- `GET /api/jobs/process`
- `GET /api/jobs/queue`
- `GET /api/jobs/finished`
- `POST /api/jobs/process/trigger`
- `POST /api/jobs/process/tick`
- `POST /api/jobs/:jobId/refresh`
- `POST /api/jobs/refresh-all`
- `POST /api/jobs/queue/:id/force-replace`
- `DELETE /api/jobs/queue/:id`
- `DELETE /api/jobs/queue`
- `GET /api/jobs`

## Settings
- `GET /api/settings`
- `PUT /api/settings`

## QnA
- `POST /api/qna`

## S3
- `GET /api/s3/health`
- `GET /api/s3/health/live`
- `GET /api/s3/files/urls`
- `POST /api/s3/ingest`

## SQL Sync
- `GET /api/sqlsync/connection-check`
- `GET /api/sqlsync/template`
- `POST /api/sqlsync/upload-excel` (multipart form-data, key: `file`)

## 9) Excel SQL Sync (Main Page)

The dashboard now includes an **Excel SQL Sync** section on `/`.

### Purpose
- Verify SQL Server connection from the app runtime.
- Upload Excel and sync row data into SQL tables in one flow.

### Sync Order Per Row
1. Insert into `RepoService.dbo.FileMetadataRepo`
2. Insert into `RepoService.dbo.AiScheduleQueues` using inserted `FileMetadataRepo.Id` as `FileId`

Each row uses a DB transaction. If one insert fails, that row is rolled back.

### Required Excel Headers
- `UserId`
- `FolderId`
- `FileName`
- `Extension`
- `FileSizeByte`
- `FileType`
- `FileUrl`
- `KnowledgeSource`
- `KnowledgeTags`
- `JobAction`
- `JobStatus`
- `ScheduledAt`
- `CreatedBy`

### Useful Optional Headers
- `FileMetadataId`, `QueueId`, `S3Key`, `AbstractContent`, `ThumbnailKey`
- `AiStatus`, `IsBookmark`, `IsPublish`, `Kind`
- `FileIsDeleted`, `DocumentLocked`, `FileModified`, `FileModifiedBy`
- `JobId`, `JobProgress`, `LastErrorCode`, `LastErrorMessage`
- `ScheduledStart`, `ScheduledAttempts`, `HasFinished`
- `QueueIsDeleted`, `QueueModified`, `QueueModifiedBy`
- `HasUpdated`, `KnowledgeType`

To get an up-to-date sample row and defaults from the backend, call:
- `GET /api/sqlsync/template`

## 10) Troubleshooting

### "Generate URLs failed: not authorized to perform s3:ListBucket"
Grant IAM user permissions:
- `s3:ListBucket` on `arn:aws:s3:::<bucket>`
- `s3:GetObject` on `arn:aws:s3:::<bucket>/*`

### S3 public mode returns 403
- Ensure bucket/object policy allows public read, or
- use CloudFront public URL in `S3_PUBLIC_BASE_URL`.

### "self-signed certificate in certificate chain"
- Use `S3_TLS_MODE=ca` and set `S3_CA_CERT_PATH` to your trusted CA PEM.
- If you need temporary compatibility behavior, use `S3_TLS_MODE=insecure` (or `S3_INSECURE_SKIP_VERIFY=true`).
- Verify connectivity via:
  - S3 page button (**Check S3 Health**), or
  - dashboard button (**S3 Connectivity**), or
  - `GET /api/s3/health/live`.

### Jobs do not progress
- Check `EXTERNAL_BASE_URL` and extractor endpoint values.
- Confirm server can reach external extractor API.

### SQL Server connection fails at startup
- Verify `SQLSERVER_ENABLED=true` only when all required SQL values are provided.
- Check SQL host/port reachability from this server.
- For internal/self-signed TLS setup, tune:
  - `SQLSERVER_ENCRYPT`
  - `SQLSERVER_TRUST_SERVER_CERTIFICATE`

### Excel SQL Sync fails for specific rows
- Confirm required headers exactly match template names.
- Ensure `UserId` and `FolderId` are valid existing `uniqueidentifier` values.
- Ensure `CreatedBy` is not empty.
- Use `GET /api/sqlsync/template` and align source columns to sample format.

### Data reset after deployment
- Ensure `DATA_FILE` path points to persistent storage volume.
- Do not mount temp filesystem for `data/storage.json`.

## 11) Deployment Notes

- This app is suitable for environments without DB access.
- Persist `DATA_FILE` on durable disk/volume.
- Keep `.env` secret and do not commit it.
- If running multiple instances, do not share this JSON file without a proper lock strategy.
