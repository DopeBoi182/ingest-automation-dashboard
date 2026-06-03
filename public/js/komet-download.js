const POLL_INTERVAL_MS = 1500;
const FORM_STATE_STORAGE_KEY = "kometDownloadFormStateV1";

const uiState = {
  runId: null,
  syncRunId: null,
  processingPage: 1,
  processingLimit: 25,
  processingTotalPages: 1,
  downloadedPage: 1,
  downloadedLimit: 25,
  downloadedTotalPages: 1,
  isPolling: false,
  pollTimer: null,
  isSyncPolling: false,
  syncPollTimer: null,
  activeTab: "processing",
  lastDownloadDir: "",
};

const logStore = [];

function showStatus(message) {
  $("#statusText").text(message);
}

function setRawOutput(payload) {
  $("#kometDownloadRawOutput").text(JSON.stringify(payload, null, 2));
}

function renderLogs() {
  if (!logStore.length) {
    $("#kometDownloadLogs").text("No logs yet.");
    return;
  }
  $("#kometDownloadLogs").text(
    logStore
      .map((entry) => JSON.stringify(entry))
      .join("\n")
  );
}

function pushLog(level, action, meta = {}) {
  const entry = {
    at: new Date().toISOString(),
    level,
    action,
    ...meta,
  };
  logStore.push(entry);
  renderLogs();
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error("[KometDownloadFE]", entry);
    return;
  }
  // eslint-disable-next-line no-console
  console.log("[KometDownloadFE]", entry);
}

function logKometInfo(action, meta = {}) {
  pushLog("info", action, meta);
}

function logKometError(action, error, meta = {}) {
  pushLog("error", action, {
    ...meta,
    message: error?.message || null,
    status: error?.status || error?.responseJSON?.status || null,
    detail: error?.responseJSON?.detail || error?.responseJSON?.message || null,
  });
}

function extractError(error) {
  const detail = error?.responseJSON?.detail || error?.responseJSON?.message;
  if (typeof detail === "string") return detail;
  if (detail) return JSON.stringify(detail);
  return error?.message || "Unknown error";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanRelativePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .replace(/^,+|,+$/g, "")
    .trim();
}

function parsePathsInput(rawInput) {
  return String(rawInput || "")
    .split(/[\n,]+/g)
    .map((item) => cleanRelativePath(item))
    .filter((item) => Boolean(item));
}

