const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const mssql = require("mssql");
const XLSX = require("xlsx");
const { connectSqlServer, getSqlServerPool } = require("../config/sqlserver");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const REQUIRED_HEADERS = [
  "FileType",
  "FileUrl",
  "KnowledgeSource",
  "KnowledgeTags",
  "JobAction",
  "JobStatus",
  "ScheduledAt",
  "CreatedBy",
];

const OPTIONAL_HEADERS = [
  "FileId",
  "QueueId",
  "JobId",
  "JobProgress",
  "LastErrorCode",
  "LastErrorMessage",
  "ScheduledStart",
  "ScheduledAttempts",
  "HasFinished",
  "QueueIsDeleted",
  "QueueModifiedBy",
  "QueueModified",
  "HasUpdated",
  "KnowledgeType",
];

function logSqlInfo(action, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(`[SqlSync] ${action}`, meta);
}

function logSqlError(action, error, meta = {}) {
  // eslint-disable-next-line no-console
  console.error(`[SqlSync] ${action} failed`, {
    ...meta,
    message: error?.message,
    code: error?.code,
    number: error?.number,
    originalError: error?.originalError?.info?.message,
  });
}

function toPositiveInt(value, fallback, maxValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return fallback;
  return Math.min(normalized, maxValue);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function parseExcelDate(value, fieldName, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${fieldName} is required.`);
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) throw new Error(`${fieldName} has invalid Excel date value.`);
    return new Date(
      Date.UTC(parsed.y, (parsed.m || 1) - 1, parsed.d || 1, parsed.H || 0, parsed.M || 0, parsed.S || 0)
    );
  }

  const parsedDate = new Date(String(value).trim());
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`${fieldName} has invalid date format.`);
  }
  return parsedDate;
}

function parseExcelRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("Excel file has no worksheet.");
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function ensureRequiredHeaders(rows) {
  const first = rows[0] || {};
  const missing = REQUIRED_HEADERS.filter((header) => !(header in first));
  if (missing.length > 0) {
    throw new Error(`Missing required header(s): ${missing.join(", ")}`);
  }
}

function normalizeRow(raw, rowNumber) {
  const createdBy = String(raw.CreatedBy || "").trim();
  const queueId = crypto.randomUUID();

  return {
    rowNumber,
    queueId,
    fileId: "",
    createdBy,
    fileType: String(raw.FileType || "").trim(),
    fileUrl: String(raw.FileUrl || "").trim(),
    knowledgeSource: String(raw.KnowledgeSource || "").trim(),
    knowledgeTags: String(raw.KnowledgeTags || "").trim(),
    jobId: String(raw.JobId || "").trim() || null,
    jobAction: String(raw.JobAction || "").trim(),
    jobStatus: toInt(raw.JobStatus, 0),
    jobProgress: String(raw.JobProgress || "").trim() || null,
    lastErrorCode: String(raw.LastErrorCode || "").trim() || null,
    lastErrorMessage: String(raw.LastErrorMessage || "").trim() || null,
    scheduledAt: parseExcelDate(raw.ScheduledAt, "ScheduledAt", true),
    scheduledStart: parseExcelDate(raw.ScheduledStart, "ScheduledStart", false),
    scheduledAttempts: toInt(raw.ScheduledAttempts, 0),
    hasFinished: toBool(raw.HasFinished, false),
    queueCreated: parseExcelDate(raw.Created, "Created", false) || new Date(),
    queueIsDeleted: toBool(raw.QueueIsDeleted, false),
    queueModified: parseExcelDate(raw.Modified, "Modified", false),
    queueModifiedBy: String(raw.QueueModifiedBy || "").trim() || null,
    hasUpdated: toBool(raw.HasUpdated, false),
    knowledgeType: toInt(raw.KnowledgeType, 0),
  };
}

function validateNormalizedRow(row) {
  const required = [
    ["FileType", row.fileType],
    ["FileUrl", row.fileUrl],
    ["KnowledgeSource", row.knowledgeSource],
    ["KnowledgeTags", row.knowledgeTags],
    ["JobAction", row.jobAction],
    ["CreatedBy", row.createdBy],
  ];
  const missing = required.filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing value(s): ${missing.join(", ")}`);
  }
}

