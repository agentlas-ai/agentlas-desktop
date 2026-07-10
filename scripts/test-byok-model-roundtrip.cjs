#!/usr/bin/env node
// BYOK live /models selection contract:
// - A provider model missing from the built-in catalog can be selected.
// - runtime:setActive persists that exact id and detect restores it unchanged.
// - The restored id remains one of the live picker options.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-byok-model-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_RUNTIME_DETECT_CACHE_MS = "0";
app.setPath("userData", path.join(tmp, "user-data"));

// Keep the regression deterministic: only the in-memory OpenAI BYOK runtime is
// available. Patch probe exports before detect.ts captures the module objects.
const claudeCode = require("../dist/electron/runtime/claude-code.js");
const codex = require("../dist/electron/runtime/codex.js");
const gemini = require("../dist/electron/runtime/gemini.js");
const grok = require("../dist/electron/runtime/grok.js");
const ollama = require("../dist/electron/runtime/ollama.js");
claudeCode.probeClaudeCode = async () => null;
claudeCode.probeClaudeEfforts = async () => [];
codex.probeCodex = async () => null;
gemini.probeGemini = async () => null;
grok.probeGrok = async () => null;
ollama.probeOllama = async () => null;

const liveModel = "gpt-5.99-live_preview-2026-07-10";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  assert.equal(url, "https://api.openai.com/v1/models", `unexpected network request: ${url}`);
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: liveModel }, { id: "gpt-4o-mini" }] }),
  };
};

async function main() {
  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const vault = require("../dist/electron/secrets/vault.js");
  const models = require("../dist/shared/models.js");
  const providers = require("../dist/electron/runtime/providers.js");
  const runtime = require("../dist/electron/runtime/detect.js");
  db.initStore();

  assert.equal(
    models.findByokModel("openai", liveModel),
    undefined,
    "fixture must stay outside the built-in catalog",
  );
  await vault.saveApiKey("openai", "test-openai-key");

  const pickerOptions = await providers.listRuntimeModels(
    "byok",
    "openai",
    null,
    Date.now(),
  );
  assert.ok(
    pickerOptions.some((option) => option.id === liveModel),
    "live /models result must reach the picker",
  );

  const afterSelection = await runtime.setActiveRuntime({
    kind: "byok",
    backend: "openai",
    source: "byok:openai",
    model: liveModel,
  });
  const stored = db.getDb()
    .prepare("SELECT kind, backend, source, model FROM active_runtime WHERE id = 1")
    .get();
  assert.equal(stored.model, liveModel, "runtime:setActive must persist the exact live model id");

  const selected = afterSelection.find((candidate) => candidate.active);
  assert.equal(selected?.backend, "openai", "selected BYOK backend must remain active");
  assert.equal(
    selected?.model,
    liveModel,
    "detect must not replace a persisted live model with the catalog default",
  );
  assert.ok(
    pickerOptions.some((option) => option.id === selected.model),
    "restored runtime model and picker options must agree",
  );

  runtime.clearDetectCache();
  const afterRestore = (await runtime.detectRuntimes()).find((candidate) => candidate.active);
  assert.equal(afterRestore?.model, liveModel, "a fresh detect pass must restore the live model id");

  console.log("BYOK live model persistence/restore/picker contract ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const vault = require("../dist/electron/secrets/vault.js");
      await vault.deleteApiKey("openai");
    } catch {
      // best-effort test cleanup
    }
    globalThis.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  });
