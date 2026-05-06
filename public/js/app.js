function showStatus(message) {
  $("#statusText").text(message);
}

let tickInFlight = false;

function logFeInfo(action, meta = {}) {
  console.log(`[IngestFE] ${action}`, meta);
}

function logFeError(action, error, meta = {}) {
  console.error(`[IngestFE] ${action} failed`, {
    ...meta,
    message: error?.message,
    status: error?.status || error?.responseJSON?.status,
    detail: error?.responseJSON?.detail || error?.responseJSON?.message,
  });
}

function toLocalDateString(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function renderJobSource(job) {
  if (job?.input_type === "file") {
    return job.file_name || "[uploaded file]";
  }
  return job?.file_url || "-";
}

function processRowTemplate(job) {
  const actionCell = job.job_id
    ? `<button class="secondary refresh-row-btn" data-job-id="${job.job_id}">Refresh</button>`
    : "-";
  return `
    <tr>
      <td>${renderJobSource(job)}</td>
      <td>${job.job_id || "-"}</td>
      <td>${job.status || "-"}</td>
      <td>${job.stage || "-"}</td>
      <td>${job.progress ?? 0}</td>
      <td>${toLocalDateString(job.updated_at_remote || job.updatedAt)}</td>
      <td>${actionCell}</td>
    </tr>
  `;
}

function queueRowTemplate(job) {
  return `
    <tr data-id="${job._id}">
      <td>${job.queue_order ?? "-"}</td>
      <td>${renderJobSource(job)}</td>
      <td>${toLocalDateString(job.createdAt)}</td>
      <td>
        <div class="row-actions">
          <button class="danger force-replace-btn" data-id="${job._id}">
            Force Add to Process
          </button>
          <button class="secondary delete-queue-btn" data-id="${job._id}">
            Delete
          </button>
        </div>
      </td>
    </tr>
  `;
}

function finishedRowTemplate(job) {
  return `
    <tr>
      <td>${renderJobSource(job)}</td>
      <td>${job.job_id || "-"}</td>
      <td>${job.status || "-"}</td>
      <td>${job.stage || "-"}</td>
      <td>${job.progress ?? 0}</td>
      <td>${toLocalDateString(job.finished_at || job.updatedAt)}</td>
      <td>${job.error || "-"}</td>
    </tr>
  `;
}

async function loadSettings() {
  logFeInfo("loadSettings.begin");
  const response = await $.getJSON("./api/settings");
  const s = response.data || {};
  $("#knowledgeSource").val(s.knowledge_source || "");
  $("#knowledgeTags").val((s.knowledge_tags || []).join(","));
  $("#provider").val(s.provider || "");
  $("#vdbCollection").val(s.vdb_collection || "");
  $("#vectorGroup").val(s.vector_group || "");
  $("#callbackUrl").val(s.callback_url || "");
  $("#chunkSize").val(s.chunk_size || 1000);
  $("#chunkOverlap").val(s.chunk_overlap || 200);
  $("#forceFlag").val(String(s.force ?? true));
  $("#promptText").val(s.prompt || "");
  logFeInfo("loadSettings.success", {
    provider: s.provider || "",
    knowledgeSource: s.knowledge_source || "",
  });
}

async function loadProcess() {
  logFeInfo("loadProcess.begin");
  const response = await $.getJSON("./api/jobs/process");
  const job = response.data;
  if (!job) {
    logFeInfo("loadProcess.empty");
    $("#processBody").html(`<tr><td colspan="7">No active processing item.</td></tr>`);
    return;
  }
  $("#processBody").html(processRowTemplate(job));
  logFeInfo("loadProcess.success", { jobId: job.job_id || "", status: job.status || "" });
}

async function loadQueue() {
  logFeInfo("loadQueue.begin");
  const response = await $.getJSON("./api/jobs/queue");
  const rows = (response.data || []).map(queueRowTemplate).join("");
  $("#queueBody").html(rows || `<tr><td colspan="4">Queue is empty.</td></tr>`);
  logFeInfo("loadQueue.success", { queueCount: (response.data || []).length });
}

async function loadFinished() {
  logFeInfo("loadFinished.begin");
  const response = await $.getJSON("./api/jobs/finished");
  const rows = (response.data || []).map(finishedRowTemplate).join("");
  $("#finishedBody").html(rows || `<tr><td colspan="7">No completed or failed jobs yet.</td></tr>`);
  logFeInfo("loadFinished.success", { finishedCount: (response.data || []).length });
}

async function loadQueueViews() {
  await Promise.all([loadProcess(), loadQueue(), loadFinished()]);
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    knowledge_source: $("#knowledgeSource").val(),
    knowledge_tags: $("#knowledgeTags").val(),
    provider: $("#provider").val(),
    vdb_collection: $("#vdbCollection").val(),
    vector_group: $("#vectorGroup").val(),
    callback_url: $("#callbackUrl").val(),
    chunk_size: Number($("#chunkSize").val()),
    chunk_overlap: Number($("#chunkOverlap").val()),
    force: $("#forceFlag").val() === "true",
    prompt: $("#promptText").val(),
  };

  logFeInfo("saveSettings.begin", {
    provider: payload.provider || "",
    knowledgeSource: payload.knowledge_source || "",
  });
  await $.ajax({
    url: "./api/settings",
    method: "PUT",
    contentType: "application/json",
    data: JSON.stringify(payload),
  });
  showStatus("Settings saved.");
  logFeInfo("saveSettings.success");
}

