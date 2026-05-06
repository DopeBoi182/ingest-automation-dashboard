function showStatus(message) {
  $("#statusText").text(message);
}

function extractError(error) {
  const detail = error.responseJSON?.detail || error.responseJSON?.message;
  if (typeof detail === "string") return detail;
  if (detail) return JSON.stringify(detail);
  return error.message || "Unknown error";
}

const state = {
  files: [],
  nextContinuationToken: null,
  hasMore: false,
};

function getFilters() {
  return {
    prefix: $("#prefixInput").val().trim(),
    maxKeys: Number($("#maxKeysInput").val()) || 100,
    mode: $("#modeInput").val(),
    dataMode: $("#dataModeInput").val(),
    ttlSeconds: Number($("#ttlInput").val()) || 900,
  };
}

function rowTemplate(file, index) {
  const metaText =
    file.size !== undefined
      ? `size=${file.size}, lastModified=${file.lastModified || "-"}, etag=${file.etag || "-"}, storageClass=${
          file.storageClass || "-"
        }`
      : "";
  const urlCell = file.url
    ? `<a href="${file.url}" target="_blank" rel="noopener noreferrer">${file.url}</a>`
    : "-";
  const dataCell = metaText ? `${urlCell}<br /><small>${metaText}</small>` : urlCell;
  return `
    <tr>
      <td>
        <input type="checkbox" class="file-checkbox" data-index="${index}" />
      </td>
      <td>${file.key}</td>
      <td class="url-cell">${dataCell}</td>
    </tr>
  `;
}

function renderFiles() {
  const rows = state.files.map((file, index) => rowTemplate(file, index)).join("");
  $("#filesBody").html(rows || `<tr><td colspan="3">No files found.</td></tr>`);
  $("#loadMoreBtn").prop("disabled", !state.hasMore);
}

async function fetchFiles({ append }) {
  const filters = getFilters();
  const query = {
    prefix: filters.prefix,
    maxKeys: filters.maxKeys,
    dataMode: filters.dataMode,
    mode: filters.mode,
    ttlSeconds: filters.ttlSeconds,
  };
  if (append && state.nextContinuationToken) {
    query.continuationToken = state.nextContinuationToken;
  }

  const response = await $.getJSON("./api/s3/files", query);
  const payload = response.data || {};

  if (!append) {
    state.files = payload.files || [];
  } else {
    state.files = state.files.concat(payload.files || []);
  }

  state.nextContinuationToken = payload.nextContinuationToken || null;
  state.hasMore = Boolean(payload.isTruncated && payload.nextContinuationToken);
  renderFiles();
  showStatus(`Loaded ${state.files.length} file(s) with clickable ${filters.mode} URLs.`);
}

function selectedKeys() {
  return $(".file-checkbox:checked")
    .map(function mapChecked() {
      const index = Number($(this).data("index"));
      return state.files[index]?.key;
    })
    .get()
    .filter(Boolean);
}

async function ingestKeys(keys) {
  if (!keys.length) {
    showStatus("No keys selected.");
    return;
  }

  const filters = getFilters();
  const response = await $.ajax({
    url: "./api/s3/ingest",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({
      keys,
      mode: filters.mode,
      ttlSeconds: filters.ttlSeconds,
    }),
  });

  const count = response.data?.count ?? keys.length;
  showStatus(`Queued ${count} file(s) to ingestion.`);
}

async function checkHealth() {
  const response = await $.getJSON("./api/s3/health/live");
  const data = response.data || {};
  showStatus(
    `S3 OK. Bucket: ${data.bucket || "-"}, Endpoint: ${data.endpoint || "-"}, TLS: ${
      data.tlsMode || "-"
    }, latency: ${data.latencyMs ?? "-"}ms`
  );
}

$(document).ready(() => {
  $("#s3QueryForm").on("submit", async (event) => {
    event.preventDefault();
    $("#generateBtn").prop("disabled", true);
    showStatus("Loading S3 data...");
    try {
      await fetchFiles({ append: false });
    } catch (error) {
      showStatus(`Load S3 data failed: ${extractError(error)}`);
    } finally {
      $("#generateBtn").prop("disabled", false);
    }
  });

  $("#loadMoreBtn").on("click", async () => {
    $("#loadMoreBtn").prop("disabled", true);
    showStatus("Loading more...");
    try {
      await fetchFiles({ append: true });
    } catch (error) {
      showStatus(`Load more failed: ${extractError(error)}`);
    } finally {
      $("#loadMoreBtn").prop("disabled", !state.hasMore);
    }
  });

  $("#checkHealthBtn").on("click", async () => {
    showStatus("Checking S3 health...");
    try {
      await checkHealth();
    } catch (error) {
      showStatus(`S3 health failed: ${extractError(error)}`);
    }
  });

  $("#selectAllBtn").on("click", () => {
    $(".file-checkbox").prop("checked", true);
    showStatus("All rows selected.");
  });

  $("#clearSelectionBtn").on("click", () => {
    $(".file-checkbox").prop("checked", false);
    showStatus("Selection cleared.");
  });

  $("#ingestSelectedBtn").on("click", async () => {
    const keys = selectedKeys();
    showStatus(`Queueing ${keys.length} selected file(s)...`);
    try {
      await ingestKeys(keys);
    } catch (error) {
      showStatus(`Ingest selected failed: ${extractError(error)}`);
    }
  });

  $("#ingestAllBtn").on("click", async () => {
    const keys = state.files.map((file) => file.key);
    showStatus(`Queueing ${keys.length} file(s)...`);
    try {
      await ingestKeys(keys);
    } catch (error) {
      showStatus(`Ingest all failed: ${extractError(error)}`);
    }
  });
});
