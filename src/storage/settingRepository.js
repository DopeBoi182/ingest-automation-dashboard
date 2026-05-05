const { readData, updateData } = require("./dataStore");

function nowIso() {
  return new Date().toISOString();
}

function normalizePayload(payload) {
  const normalized = { ...payload };
  for (const [key, value] of Object.entries(normalized)) {
    if (value instanceof Date) {
      normalized[key] = value.toISOString();
    }
  }
  return normalized;
}

async function getSetting() {
  const data = await readData();
  return data.setting || null;
}

async function setSetting(payload) {
  return updateData(async (data) => {
    const now = nowIso();
    const existingCreatedAt = data.setting?.createdAt || now;
    data.setting = {
      ...normalizePayload(payload),
      createdAt: existingCreatedAt,
      updatedAt: now,
    };
    return { data, result: data.setting };
  });
}

async function updateSetting(patch) {
  return updateData(async (data) => {
    if (!data.setting) return { data, result: null };
    data.setting = {
      ...data.setting,
      ...normalizePayload(patch),
      updatedAt: nowIso(),
    };
    return { data, result: data.setting };
  });
}

module.exports = {
  getSetting,
  setSetting,
  updateSetting,
};
