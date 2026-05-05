function showStatus(message) {
  $("#statusText").text(message);
}

let tickInFlight = false;

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
}

async function loadProcess() {
  const response = await $.getJSON("./api/jobs/process");
  const job = response.data;
  if (!job) {
    $("#processBody").html(`<tr><td colspan="7">No active processing item.</td></tr>`);
    return;
  }
  $("#processBody").html(processRowTemplate(job));
}

async function loadQueue() {
  const response = await $.getJSON("./api/jobs/queue");
  const rows = (response.data || []).map(queueRowTemplate).join("");
  $("#queueBody").html(rows || `<tr><td colspan="4">Queue is empty.</td></tr>`);
}

async function loadFinished() {
  const response = await $.getJSON("./api/jobs/finished");
  const rows = (response.data || []).map(finishedRowTemplate).join("");
  $("#finishedBody").html(rows || `<tr><td colspan="7">No completed or failed jobs yet.</td></tr>`);
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

  await $.ajax({
    url: "./api/settings",
    method: "PUT",
    contentType: "application/json",
    data: JSON.stringify(payload),
  });
  showStatus("Settings saved.");
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
  } finally {
    $("#submitIngestBtn").prop("disabled", false);
  }
}

async function executeOne() {
  $("#executeOneBtn").prop("disabled", true);
  showStatus("Executing next queue item...");
  try {
    await $.ajax({
      url: "./api/jobs/process/trigger",
      method: "POST",
    });
    await loadQueueViews();
    showStatus("Execute one done.");
  } finally {
    $("#executeOneBtn").prop("disabled", false);
  }
}

async function refreshOne(jobId) {
  showStatus(`Refreshing ${jobId} ...`);
  await $.ajax({
    url: `./api/jobs/${encodeURIComponent(jobId)}/refresh`,
    method: "POST",
  });
  await loadQueueViews();
  showStatus(`Refreshed ${jobId}.`);
}

async function refreshAllState() {
  $("#refreshAllBtn").prop("disabled", true);
  showStatus("Refreshing all states...");
  try {
    await $.ajax({
      url: "./api/jobs/refresh-all",
      method: "POST",
    });
    await loadQueueViews();
    showStatus("Refresh all state completed.");
  } finally {
    $("#refreshAllBtn").prop("disabled", false);
  }
}

async function forceReplace(queueId) {
  showStatus("Force replacing current process...");
  await $.ajax({
    url: `./api/jobs/queue/${encodeURIComponent(queueId)}/force-replace`,
    method: "POST",
  });
  await loadQueueViews();
  showStatus("Force add queue to process completed.");
}

async function deleteQueueItem(queueId) {
  showStatus("Deleting queued item...");
  await $.ajax({
    url: `./api/jobs/queue/${encodeURIComponent(queueId)}`,
    method: "DELETE",
  });
  await loadQueueViews();
  showStatus("Queued item deleted.");
}

async function clearQueue() {
  showStatus("Clearing queued items...");
  const response = await $.ajax({
    url: "./api/jobs/queue",
    method: "DELETE",
  });
  await loadQueueViews();
  const deletedCount = response.data?.deletedCount ?? 0;
  showStatus(`Cleared ${deletedCount} queued item(s).`);
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
  } finally {
    $("#submitFilesBtn").prop("disabled", false);
  }
}

async function runTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await $.ajax({
      url: "./api/jobs/process/tick",
      method: "POST",
    });
    await loadQueueViews();
    showStatus("Auto refresh done.");
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
  showStatus("Sending question...");
  const response = await $.ajax({
    url: "./api/qna",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({ question }),
  });
  $("#qnaResponse").text(JSON.stringify(response.data, null, 2));
  showStatus("QnA complete.");
}

$(document).ready(async () => {
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
});
