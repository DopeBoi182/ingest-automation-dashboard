function showStatus(message) {
  $("#statusText").text(message);
}

function toLocalDateString(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function rowTemplate(job) {
  return `
    <tr data-job-id="${job.job_id}">
      <td>${job.file_url || "-"}</td>
      <td>${job.job_id || "-"}</td>
      <td>${job.status || "-"}</td>
      <td>${job.stage || "-"}</td>
      <td>${job.progress ?? 0}</td>
      <td>${toLocalDateString(job.updated_at_remote || job.updatedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="secondary refresh-row-btn" data-job-id="${job.job_id}">Refresh</button>
          <button class="danger cancel-row-btn" data-job-id="${job.job_id}">Cancel</button>
        </div>
      </td>
    </tr>
  `;
}

async function loadSettings() {
  const response = await $.getJSON("/api/settings");
  const s = response.data || {};
  $("#knowledgeSource").val(s.knowledge_source || "");
  $("#knowledgeTags").val((s.knowledge_tags || []).join(","));
  $("#provider").val(s.provider || "");
  $("#vdbCollection").val(s.vdb_collection || "");
  $("#vectorGroup").val(s.vector_group || "");
  $("#callbackUrl").val(s.callback_url || "");
  $("#chunkSize").val(s.chunk_size || 1000);
  $("#chunkOverlap").val(s.chunk_overlap || 200);
  $("#promptText").val(s.prompt || "");
}

async function loadJobs() {
  const response = await $.getJSON("/api/jobs");
  const rows = (response.data || []).map(rowTemplate).join("");
  $("#jobsBody").html(rows || `<tr><td colspan="7">No data yet.</td></tr>`);
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
    prompt: $("#promptText").val(),
  };

  await $.ajax({
    url: "/api/settings",
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
  showStatus("Submitting ingestion jobs...");

  try {
    await $.ajax({
      url: "/api/jobs/ingest",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ urls }),
    });
    $("#urlInput").val("");
    await loadJobs();
    showStatus("Ingestion complete.");
  } finally {
    $("#submitIngestBtn").prop("disabled", false);
  }
}

async function refreshOne(jobId) {
  showStatus(`Refreshing ${jobId} ...`);
  await $.ajax({
    url: `/api/jobs/${encodeURIComponent(jobId)}/refresh`,
    method: "POST",
  });
  await loadJobs();
  showStatus(`Refreshed ${jobId}.`);
}

async function refreshAll() {
  $("#refreshAllBtn").prop("disabled", true);
  showStatus("Refreshing all job statuses...");
  try {
    await $.ajax({
      url: "/api/jobs/refresh-all",
      method: "POST",
    });
    await loadJobs();
    showStatus("All jobs refreshed.");
  } finally {
    $("#refreshAllBtn").prop("disabled", false);
  }
}

async function cancelOne(jobId) {
  showStatus(`Cancelling ${jobId} ...`);
  await $.ajax({
    url: `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    method: "POST",
  });
  await loadJobs();
  showStatus(`Cancelled ${jobId}.`);
}

async function cancelAll() {
  $("#cancelAllBtn").prop("disabled", true);
  showStatus("Cancelling all jobs...");
  try {
    await $.ajax({
      url: "/api/jobs/cancel-all",
      method: "POST",
    });
    await loadJobs();
    showStatus("All jobs cancel request sent.");
  } finally {
    $("#cancelAllBtn").prop("disabled", false);
  }
}

async function askQna(event) {
  event.preventDefault();
  const question = $("#questionInput").val().trim();
  if (!question) return;
  showStatus("Sending question...");
  const response = await $.ajax({
    url: "/api/qna",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({ question }),
  });
  $("#qnaResponse").text(JSON.stringify(response.data, null, 2));
  showStatus("QnA complete.");
}

$(document).ready(async () => {
  try {
    await loadSettings();
    await loadJobs();
  } catch (error) {
    showStatus(
      `Failed to load initial data: ${error.responseJSON?.detail || error.message}`
    );
  }

  $("#settingsForm").on("submit", async (event) => {
    try {
      await saveSettings(event);
    } catch (error) {
      showStatus(`Save settings failed: ${error.responseJSON?.detail || error.message}`);
    }
  });

  $("#ingestForm").on("submit", async (event) => {
    try {
      await ingestUrls(event);
    } catch (error) {
      showStatus(`Ingestion failed: ${error.responseJSON?.detail || error.message}`);
    }
  });

  $("#refreshAllBtn").on("click", async () => {
    try {
      await refreshAll();
    } catch (error) {
      showStatus(`Refresh all failed: ${error.responseJSON?.detail || error.message}`);
    }
  });

  $("#cancelAllBtn").on("click", async () => {
    try {
      await cancelAll();
    } catch (error) {
      showStatus(`Cancel all failed: ${error.responseJSON?.detail || error.message}`);
    }
  });

  $("#jobsBody").on("click", ".refresh-row-btn", async function onClick() {
    const jobId = $(this).data("job-id");
    try {
      await refreshOne(jobId);
    } catch (error) {
      showStatus(`Refresh failed: ${error.responseJSON?.detail || error.message}`);
    }
  });

  $("#jobsBody").on("click", ".cancel-row-btn", async function onClick() {
    const jobId = $(this).data("job-id");
    try {
      await cancelOne(jobId);
    } catch (error) {
      showStatus(`Cancel failed: ${error.responseJSON?.detail || error.message}`);
    }
  });

  $("#qnaForm").on("submit", async (event) => {
    try {
      await askQna(event);
    } catch (error) {
      showStatus(`QnA failed: ${error.responseJSON?.detail || error.message}`);
    }
  });
});