async function ingestUrls(event) {
  event.preventDefault();
  const urls = $("#urlInput").val();
  if (!urls.trim()) {
    showStatus("Please enter URL list.");
    return;
  }

  $("#submitIngestBtn").prop("disabled", true);
  showStatus("Adding URLs to queue and auto-starting first item...");
  logFeInfo("ingestUrls.begin", { urlCount: parseUrlInputCount(urls) });

  try {
    await $.ajax({
      url: "./api/jobs/queue",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ urls }),
    });
    $("#urlInput").val("");
    await loadQueueViews();
    showStatus("URLs queued. First item auto-started if processor was idle.");
    logFeInfo("ingestUrls.success");
  } finally {
    $("#submitIngestBtn").prop("disabled", false);
  }
}

async function executeOne() {
  $("#executeOneBtn").prop("disabled", true);
  showStatus("Executing next queue item...");
  try {
    logFeInfo("executeOne.begin");
    await $.ajax({
      url: "./api/jobs/process/trigger",
      method: "POST",
    });
    await loadQueueViews();
    showStatus("Execute one done.");
    logFeInfo("executeOne.success");
  } finally {
    $("#executeOneBtn").prop("disabled", false);
  }
}

async function refreshOne(jobId) {
  logFeInfo("refreshOne.begin", { jobId });
  showStatus(`Refreshing ${jobId} ...`);
  await $.ajax({
    url: `./api/jobs/${encodeURIComponent(jobId)}/refresh`,
    method: "POST",
  });
  await loadQueueViews();
  showStatus(`Refreshed ${jobId}.`);
  logFeInfo("refreshOne.success", { jobId });
}

async function refreshAllState() {
  $("#refreshAllBtn").prop("disabled", true);
  showStatus("Refreshing all states...");
  try {
    logFeInfo("refreshAllState.begin");
    await $.ajax({
      url: "./api/jobs/refresh-all",
      method: "POST",
    });
    await loadQueueViews();
    showStatus("Refresh all state completed.");
    logFeInfo("refreshAllState.success");
  } finally {
    $("#refreshAllBtn").prop("disabled", false);
  }
}

