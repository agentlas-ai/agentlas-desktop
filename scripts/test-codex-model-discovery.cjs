#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { readCodexModelIds } = require("../dist/electron/runtime/codex-models.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-codex-models-"));
  try {
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-5.6-terra", visibility: "list" },
          { slug: "gpt-5.6-sol", visibility: "list" },
          { slug: "gpt-5.6-terra", visibility: "list" },
          { slug: "codex-auto-review", visibility: "hide" },
          { slug: "gpt-5.6-codex invalid", visibility: "list" },
          { slug: 56, visibility: "list" },
        ],
      }),
    );
    assert.deepEqual(await readCodexModelIds(home), ["gpt-5.6-terra", "gpt-5.6-sol"]);

    fs.writeFileSync(path.join(home, "models_cache.json"), "not json");
    assert.deepEqual(await readCodexModelIds(home), [], "corrupt cache must fall back safely");

    const catalog = require("../dist/shared/models.js").cliModels("codex");
    assert.equal(catalog.some((model) => model.id === "gpt-5.6-codex"), false);
    assert.equal(catalog.some((model) => model.id === "gpt-5.5-codex"), false);
    console.log("Codex account model discovery contract ok");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
