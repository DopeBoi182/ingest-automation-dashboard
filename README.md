# Automation AI Ingestion Dashboard

Single Node.js app with local JSON storage + jQuery dashboard to:
- enqueue comma-separated URLs into a queue pool,
- auto-start the first queued URL immediately after submit when worker is idle,
- process only one active job at a time (single worker),
- store each job in `data/storage.json`,
- auto-refresh active process status every 30 seconds and continue next queue item,
- force replace current process by canceling it and starting selected queued item,
- maintain global settings (`knowledge_source`, `knowledge_tags`, etc.),
- ask QnA via extractor chat endpoint.

## Stack
- Node.js + Express
- Local JSON file storage
- jQuery + HTML + CSS

## Setup
1. Copy `.env.example` to `.env`.
2. Update endpoint values and storage file path if needed.
3. Install dependencies:
   - `npm install`
4. Run app:
   - `npm run dev`
   - or `npm start`

Open dashboard at `http://localhost:9001`.
- S3 page: `http://localhost:9001/s3.html`

## Optional: SQL Server Connection
SQL Server is optional and does not replace current JSON (`lowdb`) storage.

1. Set `SQLSERVER_ENABLED=true` in `.env`.
2. Preferred: set one `SQLSERVER_CONNECTION_STRING` value.
   - Example: `Server=host,1433;Database=YourDb;User ID=sa;Password=your_password;TrustServerCertificate=True;`
3. Or fill required values separately:
   - `SQLSERVER_HOST`
   - `SQLSERVER_DATABASE`
   - `SQLSERVER_USER`
   - `SQLSERVER_PASSWORD`
4. Optional tuning values:
   - `SQLSERVER_PORT` (default `1433`)
   - `SQLSERVER_ENCRYPT` (default `true`)
   - `SQLSERVER_TRUST_SERVER_CERTIFICATE` (default `false`)
   - `SQLSERVER_CONNECTION_TIMEOUT_MS` (default `15000`)
   - `SQLSERVER_REQUEST_TIMEOUT_MS` (default `30000`)
   - `SQLSERVER_POOL_MAX` (default `10`)
   - `SQLSERVER_POOL_MIN` (default `0`)
   - `SQLSERVER_POOL_IDLE_TIMEOUT_MS` (default `30000`)

On startup, check server log:
- `[SQLServer] enabled and connected` means connection is successful.
- If required env values are missing, startup fails with a clear error message.

## Main API endpoints
- `POST /api/jobs/queue` with body `{ "urls": "a.com,b.pdf,c.xlsx" }` (enqueue + auto-start when idle)
- `POST /api/jobs/process/trigger`
- `POST /api/jobs/process/tick`
- `POST /api/jobs/:jobId/refresh`
- `POST /api/jobs/refresh-all`
- `POST /api/jobs/queue/:id/force-replace`
- `GET /api/jobs/process`
- `GET /api/jobs/queue`
- `GET /api/jobs`
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/qna` with body `{ "question": "..." }`
- `GET /api/s3/health`
- `GET /api/s3/files/urls?prefix=...&maxKeys=100&mode=presigned|public&ttlSeconds=900`
- `POST /api/s3/ingest` with body `{ "keys": ["path/file.pdf"], "mode": "presigned|public", "ttlSeconds": 900 }`
- `GET /api/sqlsync/connection-check`
- `GET /api/sqlsync/template`
- `POST /api/sqlsync/upload-excel` (multipart form-data, `file`)

## Excel SQL Sync (Main Page)
Use the **Excel SQL Sync** card on `/` to:
- run SQL connection check,
- view the expected Excel template,
- upload and sync rows into:
  - `RepoService.dbo.FileMetadataRepo` first,
  - then `RepoService.dbo.AiScheduleQueues` using inserted `FileMetadataRepo.Id` as `FileId`.

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

### Optional Headers (with defaults)
Optional columns include IDs and status fields such as:
- `FileMetadataId`, `QueueId`, `S3Key`, `AbstractContent`, `ThumbnailKey`
- `AiStatus` (default `0`)
- `IsBookmark` (default `false`)
- `IsPublish` (default `false`)
- `Kind` (default `0`)
- `FileIsDeleted` (default `false`)
- `DocumentLocked` (default `false`)
- `ScheduledAttempts` (default `0`)
- `HasFinished` (default `false`)
- `QueueIsDeleted` (default `false`)
- `HasUpdated` (default `false`)
- `KnowledgeType` (default `0`)

Use `GET /api/sqlsync/template` to get the latest required/optional header list and a sample row payload.

## External endpoints used
- Health: `http://16.79.175.142:806/`
- Extract: `http://16.79.175.142:806/api/v1/jobs/extract`
- Status: `http://16.79.175.142:806/api/v1/jobs/{job_id}`
- QnA: `http://16.79.175.142:806/api/v1/chat/qna`
