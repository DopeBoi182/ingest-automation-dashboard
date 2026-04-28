const express = require("express");
const { askQna } = require("../services/ingestorClient");
const { getOrCreateGlobalSetting } = require("../utils/settings");

const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const question = String(body.question || "").trim();
    if (!question) return res.status(400).json({ message: "question is required." });

    const setting = await getOrCreateGlobalSetting();

    const payload = {
      vdb_collection: body.vdb_collection || setting.vdb_collection,
      vector_group: body.vector_group || setting.vector_group,
      top_k: Number(body.top_k) || 5,
      search_type: body.search_type || "hybrid_graph",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: question }],
        },
      ],
    };

    const data = await askQna(payload);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
