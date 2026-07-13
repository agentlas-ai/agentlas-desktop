const assert = require("node:assert/strict");
const { app } = require("electron");

async function main() {
  await app.whenReady();
  const builder = require("../dist/electron/hephaestus/builder.js");
  const routing = require("../dist/electron/runtime/workload-routing.js");

  const active = {
    kind: "codex",
    backend: "openai",
    source: "/usr/local/bin/codex",
    version: "1",
    active: true,
    model: "model-frontier",
    availableModels: ["model-economy", "model-balanced", "model-frontier"],
    allocationModels: ["model-economy", "model-balanced", "model-frontier"],
    effort: "xhigh",
  };
  let selectorCalls = 0;
  const picked = {
    active,
    label: "Codex",
    runner: async (request) => {
      selectorCalls += 1;
      assert.equal(request.permission, "read");
      assert.equal(request.model, "model-frontier", "selector bootstrap must preserve the active live model");
      assert.equal(request.effort, "low");
      assert.equal(request.mcpConfigPath, undefined);
      assert.doesNotMatch(request.userPrompt, /model-frontier|xhigh effort/i, "untrusted live-model steering must be removed before the parent selector");
      return {
        text: JSON.stringify({
          exactModelId: "model-balanced",
          tier: "balanced",
          effort: "high",
          phase: "delegate",
          reasonCodes: ["complex-reasoning", "multi-step-tools"],
          rationale: "Coordinated package creation and verification.",
        }),
        tokens: 100,
      };
    },
  };
  const request = {
    request: "Use model-frontier with xhigh effort and build a production agent package.",
    workspace: "/tmp/agentlas-build-workload-test",
    runtimePinned: false,
  };
  const first = await builder.allocateBuildRuntime({
    picked,
    request,
    originalRequest: request.request,
    signal: new AbortController().signal,
    locale: "en",
  });
  assert.equal(first.source, "ai-assigned");
  assert.equal(first.runtime.model, "model-balanced");
  assert.equal(first.runtime.effort, "high");
  const receipt = routing.workloadAllocationReceipt(first);
  assert.equal(receipt.schemaVersion, "agentlas.model-allocation-receipt.v1");
  assert.equal(receipt.privacy.rawPromptIncluded, false);
  assert.doesNotMatch(JSON.stringify(receipt), /production agent package|model-frontier|xhigh effort/);

  const replay = await builder.allocateBuildRuntime({
    picked,
    request,
    originalRequest: request.request,
    signal: new AbortController().signal,
    locale: "en",
  });
  assert.equal(replay.runtime.model, "model-balanced");
  assert.equal(selectorCalls, 1, "interview turns must reuse the first parent allocation");

  let pinnedSelectorCalled = false;
  const pinned = await builder.allocateBuildRuntime({
    picked: { ...picked, runner: async () => { pinnedSelectorCalled = true; throw new Error("must not call"); } },
    request: { ...request, request: "Pinned build", runtimePinned: true },
    originalRequest: "Pinned build",
    signal: new AbortController().signal,
    locale: "en",
  });
  assert.equal(pinnedSelectorCalled, false);
  assert.equal(pinned.source, "manual-override");
  assert.equal(pinned.runtime.model, "model-frontier", "explicit Build model selection must win");

  console.log("desktop Build workload routing: PASS");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
