#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const {
    readCodexModelIds,
    readCodexModelInventory,
    resolveCodexModelEffort,
  } = require("../dist/electron/runtime/codex-models.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-codex-models-"));
  const cachePath = path.join(home, "models_cache.json");
  try {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-terra",
            visibility: "list",
            context_window: 272_000,
            max_context_window: 1_000_000,
            effective_context_window_percent: 95,
            input_modalities: ["text", "image"],
            apply_patch_tool_type: "freeform",
            shell_type: "shell_command",
            supports_parallel_tool_calls: true,
            supports_search_tool: true,
            supported_reasoning_levels: [
              { effort: "max", description: "must not escape" },
              { effort: "low" },
              { effort: "ultra" },
              { effort: "medium" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
            priority: 999,
            base_instructions: "private cache text must not escape",
          },
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            context_window: 272_000,
            effective_context_window_percent: 101,
            input_modalities: ["text"],
            apply_patch_tool_type: null,
            shell_type: null,
            supports_parallel_tool_calls: false,
            supports_search_tool: false,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }, { nope: true }],
          },
          { slug: "gpt-5.6-terra", visibility: "list" },
          {
            slug: "gpt-malformed-profile",
            visibility: "list",
            context_window: "272000",
            effective_context_window_percent: 95,
            input_modalities: [7],
            apply_patch_tool_type: { unexpected: true },
            supported_reasoning_levels: "high",
          },
          {
            slug: "gpt-disabled-tools",
            visibility: "list",
            apply_patch_tool_type: "disabled",
            shell_type: "none",
            supports_parallel_tool_calls: false,
            supports_search_tool: false,
          },
          { slug: "codex-auto-review", visibility: "hide" },
          { slug: "gpt-5.6-codex invalid", visibility: "list" },
          { slug: 56, visibility: "list" },
        ],
      }),
    );
    const inventory = await readCodexModelInventory(home);
    assert.deepEqual(inventory, [
      {
        id: "gpt-5.6-terra",
        contextWindow: 258_400,
        capabilities: ["tools", "multimodal"],
        supportsTools: true,
        supportsMultimodal: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "gpt-5.6-sol",
        contextWindow: null,
        capabilities: [],
        supportsTools: false,
        supportsMultimodal: false,
        efforts: ["low"],
      },
      {
        id: "gpt-malformed-profile",
        contextWindow: null,
        capabilities: [],
        supportsTools: null,
        supportsMultimodal: null,
        efforts: [],
      },
      {
        id: "gpt-disabled-tools",
        contextWindow: null,
        capabilities: [],
        supportsTools: null,
        supportsMultimodal: null,
        efforts: null,
      },
    ]);
    assert.deepEqual(
      await readCodexModelIds(home),
      ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-malformed-profile", "gpt-disabled-tools"],
    );
    assert.equal(resolveCodexModelEffort(inventory, "gpt-5.6-terra", "max"), "max");
    assert.equal(
      resolveCodexModelEffort(inventory, "gpt-5.6-sol", "max"),
      "low",
      "exact model profile must cap the runner argument",
    );
    assert.equal(
      resolveCodexModelEffort(inventory, "gpt-malformed-profile", "max"),
      null,
      "present-but-invalid effort metadata must not fall through to generic Codex capabilities",
    );
    assert.equal(resolveCodexModelEffort(inventory, "gpt-unknown", "max"), "xhigh");
    assert.equal(resolveCodexModelEffort(inventory, "gpt-5.6-terra", "ultra"), null);
    assert.doesNotMatch(
      JSON.stringify(inventory),
      /max_context_window|priority|base_instructions|description|costTier|ultra/,
      "inventory must expose only value-safe host facts and must not invent cost",
    );

    fs.writeFileSync(cachePath, "not json");
    assert.deepEqual(await readCodexModelIds(home), [], "corrupt cache must fall back safely");

    fs.writeFileSync(cachePath, "x".repeat(2 * 1024 * 1024 + 1));
    assert.deepEqual(await readCodexModelInventory(home), [], "oversized cache must fail closed");

    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        models: Array.from({ length: 513 }, (_, index) => ({
          slug: `gpt-model-${index}`,
          visibility: "list",
        })),
      }),
    );
    assert.deepEqual(await readCodexModelInventory(home), [], "oversized model inventory must fail closed");

    if (process.platform !== "win32") {
      const target = path.join(home, "symlink-target.json");
      fs.writeFileSync(target, JSON.stringify({ models: [{ slug: "gpt-symlink", visibility: "list" }] }));
      fs.rmSync(cachePath, { force: true });
      fs.symlinkSync(target, cachePath);
      assert.deepEqual(await readCodexModelInventory(home), [], "symlinked cache must fail closed");
    }

    const catalog = require("../dist/shared/models.js").cliModels("codex");
    assert.equal(catalog.some((model) => model.id === "gpt-5.6-codex"), false);
    assert.equal(catalog.some((model) => model.id === "gpt-5.5-codex"), false);
    assert.equal(catalog.find((model) => model.id === "gpt-5.6-sol")?.workforceTier, "frontier");
    assert.equal(catalog.find((model) => model.id === "gpt-5.6-terra")?.workforceTier, "balanced");
    assert.equal(catalog.find((model) => model.id === "gpt-5.6-luna")?.workforceTier, "economy");

    const detectSource = fs.readFileSync(
      path.join(__dirname, "..", "electron", "runtime", "detect.ts"),
      "utf8",
    );
    assert.match(detectSource, /readCodexModelInventory\(\)/);
    assert.match(detectSource, /allocationModelProfiles:\s*codexModelProfiles/);
    assert.match(detectSource, /codexHostCatalog\.get\(model\.id\)\?\.workforceTier/);
    assert.match(detectSource, /capabilities:\s*profile\.capabilities \? \[\.\.\.profile\.capabilities\]/);
    assert.match(detectSource, /efforts:\s*profile\.efforts \? \[\.\.\.profile\.efforts\]/);
    const runnerSource = fs.readFileSync(
      path.join(__dirname, "..", "electron", "runtime", "codex.ts"),
      "utf8",
    );
    assert.match(runnerSource, /resolveCodexModelEffort\(inventory, runReq\.model, runReq\.effort\)/);
    assert.doesNotMatch(runnerSource, /runReq\.effort === "max" \? "xhigh"/);
    console.log("Codex account model discovery contract ok");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