async function forceReplace(queueId) {
  logFeInfo("forceReplace.begin", { queueId });
  showStatus("Force replacing current process...");
  await $.ajax({
    url: `./api/jobs/queue/${encodeURIComponent(queueId)}/force-replace`,
    method: "POST",
  });
  await loadQueueViews();
  showStatus("Force add queue to process completed.");
  logFeInfo("forceReplace.success", { queueId });
}

async function deleteQueueItem(queueId) {
  logFeInfo("deleteQueueItem.begin", { queueId });
  showStatus("Deleting queued item...");
  await $.ajax({
    url: `./api/jobs/queue/${encodeURIComponent(queueId)}`,
    method: "DELETE",
  });
  await loadQueueViews();
  showStatus("Queued item deleted.");
  logFeInfo("deleteQueueItem.success", { queueId });
}

async function clearQueue() {
  logFeInfo("clearQueue.begin");
  showStatus("Clearing queued items...");
  const response = await $.ajax({
    url: "./api/jobs/queue",
    method: "DELETE",
  });
  await loadQueueViews();
  const deletedCount = response.data?.deletedCount ?? 0;
  showStatus(`Cleared ${deletedCount} queued item(s).`);
  logFeInfo("clearQueue.success", { deletedCount });
}

function parseUrlInputCount(urls) {
  return String(urls || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function updateSelectedFilesText() {
  const input = $("#filesInput").get(0);
  const files = input?.files ? Array.from(input.files) : [];
  if (!files.length) {
    $("#filesSelectedText").text("No files selected.");
    return;
  }
  const names = files.map((file) => file.name).join(", ");
  $("#filesSelectedText").text(`${files.length} file(s): ${names}`);
}

async function ingestFiles(event) {
  event.preventDefault();
  const input = $("#filesInput").get(0);
  const files = input?.files ? Array.from(input.files) : [];
  if (!files.length) {
    showStatus("Please choose at least one file.");
    return;
  }

  const formData = new FormData();
  files.forEach((file) => formData.append("file", file));
  logFeInfo("ingestFiles.begin", {
    fileCount: files.length,
    fileNames: files.map((file) => file.name),
  });

  $("#submitFilesBtn").prop("disabled", true);
  showStatus("Uploading file(s) to queue and auto-starting first item...");
  try {
    await $.ajax({
      url: "./api/jobs/queue/files",
      method: "POST",
      data: formData,
      processData: false,
      contentType: false,
    });
    $("#filesInput").val("");
    updateSelectedFilesText();
    await loadQueueViews();
    showStatus("Files queued. First item auto-started if processor was idle.");
    logFeInfo("ingestFiles.success", { fileCount: files.length });
  } finally {
    $("#submitFilesBtn").prop("disabled", false);
  }
}

async function runTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    logFeInfo("runTick.begin");
    await $.ajax({
      url: "./api/jobs/process/tick",
      method: "POST",
    });
    await loadQueueViews();
    showStatus("Auto refresh done.");
    logFeInfo("runTick.success");
  } finally {
    tickInFlight = false;
  }
}

function setActiveTab(tabName) {
  const tabs = ["process", "queue", "finished", "files"];
  tabs.forEach((tab) => {
    const isActive = tab === tabName;
    $(`.tab-btn[data-tab="${tab}"]`).toggleClass("active", isActive);
    $(`#tab-${tab}`).toggleClass("is-hidden", !isActive);
  });
}

function setupTabs() {
  $(".tab-btn").on("click", function onTabClick() {
    setActiveTab($(this).data("tab"));
  });
  setActiveTab("process");
}

function setupAutoTick() {
  setInterval(() => {
    runTick().catch((error) => {
      showStatus(`Auto refresh failed: ${error.responseJSON?.detail || error.message}`);
    });
  }, 30000);
}

function extractError(error) {
  const detail = error.responseJSON?.detail;
  if (typeof detail === "string") return detail;
  if (detail) return JSON.stringify(detail);
  return error.responseJSON?.message || error.message;
}

