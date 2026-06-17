const express = require("express");
const { classifyTags } = require("../services/ingestorClient");

const router = express.Router();

router.post("/classify", async (req, res, next) => {
  try {
    const body = req.body || {};
    const abstract = String(body.abstract || "").trim();
    const maxLabels = Number(body.max_labels);
    if (!abstract) return res.status(400).json({ message: "abstract is required." });
    if (!Number.isFinite(maxLabels) || maxLabels <= 0) {
      return res.status(400).json({ message: "max_labels must be a positive number." });
    }

    const payload = {
      abstract,
      max_labels: Math.floor(maxLabels),
    };

    const data = await classifyTags(payload);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
