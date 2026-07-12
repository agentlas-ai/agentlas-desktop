"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const multimodal = require(path.join(root, "dist/shared/multimodal.js"));
const envDetect = require(path.join(root, "dist/electron/agents/env-detect.js"));

function main() {
  const settings = multimodal.normalizeMultimodalSettings({
    imageProvider: "openai-image",
    videoProvider: "runway-video",
    audioProvider: "elevenlabs-audio",
  });
  assert.equal(settings.imageProvider, "openai-image");
  assert.equal(settings.videoProvider, "runway-video");
  assert.equal(settings.audioProvider, "elevenlabs-audio");
  assert.deepEqual(multimodal.selectedMultimodalEnvKeys(settings), [
    "ELEVENLABS_API_KEY",
    "OPENAI_API_KEY",
    "RUNWAY_API_KEY",
  ]);

  const grokSettings = multimodal.normalizeMultimodalSettings({
    imageProvider: "grok-cli-image",
    videoProvider: "grok-cli-video",
    audioProvider: "openai-audio",
  });
  assert.equal(grokSettings.imageProvider, "grok-cli-image");
  assert.equal(grokSettings.videoProvider, "grok-cli-video");
  assert.equal(multimodal.getMultimodalProvider("grok-cli-image")?.modality, "image");
  assert.equal(multimodal.getMultimodalProvider("grok-cli-video")?.modality, "video");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-multimodal-smoke-"));
  try {
    fs.writeFileSync(
      path.join(dir, "AGENTS.md"),
      [
        "# Creative Agent",
        "Use process.env.OPENAI_API_KEY for image generation.",
        "Use HIGGSFIELD_API_KEY when cinematic video is requested.",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, ".env.example"), "RUNWAY_API_KEY=\n", "utf8");
    fs.writeFileSync(path.join(dir, ".env"), "ELEVENLABS_API_KEY=do-not-leak-this-secret\n", "utf8");

    const reqs = envDetect.detectEnvRequirementsFromFolder(dir);
    const keys = reqs.map((req) => req.key);
    assert.ok(keys.includes("OPENAI_API_KEY"));
    assert.ok(keys.includes("RUNWAY_API_KEY"));
    assert.ok(keys.includes("ELEVENLABS_API_KEY"));
    assert.ok(keys.includes("HIGGSFIELD_API_KEY"));
    assert.doesNotMatch(JSON.stringify(reqs), /do-not-leak-this-secret/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("multimodal-settings smoke passed");
}

main();
