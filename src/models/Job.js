const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema(
  {
    file_url: { type: String, required: true, trim: true },
    job_id: { type: String, required: true, unique: true, index: true },
    status: { type: String, default: "created" },
    stage: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    resource_key: { type: String, default: "" },
    error: { type: String, default: null },
    raw_response: { type: mongoose.Schema.Types.Mixed, default: {} },
    created_at_remote: { type: Date, default: null },
    updated_at_remote: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Job", JobSchema);
