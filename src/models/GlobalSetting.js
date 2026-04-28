const mongoose = require("mongoose");

const GlobalSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    knowledge_source: { type: String, required: true },
    knowledge_tags: { type: [String], default: [] },
    provider: { type: String, default: "bedrock" },
    prompt: { type: String, required: true },
    chunk_size: { type: Number, default: 1000 },
    chunk_overlap: { type: Number, default: 200 },
    embed: { type: Boolean, default: true },
    vdb_collection: { type: String, default: "docs" },
    callback_url: { type: String, default: "" },
    vector_group: { type: String, default: "staging" },
    force: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GlobalSetting", GlobalSettingSchema);
