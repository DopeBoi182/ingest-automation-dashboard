const POLL_INTERVAL_MS = 1500;

const uiState = {
  runId: null,
  processingPage: 1,
  processingLimit: 25,
  processingTotalPages: 1,
  downloadedPage: 1,
  downloadedLimit: 25,
  downloadedTotalPages: 1,
  isPolling: false,
  pollTimer: null,
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
  };
  uiState.lastDownloadDir = payload.downloadDir;
  return payload;
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
    $("#downloadedTableBody").html('<tr><td colspan="4">No files found.</td></tr>');
    return;
  }
  const rows = files
    .map((item) => {
      return `<tr>
        <td class="url-cell">${item.name}</td>
        <td>${item.bytes || 0}</td>
        <td>${item.modifiedAt || "-"}</td>
        <td><a href="${item.downloadUrl}" target="_blank" rel="noopener">Download</a></td>
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

function schedulePolling() {
  if (!uiState.isPolling || !uiState.runId) return;
  uiState.pollTimer = setTimeout(async () => {
    await fetchBatchStatus(false);
    schedulePolling();
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

$(document).ready(() => {
  $("#kometDownloadForm").on("submit", runDownloadTest);
  $("#startBatchBtn").on("click", startBatchDownload);
  $("#clearLogsBtn").on("click", clearLogsAndOutput);

  $("#processingTabBtn").on("click", () => setActiveTab("processing"));
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

  logKometInfo("page.ready");
});
