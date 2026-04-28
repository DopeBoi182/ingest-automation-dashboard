const path = require("path");
const express = require("express");
const jobsRouter = require("./routes/jobs");
const settingsRouter = require("./routes/settings");
const qnaRouter = require("./routes/qna");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/callback", (req, res) => {
  // Callback is accepted for compatibility with external extractor.
  res.json({ received: true, payload: req.body });
});

app.use("/api/jobs", jobsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/qna", qnaRouter);

app.use((err, _req, res, _next) => {
  const status = err.response?.status || err.status || 500;
  const detail = err.response?.data || err.message || "Unexpected server error";
  res.status(status).json({ message: "Request failed", detail });
});

module.exports = app;
