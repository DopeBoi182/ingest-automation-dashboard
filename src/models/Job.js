const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema(
  {
    file_url: { type: String, required: true, trim: true },
    job_id: { type: String, default: null, index: true, sparse: true },
    status: { type: String, default: "created" },
    stage: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    resource_key: { type: String, default: "" },
    error: { type: String, default: null },
    raw_response: { type: mongoose.Schema.Types.Mixed, default: {} },
    created_at_remote: { type: Date, default: null },
    updated_at_remote: { type: Date, default: null },
    queue_status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "canceled"],
      default: "queued",
      index: true,
    },
    queue_order: { type: Number, default: null, index: true },
    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null },
  },
  { timestamps: true }
);

JobSchema.index({ job_id: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Job", JobSchema);