async function syncOneRow(pool, row, context = {}) {
  logSqlInfo("upload.row.insert.begin", {
    flowId: context.flowId || "",
    rowNumber: row.rowNumber,
    queueId: row.queueId,
    fileId: row.fileId,
    createdBy: row.createdBy,
  });
  const queueReq = pool.request();
  queueReq.input("Id", mssql.UniqueIdentifier, row.queueId);
  queueReq.input("FileId", mssql.NVarChar(mssql.MAX), row.fileId);
  queueReq.input("FileType", mssql.NVarChar(mssql.MAX), row.fileType);
  queueReq.input("FileUrl", mssql.NVarChar(mssql.MAX), row.fileUrl);
  queueReq.input("KnowledgeSource", mssql.NVarChar(mssql.MAX), row.knowledgeSource);
  queueReq.input("KnowledgeTags", mssql.NVarChar(mssql.MAX), row.knowledgeTags);
  queueReq.input("JobId", mssql.NVarChar(mssql.MAX), row.jobId);
  queueReq.input("JobAction", mssql.NVarChar(mssql.MAX), row.jobAction);
  queueReq.input("JobStatus", mssql.TinyInt, row.jobStatus);
  queueReq.input("JobProgress", mssql.NVarChar(mssql.MAX), row.jobProgress);
  queueReq.input("LastErrorCode", mssql.NVarChar(mssql.MAX), row.lastErrorCode);
  queueReq.input("LastErrorMessage", mssql.NVarChar(mssql.MAX), row.lastErrorMessage);
  queueReq.input("ScheduledAt", mssql.DateTimeOffset, row.scheduledAt);
  queueReq.input("ScheduledStart", mssql.DateTimeOffset, row.scheduledStart);
  queueReq.input("ScheduledAttempts", mssql.Int, row.scheduledAttempts);
  queueReq.input("HasFinished", mssql.Bit, row.hasFinished);
  queueReq.input("Created", mssql.DateTimeOffset, row.queueCreated);
  queueReq.input("CreatedBy", mssql.NVarChar(250), row.createdBy);
  queueReq.input("IsDeleted", mssql.Bit, row.queueIsDeleted);
  queueReq.input("Modified", mssql.DateTimeOffset, row.queueModified);
  queueReq.input("ModifiedBy", mssql.NVarChar(250), row.queueModifiedBy);
  queueReq.input("HasUpdated", mssql.Bit, row.hasUpdated);
  queueReq.input("KnowledgeType", mssql.Int, row.knowledgeType);

  await queueReq.query(`
      INSERT INTO RepoService.dbo.AiScheduleQueues
      (Id, FileId, FileType, FileUrl, KnowledgeSource, KnowledgeTags, JobId, JobAction, JobStatus, JobProgress, LastErrorCode, LastErrorMessage, ScheduledAt, ScheduledStart, ScheduledAttempts, HasFinished, Created, CreatedBy, IsDeleted, Modified, ModifiedBy, HasUpdated, KnowledgeType)
      VALUES
      (@Id, @FileId, @FileType, @FileUrl, @KnowledgeSource, @KnowledgeTags, @JobId, @JobAction, @JobStatus, @JobProgress, @LastErrorCode, @LastErrorMessage, @ScheduledAt, @ScheduledStart, @ScheduledAttempts, @HasFinished, @Created, @CreatedBy, @IsDeleted, @Modified, @ModifiedBy, @HasUpdated, @KnowledgeType)
    `);
  logSqlInfo("upload.row.insert.success", {
    flowId: context.flowId || "",
    rowNumber: row.rowNumber,
    queueId: row.queueId,
  });
  return { queueId: row.queueId };
}

router.get("/connection-check", async (_req, res, next) => {
  try {
    await connectSqlServer();
    const pool = getSqlServerPool();
    const response = await pool.request().query(`
      SELECT
        1 AS ok,
        DB_NAME() AS dbName,
        @@SERVERNAME AS serverName,
        SYSDATETIMEOFFSET() AS nowAt
    `);
    res.json({ data: response.recordset[0] || { ok: 1 } });
  } catch (error) {
    next(error);
  }
});

router.get("/template", (_req, res) => {
  res.json({
    data: {
      requiredHeaders: REQUIRED_HEADERS,
      optionalHeaders: OPTIONAL_HEADERS,
      sampleRow: {
        FileId: "",
        FileType: "document",
        FileUrl: "https://example-bucket.s3.amazonaws.com/uploads/manual-operasi.pdf",
        KnowledgeSource: "repo-demo",
        KnowledgeTags: "Oil & Gas Production,Process Engineering",
        JobAction: "extract",
        JobStatus: 0,
        ScheduledAt: "2026-05-11T08:00:00+07:00",
        CreatedBy: "system",
      },
      defaults: {
        JobStatus: 0,
        JobId: null,
        JobProgress: null,
        LastErrorCode: null,
        LastErrorMessage: null,
        ScheduledStart: null,
        ScheduledAttempts: 0,
        HasFinished: false,
        QueueIsDeleted: false,
        QueueModified: null,
        QueueModifiedBy: null,
        HasUpdated: false,
        KnowledgeType: 0,
      },
    },
  });
});

