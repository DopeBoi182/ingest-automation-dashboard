const env = require("../config/env");
const { getSetting, setSetting } = require("../storage/settingRepository");

function parseTags(tagsInput) {
  if (Array.isArray(tagsInput)) {
    return tagsInput.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(tagsInput || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function defaultSettingPayload() {
  return {
    key: "default",
    knowledge_source: env.defaultKnowledgeSource,
    knowledge_tags: parseTags(env.defaultKnowledgeTags),
    provider: env.defaultProvider,
    prompt: env.defaultPrompt,
    chunk_size: env.defaultChunkSize,
    chunk_overlap: env.defaultChunkOverlap,
    embed: env.defaultEmbed,
    vdb_collection: env.defaultVdbCollection,
    callback_url: env.defaultCallbackUrl,
    vector_group: env.defaultVectorGroup,
    force: env.defaultForce,
  };
}

async function getOrCreateGlobalSetting() {
  const existing = await getSetting();
  if (existing) return existing;
  return setSetting(defaultSettingPayload());
}

module.exports = {
  parseTags,
  defaultSettingPayload,
  getOrCreateGlobalSetting,
};
