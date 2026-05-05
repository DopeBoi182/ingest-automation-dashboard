const path = require("path");
const express = require("express");
const env = require("./config/env");
const jobsRouter = require("./routes/jobs");
const settingsRouter = require("./routes/settings");
const qnaRouter = require("./routes/qna");
const s3Router = require("./routes/s3");
const healthcheckerRouter = require("./routes/healthchecker");

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));
if (env.appBasePath) {
  app.use(env.appBasePath, express.static(publicDir));
}

const apiRouter = express.Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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
