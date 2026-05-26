function showStatus(message) {
  $("#statusText").text(message);
}

function extractError(error) {
  const detail = error?.responseJSON?.detail || error?.responseJSON?.message;
  if (typeof detail === "string") return detail;
  if (detail) return JSON.stringify(detail);
  return error?.message || "Unknown error";
}

const logStore = [];

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
    message: error?.message,
    status: error?.status || error?.responseJSON?.status || null,
    detail: error?.responseJSON?.detail || error?.responseJSON?.message || null,
  });
}

function readFormPayload() {
  return {
    baseUrl: String($("#baseUrlInput").val() || "").trim(),
    cookies: String($("#cookieInput").val() || "").trim(),
    downloadDir: String($("#downloadDirInput").val() || "").trim(),
    singlePath: String($("#singlePathInput").val() || "").trim(),
  };
}

function validatePayload(payload) {
  logKometInfo("validate.begin", payload);
  if (!payload.baseUrl) throw new Error("baseUrl is required.");
  if (!payload.cookies) throw new Error("cookies is required.");
  if (!payload.downloadDir) throw new Error("downloadDir is required.");
  if (!payload.singlePath) throw new Error("singlePath is required.");
  logKometInfo("validate.success", {
    baseUrl: payload.baseUrl,
    downloadDir: payload.downloadDir,
    singlePath: payload.singlePath,
  });
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

async function runDownloadTest(event) {
  event.preventDefault();
  const button = $("#downloadTestBtn");
  const payload = readFormPayload();

  button.prop("disabled", true);
  showStatus("Running Komet single-link download test...");

  try {
    validatePayload(payload);
    logKometInfo("request.send", {
      url: "./api/komet-download/test",
      payload,
    });

    const response = await postJsonNoCache("./api/komet-download/test", payload);
    const data = response?.data || {};
    setRawOutput(response);

    logKometInfo("response.success", {
      statusCode: data.statusCode || null,
      url: data.url || "",
      savedAs: data.savedAs || "",
      bytes: data.bytes || 0,
      contentType: data.contentType || "",
      downloadDir: payload.downloadDir,
    });
    logKometInfo("download.saved", {
      savedPath: data.savedPath || "",
      elapsedMs: data.elapsedMs || null,
    });

    showStatus(`Download success: ${data.savedAs || "file saved"}`);
  } catch (error) {
    const detail = extractError(error);
    setRawOutput({
      message: "Request failed",
      detail,
      debug: error?.responseJSON?.debug || null,
    });
    logKometError("response.error", error, {
      payload,
      detail,
      debug: error?.responseJSON?.debug || null,
    });
    showStatus(`Download failed: ${detail}`);
  } finally {
    button.prop("disabled", false);
  }
}

function clearLogsAndOutput() {
  logStore.length = 0;
  renderLogs();
  setRawOutput({ message: "cleared" });
  showStatus("Logs and output cleared.");
}

$(document).ready(() => {
  $("#kometDownloadForm").on("submit", runDownloadTest);
  $("#clearLogsBtn").on("click", clearLogsAndOutput);
  logKometInfo("page.ready");
});
