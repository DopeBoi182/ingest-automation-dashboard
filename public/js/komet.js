const KOMET_COLUMNS = [
  "DokumenID_PK",
  "DocType",
  "DokumenTypeID_FK",
  "JudulPolaA",
  "JudulPolaB",
  "JudulPolaPilih",
  "JudulPolaC",
  "JudulPolaD",
  "Judul",
  "DokumenKriteriaID_FK",
  "UraianSingkat",
  "FaktorPenyebab",
  "SolusiPenyelesaian",
  "DokumenPath",
  "DokumenUrl",
  "Kodefikasi",
  "DokumenStatusID_FK",
  "DokumenStatusComment",
  "Approval",
  "CreatedBy",
  "CreatedTime",
  "UpdateBy",
  "UpdateTime",
  "IDMigrasi",
];

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

function toCellHtml(column, value) {
  if (value === null || value === undefined || value === "") return "-";
  const safeValue = escapeHtml(value);
  if (column === "DokumenUrl" && /^https?:\/\//i.test(String(value))) {
    return `<a href="${safeValue}" target="_blank" rel="noopener noreferrer">${safeValue}</a>`;
  }
  return safeValue;
}

function renderRows(rows) {
  const dataRows = Array.isArray(rows) ? rows : [];
  if (!dataRows.length) {
    $("#kometBody").html('<tr><td colspan="24">No data found.</td></tr>');
    return;
  }

  const html = dataRows
    .map((row) => {
      const cells = KOMET_COLUMNS.map((column) => `<td>${toCellHtml(column, row?.[column])}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  $("#kometBody").html(html);
}

async function runConnectionCheck() {
  const response = await getJsonNoCache("./api/sqlsync/connection-check");
  const payload = response.data || {};
  $("#kometConnectionOutput").text(JSON.stringify(payload, null, 2));
  return payload;
}

async function fetchKometDokumen() {
  const response = await getJsonNoCache("./api/sqlsync/komet-dokumen", { top: 1000 });
  const payload = response.data || {};
  const rows = payload.rows || [];
  renderRows(rows);
  return payload;
}

$(document).ready(() => {
  $("#kometConnectionCheckBtn").on("click", async () => {
    showStatus("Checking SQL Server connection...");
    try {
      const data = await runConnectionCheck();
      showStatus(
        `Connection OK: ${data.serverName || "-"} / ${data.dbName || "-"} at ${data.nowAt || "-"}`
      );
    } catch (error) {
      showStatus(`Connection check failed: ${extractError(error)}`);
    }
  });

  $("#kometFetchBtn").on("click", async () => {
    showStatus("Loading KOMET data...");
    try {
      const data = await fetchKometDokumen();
      showStatus(`Loaded ${data.count || 0} rows from DB_KOMET_V2.dbo.TblT_Dokumen`);
    } catch (error) {
      showStatus(`Fetch data failed: ${extractError(error)}`);
    }
  });
});
