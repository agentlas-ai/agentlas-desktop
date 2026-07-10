#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-runtime-memory-"));
  app.setPath("userData", tmp);
  process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
  const store = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/runtime/selection-memory.js");
  const runtime = require("../dist/electron/runtime/detect.js");
  try {
    store.initStore();
    await runtime.setActiveRuntime({
      kind: "byok",
      backend: "openai",
      source: "byok:openai",
      model: "gpt-5.99-live",
      longContext: true,
    });
    await runtime.setActiveRuntime({
      kind: "byok",
      backend: "anthropic",
      source: "byok:anthropic",
      model: "claude-next-live",
      longContext: false,
    });
    assert.deepEqual(memory.recallRuntimeSelection("byok", "openai"), {
      model: "gpt-5.99-live",
      longContext: true,
    });
    assert.deepEqual(memory.recallRuntimeSelection("byok", "anthropic"), {
      model: "claude-next-live",
      longContext: false,
    });

    // A→B→A restores A's independent choice instead of inheriting B/default.
    const openAiAgain = memory.recallRuntimeSelection("byok", "openai");
    await runtime.setActiveRuntime({
      kind: "byok",
      backend: "openai",
      source: "byok:openai-new-path",
      model: openAiAgain.model,
      longContext: openAiAgain.longContext,
    });
    const active = store.getDb()
      .prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id = 1")
      .get();
    assert.deepEqual(active, {
      kind: "byok",
      backend: "openai",
      source: "byok:openai-new-path",
      model: "gpt-5.99-live",
      long_context: 1,
    });

    // Runtime executable/source changes are intentionally absent from the key.
    assert.equal(
      memory.runtimeSelectionMemoryKey("codex", "openai"),
      "runtime_selection:codex:openai",
    );
    store.getDb()
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(memory.runtimeSelectionMemoryKey("codex", "openai"), "corrupt-json");
    assert.equal(memory.recallRuntimeSelection("codex", "openai"), null);
    console.log("runtime backend selection memory contract ok");
  } finally {
    store.getDb().close();
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