router.get("/template-download", (_req, res, next) => {
  try {
    logSqlInfo("template.download.begin");
    const sampleRow = {
      FileId: "",
      FileType: "document",
      FileUrl: "https://example-bucket.s3.amazonaws.com/uploads/manual-operasi.pdf",
      KnowledgeSource: "repo-demo",
      KnowledgeTags: "Oil & Gas Production,Process Engineering",
      JobAction: "extract",
      JobStatus: 0,
      ScheduledAt: "2026-05-11T08:00:00+07:00",
      CreatedBy: "ingestordash",
    };

    const worksheetRows = [
      REQUIRED_HEADERS.reduce((acc, header) => {
        acc[header] = sampleRow[header] ?? "";
        return acc;
      }, {}),
    ];

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(worksheetRows, {
      header: [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS],
      skipHeader: false,
    });
    XLSX.utils.book_append_sheet(workbook, worksheet, "Template");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="sqlsync-template.xlsx"');
    res.send(buffer);
    logSqlInfo("template.download.success", { filename: "sqlsync-template.xlsx" });
  } catch (error) {
    logSqlError("template.download", error);
    next(error);
  }
});

router.get("/ai-schedule-queues", async (req, res, next) => {
  try {
    await connectSqlServer();
    const pool = getSqlServerPool();
    const createdBy = String(req.query.createdBy || "ingestordash").trim() || "ingestordash";
    const top = toPositiveInt(req.query.top, 20, 200);
    logSqlInfo("checker.aiScheduleQueues.begin", { createdBy, top });

    const response = await pool
      .request()
      .input("CreatedBy", mssql.NVarChar(250), createdBy)
      .input("TopN", mssql.Int, top).query(`
        SELECT TOP (@TopN)
          Id,
          FileId,
          FileType,
          FileUrl,
          KnowledgeSource,
          KnowledgeTags,
          JobAction,
          JobStatus,
          ScheduledAt,
          Created,
          CreatedBy,
          Modified
        FROM RepoService.dbo.AiScheduleQueues
        WHERE CreatedBy = @CreatedBy AND IsDeleted = 0
        ORDER BY Created DESC
      `);

    res.json({
      data: {
        createdBy,
        top,
        count: response.recordset.length,
        rows: response.recordset,
      },
    });
    logSqlInfo("checker.aiScheduleQueues.success", {
      createdBy,
      top,
      count: response.recordset.length,
    });
  } catch (error) {
    logSqlError("checker.aiScheduleQueues", error);
    next(error);
  }
});

router.post("/upload-excel", upload.single("file"), async (req, res, next) => {
  const flowId = crypto.randomUUID();
  try {
    logSqlInfo("upload.begin", {
      flowId,
      hasFile: Boolean(req.file),
      fileName: req.file?.originalname || "",
      fileSize: req.file?.size || 0,
      mimeType: req.file?.mimetype || "",
    });
    if (!req.file) {
      logSqlInfo("upload.reject.noFile", { flowId });
      return res.status(400).json({ message: "file is required." });
    }
    await connectSqlServer();
    const pool = getSqlServerPool();
    logSqlInfo("upload.db.connected", { flowId });
    const rows = parseExcelRows(req.file.buffer);
    logSqlInfo("upload.parse.success", { flowId, totalRows: rows.length });
    if (!rows.length) {
      logSqlInfo("upload.reject.emptyRows", { flowId });
      return res.status(400).json({ message: "Excel has no data rows." });
    }
    ensureRequiredHeaders(rows);
    logSqlInfo("upload.header.validate.success", { flowId });

    const results = [];
    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      try {
        logSqlInfo("upload.row.process.begin", { flowId, rowNumber });
        const normalized = normalizeRow(rows[index], rowNumber);
        validateNormalizedRow(normalized);
        logSqlInfo("upload.row.validate.success", {
          flowId,
          rowNumber,
          queueId: normalized.queueId,
          fileId: normalized.fileId,
          createdBy: normalized.createdBy,
        });
        const synced = await syncOneRow(pool, normalized, { flowId });
        results.push({
          rowNumber,
          ok: true,
          queueId: synced.queueId,
        });
      } catch (error) {
        logSqlError("upload.row.process", error, { flowId, rowNumber });
        results.push({
          rowNumber,
          ok: false,
          error: error.message,
        });
      }
    }

    const successCount = results.filter((item) => item.ok).length;
    res.json({
      data: {
        totalRows: rows.length,
        successCount,
        failedCount: rows.length - successCount,
        results,
      },
    });
    logSqlInfo("upload.complete", {
      flowId,
      totalRows: rows.length,
      successCount,
      failedCount: rows.length - successCount,
    });
  } catch (error) {
    logSqlError("upload", error, { flowId });
    next(error);
  }
});

module.exports = router;
