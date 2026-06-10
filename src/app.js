const path = require("path");
const os = require("os");
const express = require("express");
const env = require("./config/env");
const { getDataFilePath } = require("./storage/dataStore");
const jobsRouter = require("./routes/jobs");
const settingsRouter = require("./routes/settings");
const qnaRouter = require("./routes/qna");
const s3Router = require("./routes/s3");
const healthcheckerRouter = require("./routes/healthchecker");
const sqlsyncRouter = require("./routes/sqlsync");
const kometDownloadRouter = require("./routes/komet-download");

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.set("etag", false);
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));
if (env.appBasePath) {
  app.use(env.appBasePath, express.static(publicDir));
}

const apiRouter = express.Router();
apiRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

apiRouter.get("/api/health/storage", (_req, res) => {
  res.json({
    status: "ok",
    data: {
      dataFilePath: getDataFilePath(),
      pid: process.pid,
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
    },
  });
});

apiRouter.post("/callback", (req, res) => {
  // Callback is accepted for compatibility with external extractor.
  res.json({ received: true, payload: req.body });
});

apiRouter.use("/api/jobs", jobsRouter);
apiRouter.use("/api/settings", settingsRouter);
apiRouter.use("/api/qna", qnaRouter);
apiRouter.use("/api/s3", s3Router);
apiRouter.use("/api/healthchecker", healthcheckerRouter);
apiRouter.use("/api/sqlsync", sqlsyncRouter);
apiRouter.use("/api/komet-download", kometDownloadRouter);
app.use(apiRouter);
if (env.appBasePath) {
  app.use(env.appBasePath, apiRouter);
}

app.use((err, _req, res, _next) => {
  const status = err.response?.status || err.status || 500;
  const detail = err.response?.data || err.message || "Unexpected server error";
  res.status(status).json({ message: "Request failed", detail });
});

module.exports = app;
