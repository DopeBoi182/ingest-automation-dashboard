const express = require("express");
const { getOrCreateGlobalSetting, parseTags } = require("../utils/settings");

const router = express.Router();

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

router.get("/", async (_req, res, next) => {
  try {
    const setting = await getOrCreateGlobalSetting();
    res.json({ data: setting });
  } catch (error) {
    next(error);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const current = await getOrCreateGlobalSetting();
    const body = req.body || {};

    if (body.knowledge_source !== undefined) {
      current.knowledge_source = String(body.knowledge_source).trim();
    }
    if (body.knowledge_tags !== undefined) {
      current.knowledge_tags = parseTags(body.knowledge_tags);
    }
    if (body.provider !== undefined) current.provider = String(body.provider).trim();
    if (body.prompt !== undefined) current.prompt = String(body.prompt);
    if (body.chunk_size !== undefined) current.chunk_size = Number(body.chunk_size) || 0;
    if (body.chunk_overlap !== undefined) {
      current.chunk_overlap = Number(body.chunk_overlap) || 0;
    }
    if (body.embed !== undefined) current.embed = toBoolean(body.embed, current.embed);
    if (body.vdb_collection !== undefined) {
      current.vdb_collection = String(body.vdb_collection).trim();
    }
    if (body.callback_url !== undefined) {
      current.callback_url = String(body.callback_url).trim();
    }
    if (body.vector_group !== undefined) {
      current.vector_group = String(body.vector_group).trim();
    }
    if (body.force !== undefined) current.force = toBoolean(body.force, current.force);

    await current.save();
    res.json({ data: current });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