function readFormPayload() {
  const payload = {
    baseUrl: normalizeWhitespace($("#baseUrlInput").val()),
    cookies: normalizeWhitespace($("#cookieInput").val()),
    downloadDir: normalizeWhitespace($("#downloadDirInput").val()),
    singlePath: cleanRelativePath($("#singlePathInput").val()),
    paths: parsePathsInput($("#multiPathsInput").val()),
    syncToken: normalizeWhitespace($("#syncTokenInput").val()),
    syncFolderId: normalizeWhitespace($("#syncFolderIdInput").val()),
  };
  uiState.lastDownloadDir = payload.downloadDir;
  try {
    localStorage.setItem(FORM_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore localStorage failures
  }
  return payload;
}

function loadFormPayloadFromStorage() {
  try {
    const raw = localStorage.getItem(FORM_STATE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    $("#baseUrlInput").val(parsed.baseUrl || "");
    $("#cookieInput").val(parsed.cookies || "");
    $("#downloadDirInput").val(parsed.downloadDir || "");
    $("#syncTokenInput").val(parsed.syncToken || "");
    $("#syncFolderIdInput").val(parsed.syncFolderId || "");
    uiState.lastDownloadDir = normalizeWhitespace(parsed.downloadDir || "");
  } catch {
    // ignore parse/storage errors
  }
}

function validateBasePayload(payload) {
  if (!payload.baseUrl) throw new Error("baseUrl is required.");
  if (!payload.cookies) throw new Error("cookies is required.");
  if (!payload.downloadDir) throw new Error("downloadDir is required.");
}

function validateSinglePayload(payload) {
  validateBasePayload(payload);
  if (!payload.singlePath) throw new Error("singlePath is required.");
}

function validateBatchPayload(payload) {
  validateBasePayload(payload);
  if (!payload.paths.length) throw new Error("At least one path is required.");
}

async function postJsonNoCache(url, payload) {
  return $.ajax({
    url,
    method: "POST",
    cache: false,
    dataType: "json",
    contentType: "application/json",
    data: JSON.stringify(payload || {}),
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

async function getJsonNoCache(url, query = {}) {
  return $.ajax({
    url,
    method: "GET",
    cache: false,
    dataType: "json",
    data: query,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

function statusBadge(status) {
  if (status === "downloaded") return "downloaded";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "processing") return "processing";
  return "queued";
}

function renderProcessingRows(items) {
  if (!items.length) {
    $("#processingTableBody").html('<tr><td colspan="4">No data.</td></tr>');
    return;
  }
  const rows = items
    .map((item) => {
      let resultCell = "-";
      if (item.status === "downloaded" && item.downloadUrl) {
        resultCell = `<a href="${item.downloadUrl}" target="_blank" rel="noopener">Download</a>`;
      } else if (item.status === "failed") {
        resultCell = item.error || "Failed";
      } else if (item.status === "skipped") {
        resultCell = item.skipReason || "already_exists";
      }
      return `<tr>
        <td>${item.index}</td>
        <td class="url-cell">${item.relativePath || ""}</td>
        <td>${statusBadge(item.status)}</td>
        <td class="url-cell">${resultCell}</td>
      </tr>`;
    })
    .join("");
  $("#processingTableBody").html(rows);
}

function renderDownloadedRows(files) {
  if (!files.length) {
    $("#downloadedTableBody").html('<tr><td colspan="7">No files found.</td></tr>');
    return;
  }
  const rows = files
    .map((item) => {
      return `<tr>
        <td class="url-cell">${item.name}</td>
        <td>${item.bytes || 0}</td>
        <td>${item.modifiedAt || "-"}</td>
        <td>${item.syncStatus || "idle"}</td>
        <td class="url-cell">${item.syncResult || "-"}</td>
        <td><a href="${item.downloadUrl}" target="_blank" rel="noopener">Download</a></td>
        <td><button type="button" class="sync-one-btn" data-name="${encodeURIComponent(
          item.name
        )}">Sync</button></td>
      </tr>`;
    })
    .join("");
  $("#downloadedTableBody").html(rows);
}

function renderSummary(summary, reportPaths) {
  if (!summary) {
    $("#batchSummaryText").text("No active run.");
    return;
  }
  const text = [
    `state: ${summary.state}`,
    `progress: ${summary.processed}/${summary.total}`,
    `success: ${summary.success}`,
    `failed: ${summary.failed}`,
    `skipped: ${summary.skipped || 0}`,
  ].join(" | ");
  const withReports =
    summary.state === "completed" && reportPaths
      ? `${text} | reports: success, failed, skipped generated`
      : text;
  $("#batchSummaryText").text(withReports);
}

function stopPolling() {
  uiState.isPolling = false;
  if (uiState.pollTimer) {
    clearTimeout(uiState.pollTimer);
    uiState.pollTimer = null;
  }
}

function stopSyncPolling() {
  uiState.isSyncPolling = false;
  if (uiState.syncPollTimer) {
    clearTimeout(uiState.syncPollTimer);
    uiState.syncPollTimer = null;
  }
}

function schedulePolling() {
  if (!uiState.isPolling || !uiState.runId) return;
  uiState.pollTimer = setTimeout(async () => {
    await fetchBatchStatus(false);
    schedulePolling();
  }, POLL_INTERVAL_MS);
}

function scheduleSyncPolling() {
  if (!uiState.isSyncPolling || !uiState.syncRunId) return;
  uiState.syncPollTimer = setTimeout(async () => {
    await fetchSyncBatchStatus(false);
    scheduleSyncPolling();
  }, POLL_INTERVAL_MS);
}

async function fetchBatchStatus(isManual = false) {
  if (!uiState.runId) return;
  try {
    const response = await getJsonNoCache(`./api/komet-download/batch/${uiState.runId}/status`, {
      page: uiState.processingPage,
      limit: uiState.processingLimit,
    });
    const data = response?.data || {};
    const summary = data.summary || null;

    uiState.processingTotalPages = data.totalPages || 1;
    renderSummary(summary, data.reportPaths);
    renderProcessingRows(data.items || []);
    $("#processingPageText").text(`Page ${data.page || 1}/${data.totalPages || 1}`);
    setRawOutput(response);

    if (summary?.state === "completed" || summary?.state === "failed") {
      stopPolling();
      showStatus(`Batch finished: ${summary.state}`);
      await fetchDownloadedList();
    } else if (isManual) {
      showStatus(`Batch running: ${summary?.processed || 0}/${summary?.total || 0}`);
    }
  } catch (error) {
    const detail = extractError(error);
    logKometError("batch.status.error", error, { runId: uiState.runId, detail });
    showStatus(`Failed fetching batch status: ${detail}`);
  }
}

async function fetchDownloadedList() {
  const downloadDir = normalizeWhitespace($("#downloadDirInput").val() || uiState.lastDownloadDir);
  if (!downloadDir) return;

  try {
    const response = await getJsonNoCache("./api/komet-download/downloaded", {
      downloadDir,
      page: uiState.downloadedPage,
      limit: uiState.downloadedLimit,
    });
    const data = response?.data || {};
    uiState.downloadedTotalPages = data.totalPages || 1;
    renderDownloadedRows(data.files || []);
    $("#downloadedPageText").text(`Page ${data.page || 1}/${data.totalPages || 1}`);
  } catch (error) {
    const detail = extractError(error);
    logKometError("downloaded.list.error", error, { detail });
    showStatus(`Failed loading downloaded list: ${detail}`);
  }
}

async function restorePersistedState() {
  const payload = readFormPayload();
  if (!payload.downloadDir) return;

  try {
    const response = await getJsonNoCache("./api/komet-download/state", {
      downloadDir: payload.downloadDir,
    });
    const data = response?.data || {};
    const batch = data.batch || null;
    const sync = data.sync || null;

    if (batch?.runId) {
      uiState.runId = batch.runId;
      uiState.processingPage = 1;
      await fetchBatchStatus(true);
      if (batch.summary?.state === "running") {
        stopPolling();
        uiState.isPolling = true;
        schedulePolling();
      }
    }

    if (sync?.runId) {
      uiState.syncRunId = sync.runId;
      if (sync.summary?.state === "running") {
        stopSyncPolling();
        uiState.isSyncPolling = true;
        scheduleSyncPolling();
      }
      await fetchSyncBatchStatus(true);
    } else {
      await fetchDownloadedList();
    }
  } catch (error) {
    const detail = extractError(error);
    logKometError("state.restore.error", error, { detail });
  }
}

function renderSyncSummary(summary) {
  if (!summary) {
    $("#syncSummaryText").text("No sync run.");
    return;
  }
  $("#syncSummaryText").text(
    `sync state: ${summary.state} | progress: ${summary.processed}/${summary.total} | success: ${summary.success} | failed: ${summary.failed} | skipped: ${summary.skipped || 0}`
  );
}

async function fetchSyncBatchStatus(isManual = false) {
  if (!uiState.syncRunId) return;
  try {
    const response = await getJsonNoCache(`./api/komet-download/sync/batch/${uiState.syncRunId}/status`, {
      page: uiState.downloadedPage,
      limit: uiState.downloadedLimit,
    });
    const data = response?.data || {};
    const summary = data.summary || null;
    renderSyncSummary(summary);
    setRawOutput(response);
    await fetchDownloadedList();

    if (summary?.state === "completed" || summary?.state === "failed") {
      stopSyncPolling();
      showStatus(`Sync batch finished: ${summary.state}`);
    } else if (isManual) {
      showStatus(`Sync running: ${summary?.processed || 0}/${summary?.total || 0}`);
    }
  } catch (error) {
    const detail = extractError(error);
    logKometError("sync.batch.status.error", error, { runId: uiState.syncRunId, detail });
    showStatus(`Failed fetching sync status: ${detail}`);
  }
}

async function runDownloadTest(event) {
  event.preventDefault();
  const payload = readFormPayload();
  const button = $("#downloadTestBtn");
  button.prop("disabled", true);
  showStatus("Running Komet single-link download test...");

  try {
    validateSinglePayload(payload);
    const response = await postJsonNoCache("./api/komet-download/test", {
      baseUrl: payload.baseUrl,
      cookies: payload.cookies,
      downloadDir: payload.downloadDir,
      singlePath: payload.singlePath,
    });
    const data = response?.data || {};
    setRawOutput(response);
    logKometInfo("single.success", {
      savedAs: data.savedAs || "",
      bytes: data.bytes || 0,
      statusCode: data.statusCode || 0,
    });
    showStatus(`Download success: ${data.savedAs || "file saved"}`);
    await fetchDownloadedList();
  } catch (error) {
    const detail = extractError(error);
    setRawOutput({
      message: "Request failed",
      detail,
      debug: error?.responseJSON?.debug || null,
    });
    logKometError("single.error", error, { payload, detail });
    showStatus(`Download failed: ${detail}`);
  } finally {
    button.prop("disabled", false);
  }
}

async function startBatchDownload() {
  const payload = readFormPayload();
  const button = $("#startBatchBtn");
  button.prop("disabled", true);
  showStatus("Starting batch download...");

  try {
    validateBatchPayload(payload);
    const response = await postJsonNoCache("./api/komet-download/batch/start", {
      baseUrl: payload.baseUrl,
      cookies: payload.cookies,
      downloadDir: payload.downloadDir,
      paths: payload.paths,
    });
    const data = response?.data || {};
    uiState.runId = data.runId || null;
    uiState.processingPage = 1;
    setRawOutput(response);
    logKometInfo("batch.started", {
      runId: uiState.runId,
      total: data.total || payload.paths.length,
    });

    if (!uiState.runId) {
      throw new Error("Missing runId from start response.");
    }
    stopPolling();
    uiState.isPolling = true;
    await fetchBatchStatus(true);
    schedulePolling();
    showStatus(`Batch started. runId=${uiState.runId}`);
  } catch (error) {
    const detail = extractError(error);
    logKometError("batch.start.error", error, { detail });
    showStatus(`Failed starting batch: ${detail}`);
  } finally {
    button.prop("disabled", false);
  }
}

async function syncSingleFile(fileName) {
  const payload = readFormPayload();
  if (!payload.downloadDir) {
    showStatus("downloadDir is required.");
    return;
  }
  if (!payload.syncToken) {
    showStatus("Sync token is required.");
    return;
  }

  try {
    showStatus(`Syncing file: ${fileName}`);
    const response = await postJsonNoCache("./api/komet-download/sync/single", {
      downloadDir: payload.downloadDir,
      name: fileName,
      token: payload.syncToken,
      folderId: payload.syncFolderId || null,
    });
    setRawOutput(response);
    logKometInfo("sync.single.success", {
      name: fileName,
      downloadDir: payload.downloadDir,
    });
    showStatus(`Sync success: ${fileName}`);
    await fetchDownloadedList();
  } catch (error) {
    const detail = extractError(error);
    logKometError("sync.single.error", error, {
      name: fileName,
      downloadDir: payload.downloadDir,
      detail,
    });
    showStatus(`Sync failed: ${detail}`);
  }
}

async function startBulkSync() {
  const payload = readFormPayload();
  if (!payload.downloadDir) {
    showStatus("downloadDir is required.");
    return;
  }
  if (!payload.syncToken) {
    showStatus("Sync token is required.");
    return;
  }

  try {
    showStatus("Starting bulk sync...");
    const response = await postJsonNoCache("./api/komet-download/sync/batch/start", {
      downloadDir: payload.downloadDir,
      token: payload.syncToken,
      folderId: payload.syncFolderId || null,
    });
    const data = response?.data || {};
    uiState.syncRunId = data.runId || null;
    setRawOutput(response);
    logKometInfo("sync.batch.started", {
      runId: uiState.syncRunId,
      total: data.total || 0,
    });

    if (!uiState.syncRunId) {
      throw new Error("Missing sync runId from response.");
    }

    stopSyncPolling();
    uiState.isSyncPolling = true;
    await fetchSyncBatchStatus(true);
    scheduleSyncPolling();
  } catch (error) {
    const detail = extractError(error);
    logKometError("sync.batch.start.error", error, { detail });
    showStatus(`Failed starting sync batch: ${detail}`);
  }
}

function setActiveTab(tabName) {
  uiState.activeTab = tabName;
  const isProcessing = tabName === "processing";
  $("#processingTabPanel").toggleClass("is-hidden", !isProcessing);
  $("#downloadedTabPanel").toggleClass("is-hidden", isProcessing);
  $("#processingTabBtn")
    .toggleClass("active", isProcessing)
    .toggleClass("secondary", !isProcessing);
  $("#downloadedTabBtn")
    .toggleClass("active", !isProcessing)
    .toggleClass("secondary", isProcessing);
}

function clearLogsAndOutput() {
  logStore.length = 0;
  renderLogs();
  setRawOutput({ message: "cleared" });
  showStatus("Logs and output cleared.");
}

async function checkStorageHealth() {
  const button = $("#checkStorageHealthBtn");
  button.prop("disabled", true);
  showStatus("Checking storage health...");
  try {
    const response = await getJsonNoCache("./api/health/storage");
    const data = response?.data || {};
    const storage = data.data || {};
    setRawOutput(response);
    logKometInfo("storage.health.success", {
      dataFilePath: storage.dataFilePath || null,
      hostname: storage.hostname || null,
      pid: storage.pid || null,
      timestamp: storage.timestamp || null,
    });
    showStatus(
      `Storage OK: ${storage.dataFilePath || "-"} | ${storage.hostname || "-"}#${
        storage.pid || "-"
      }`
    );
  } catch (error) {
    const detail = extractError(error);
    logKometError("storage.health.error", error, { detail });
    showStatus(`Storage health check failed: ${detail}`);
  } finally {
    button.prop("disabled", false);
  }
}

$(document).ready(() => {
  loadFormPayloadFromStorage();

  $("#kometDownloadForm").on("submit", runDownloadTest);
  $("#startBatchBtn").on("click", startBatchDownload);
  $("#checkStorageHealthBtn").on("click", checkStorageHealth);
  $("#clearLogsBtn").on("click", clearLogsAndOutput);

  $("#processingTabBtn").on("click", async () => {
    setActiveTab("processing");
    await fetchBatchStatus(true);
  });
  $("#downloadedTabBtn").on("click", async () => {
    setActiveTab("downloaded");
    await fetchDownloadedList();
  });

  $("#processingPrevBtn").on("click", async () => {
    uiState.processingPage = Math.max(1, uiState.processingPage - 1);
    await fetchBatchStatus(true);
  });
  $("#processingNextBtn").on("click", async () => {
    uiState.processingPage = Math.min(uiState.processingTotalPages || 1, uiState.processingPage + 1);
    await fetchBatchStatus(true);
  });

  $("#downloadedPrevBtn").on("click", async () => {
    uiState.downloadedPage = Math.max(1, uiState.downloadedPage - 1);
    await fetchDownloadedList();
  });
  $("#downloadedNextBtn").on("click", async () => {
    uiState.downloadedPage = Math.min(uiState.downloadedTotalPages || 1, uiState.downloadedPage + 1);
    await fetchDownloadedList();
  });
  $("#downloadedRefreshBtn").on("click", fetchDownloadedList);
  $("#syncBulkBtn").on("click", startBulkSync);
  $("#downloadedTableBody").on("click", ".sync-one-btn", async (event) => {
    const encodedName = String($(event.currentTarget).data("name") || "");
    const fileName = decodeURIComponent(encodedName);
    await syncSingleFile(fileName);
  });

  logKometInfo("page.ready");
  restorePersistedState().catch((error) => {
    logKometError("page.restore.error", error, { detail: extractError(error) });
  });
});
