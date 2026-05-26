function showStatus(message) {
  $("#statusText").text(message);
}

function extractError(error) {
  const detail = error.responseJSON?.detail || error.responseJSON?.message;
  if (typeof detail === "string") return detail;
  if (detail) return JSON.stringify(detail);
  return error.message || "Unknown error";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getJsonNoCache(url, data) {
  return $.ajax({
    url,
    method: "GET",
    data,
    cache: false,
    dataType: "json",
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

async function postJsonNoCache(url, payload) {
  return $.ajax({
    url,
    method: "POST",
    data: JSON.stringify(payload || {}),
    cache: false,
    dataType: "json",
    contentType: "application/json",
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

function setRawOutput(payload) {
  $("#kometRawOutput").text(JSON.stringify(payload, null, 2));
}

function setRawOutputError(error) {
  const payload = {
    message: error?.responseJSON?.message || "Request failed",
    detail: extractError(error),
    debug: error?.responseJSON?.debug || null,
  };
  setRawOutput(payload);
}

function renderTableOptions(tables) {
  const options = ['<option value="">-- select table --</option>'];
  (Array.isArray(tables) ? tables : []).forEach((item) => {
    const fullName = item?.fullName || `${item?.schema || "dbo"}.${item?.table || ""}`;
    if (!fullName || fullName.endsWith(".")) return;
    const safeName = escapeHtml(fullName);
    options.push(`<option value="${safeName}">${safeName}</option>`);
  });
  $("#kometTableSelect").html(options.join(""));
}

async function runConnectionCheck() {
  const response = await getJsonNoCache("./api/sqlsync/connection-check");
  const payload = response.data || {};
  $("#kometConnectionOutput").text(JSON.stringify(payload, null, 2));
  return payload;
}

async function listKometTables() {
  const response = await getJsonNoCache("./api/sqlsync/komet-tables");
  const payload = response.data || {};
  renderTableOptions(payload.tables || []);
  return payload;
}

async function fetchKometTablePreview(tableName) {
  const response = await getJsonNoCache("./api/sqlsync/komet-table-preview", {
    table: tableName,
    top: 1000,
  });
  const payload = response.data || {};
  setRawOutput(payload);
  return payload;
}

async function getConnectionConfig() {
  const response = await getJsonNoCache("./api/sqlsync/connection-config");
  return response.data || {};
}

async function updateConnectionConfig(trustServerCertificate) {
  const response = await postJsonNoCache("./api/sqlsync/connection-config", {
    trustServerCertificate,
  });
  return response.data || {};
}

async function reconnectSqlConnection() {
  const response = await postJsonNoCache("./api/sqlsync/reconnect", {});
  return response.data || {};
}

function syncToggleFromConfig(config) {
  const enabled = Boolean(config?.trustServerCertificate);
  $("#kometTrustCertToggle").prop("checked", enabled);
}

async function applyTlsAndReconnect() {
  const trustServerCertificate = $("#kometTrustCertToggle").is(":checked");
  const updatedConfig = await updateConnectionConfig(trustServerCertificate);
  const reconnectResult = await reconnectSqlConnection();
  setRawOutput({
    action: "apply_tls_and_reconnect",
    config: updatedConfig,
    reconnect: reconnectResult,
  });
  return reconnectResult;
}

$(document).ready(() => {
  (async () => {
    showStatus("Loading SQL connection config...");
    try {
      const config = await getConnectionConfig();
      syncToggleFromConfig(config);
      showStatus(
        `Config loaded: trustServerCertificate=${config.trustServerCertificate ? "true" : "false"} (${config.trustServerCertificateSource || "env"})`
      );
    } catch (error) {
      setRawOutputError(error);
      showStatus(`Load SQL config failed: ${extractError(error)}`);
    }
  })();

  $("#kometApplyTlsBtn").on("click", async () => {
    const toggleText = $("#kometTrustCertToggle").is(":checked") ? "true" : "false";
    showStatus(`Applying trustServerCertificate=${toggleText} and reconnecting...`);
    try {
      const result = await applyTlsAndReconnect();
      const cfg = result?.config || {};
      syncToggleFromConfig(cfg);
      showStatus(
        `Reconnected: ${result.serverName || "-"} / ${result.dbName || "-"} (trustServerCertificate=${cfg.trustServerCertificate ? "true" : "false"})`
      );
    } catch (error) {
      setRawOutputError(error);
      showStatus(`Reconnect failed: ${extractError(error)}`);
    }
  });

  $("#kometConnectionCheckBtn").on("click", async () => {
    showStatus("Checking SQL Server connection...");
    try {
      const data = await runConnectionCheck();
      showStatus(
        `Connection OK: ${data.serverName || "-"} / ${data.dbName || "-"} at ${data.nowAt || "-"}`
      );
    } catch (error) {
      $("#kometConnectionOutput").text(
        JSON.stringify(
          {
            message: error?.responseJSON?.message || "Request failed",
            detail: extractError(error),
            debug: error?.responseJSON?.debug || null,
          },
          null,
          2
        )
      );
      showStatus(`Connection check failed: ${extractError(error)}`);
    }
  });

  $("#kometListTablesBtn").on("click", async () => {
    showStatus("Loading table list...");
    try {
      const data = await listKometTables();
      setRawOutput(data);
      showStatus(`Loaded ${data.count || 0} table(s) from ${data.currentDb || "-"}`);
    } catch (error) {
      setRawOutputError(error);
      showStatus(`List tables failed: ${extractError(error)}`);
    }
  });

  $("#kometFetchBtn").on("click", async () => {
    const tableName = $("#kometTableSelect").val();
    if (!tableName) {
      showStatus("Please list and select a table first.");
      return;
    }

    showStatus(`Loading TOP 1000 rows from ${tableName}...`);
    try {
      const data = await fetchKometTablePreview(tableName);
      showStatus(`Loaded ${data.count || 0} row(s) from ${data.fullName || tableName}`);
    } catch (error) {
      setRawOutputError(error);
      showStatus(`Fetch data failed: ${extractError(error)}`);
    }
  });
});