function renderHealthcheckerResult(payload) {
  const summary = payload?.summary || {};
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  const lines = [];
  lines.push(`Base URL: ${payload?.baseUrl || "-"}`);
  lines.push(`Summary: ${summary.passed ?? 0}/${summary.total ?? checks.length} passed`);
  lines.push("");
  checks.forEach((item) => {
    const mark = item.ok ? "[OK]" : "[FAIL]";
    const statusCode = item.statusCode ?? "-";
    const latencyMs = item.latencyMs ?? "-";
    const error = item.error ? ` | error=${item.error}` : "";
    lines.push(`${mark} ${item.path} | status=${statusCode} | latencyMs=${latencyMs}${error}`);
  });
  return lines.join("\n");
}

function renderS3ConnectivityResult(payload) {
  const lines = [];
  lines.push(`OK: ${payload?.ok ? "true" : "false"}`);
  lines.push(`Provider: ${payload?.provider || "-"}`);
  lines.push(`Bucket: ${payload?.bucket || "-"}`);
  lines.push(`Endpoint: ${payload?.endpoint || "-"}`);
  lines.push(`TLS mode: ${payload?.tlsMode || "-"}`);
  lines.push(`Latency (ms): ${payload?.latencyMs ?? "-"}`);
  lines.push(`Timestamp: ${payload?.timestamp || "-"}`);
  if (payload?.error?.message) {
    lines.push(`Error: ${payload.error.message}`);
  }
  return lines.join("\n");
}

async function runHealthchecker() {
  $("#healthcheckerBtn").prop("disabled", true);
  $("#healthcheckerOutput").text("Checking health endpoints...");
  showStatus("Running healthchecker...");
  logFeInfo("healthchecker.begin");
  try {
    const response = await $.getJSON("./api/healthchecker");
    const data = response.data || {};
    $("#healthcheckerOutput").text(renderHealthcheckerResult(data));
    const summary = data.summary || {};
    showStatus(`Healthchecker done: ${summary.passed ?? 0}/${summary.total ?? 0} passed.`);
    logFeInfo("healthchecker.success", {
      total: summary.total ?? 0,
      passed: summary.passed ?? 0,
      failed: summary.failed ?? 0,
    });
  } catch (error) {
    const msg = extractError(error);
    $("#healthcheckerOutput").text(`Healthchecker failed.\n${msg}`);
    showStatus(`Healthchecker failed: ${msg}`);
    logFeError("healthchecker", error);
  } finally {
    $("#healthcheckerBtn").prop("disabled", false);
  }
}

async function runS3ConnectivityCheck() {
  $("#s3ConnectivityBtn").prop("disabled", true);
  $("#s3ConnectivityOutput").text("Checking S3 connectivity...");
  showStatus("Running S3 connectivity check...");
  logFeInfo("s3Connectivity.begin");
  try {
    const response = await $.getJSON("./api/s3/health/live");
    const data = response.data || {};
    $("#s3ConnectivityOutput").text(renderS3ConnectivityResult(data));
    showStatus(
      `S3 connectivity OK (${data.tlsMode || "-"}, ${data.latencyMs ?? "-"}ms, bucket ${
        data.bucket || "-"
      }).`
    );
    logFeInfo("s3Connectivity.success", {
      bucket: data.bucket || "",
      endpoint: data.endpoint || "",
      tlsMode: data.tlsMode || "",
      latencyMs: data.latencyMs ?? null,
    });
  } catch (error) {
    const data = error.responseJSON?.data;
    if (data) {
      $("#s3ConnectivityOutput").text(renderS3ConnectivityResult(data));
      showStatus(`S3 connectivity failed: ${data.error?.message || extractError(error)}`);
    } else {
      const msg = extractError(error);
      $("#s3ConnectivityOutput").text(`S3 connectivity failed.\n${msg}`);
      showStatus(`S3 connectivity failed: ${msg}`);
    }
    logFeError("s3Connectivity", error);
  } finally {
    $("#s3ConnectivityBtn").prop("disabled", false);
  }
}

async function bootstrap() {
  try {
    await loadSettings();
    await loadQueueViews();
  } catch (error) {
    showStatus(`Failed to load initial data: ${extractError(error)}`);
  }
}

async function askQna(event) {
  event.preventDefault();
  const question = $("#questionInput").val().trim();
  if (!question) return;
  logFeInfo("askQna.begin", { questionLength: question.length });
  showStatus("Sending question...");
  const response = await $.ajax({
    url: "./api/qna",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({ question }),
  });
  $("#qnaResponse").text(JSON.stringify(response.data, null, 2));
  showStatus("QnA complete.");
  logFeInfo("askQna.success");
}

$(document).ready(async () => {
  $(document).ajaxSend((_event, jqxhr, settings) => {
    logFeInfo("ajax.send", { method: settings.type || "GET", url: settings.url || "" });
  });

  $(document).ajaxSuccess((_event, jqxhr, settings) => {
    logFeInfo("ajax.success", {
      method: settings.type || "GET",
      url: settings.url || "",
      status: jqxhr.status,
    });
  });

  $(document).ajaxError((_event, jqxhr, settings, thrownError) => {
    logFeError("ajax.error", { message: thrownError, status: jqxhr.status }, {
      method: settings.type || "GET",
      url: settings.url || "",
      status: jqxhr.status,
    });
  });

  await bootstrap();
  setupTabs();
  setupAutoTick();

  $("#settingsForm").on("submit", async (event) => {
    try {
      await saveSettings(event);
    } catch (error) {
      showStatus(`Save settings failed: ${extractError(error)}`);
    }
  });

  $("#ingestForm").on("submit", async (event) => {
    try {
      await ingestUrls(event);
    } catch (error) {
      showStatus(`Enqueue failed: ${extractError(error)}`);
    }
  });

  $("#filesForm").on("submit", async (event) => {
    try {
      await ingestFiles(event);
    } catch (error) {
      showStatus(`Upload files failed: ${extractError(error)}`);
    }
  });

  $("#filesInput").on("change", () => {
    updateSelectedFilesText();
  });

  $("#executeOneBtn").on("click", async () => {
    try {
      await executeOne();
    } catch (error) {
      showStatus(`Execute one failed: ${extractError(error)}`);
    }
  });

  $("#refreshAllBtn").on("click", async () => {
    try {
      await refreshAllState();
    } catch (error) {
      showStatus(`Refresh all failed: ${extractError(error)}`);
    }
  });

  $("#clearQueueBtn").on("click", async () => {
    try {
      await clearQueue();
    } catch (error) {
      showStatus(`Clear queue failed: ${extractError(error)}`);
    }
  });

  $("#processBody").on("click", ".refresh-row-btn", async function onClick() {
    const jobId = $(this).data("job-id");
    try {
      await refreshOne(jobId);
    } catch (error) {
      showStatus(`Refresh failed: ${extractError(error)}`);
    }
  });

  $("#queueBody").on("click", ".force-replace-btn", async function onClick() {
    const queueId = $(this).data("id");
    try {
      await forceReplace(queueId);
    } catch (error) {
      showStatus(`Force replace failed: ${extractError(error)}`);
    }
  });

  $("#queueBody").on("click", ".delete-queue-btn", async function onClick() {
    const queueId = $(this).data("id");
    try {
      await deleteQueueItem(queueId);
    } catch (error) {
      showStatus(`Delete queued item failed: ${extractError(error)}`);
    }
  });

  $("#qnaForm").on("submit", async (event) => {
    try {
      await askQna(event);
    } catch (error) {
      showStatus(`QnA failed: ${extractError(error)}`);
    }
  });

  $("#healthcheckerBtn").on("click", async () => {
    await runHealthchecker();
  });

  $("#s3ConnectivityBtn").on("click", async () => {
    await runS3ConnectivityCheck();
  });
});
