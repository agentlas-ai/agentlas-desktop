#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  await app.whenReady();
  const coreRoot = process.env.HEPHAESTUS_RUNTIME_ROOT;
  assert.ok(
    coreRoot && fs.existsSync(path.join(coreRoot, "agentlas_cloud", "project_bootstrap.py")),
    "a Core runtime with canonical project bootstrap is required",
  );
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-desktop-core-bootstrap-"));
  fs.writeFileSync(path.join(project, "main.ts"), "export function desktopFirstContact() { return true; }\n");
  fs.mkdirSync(path.join(project, ".agentlas"), { mode: 0o700 });
  const existingSoul = "# Existing project memory\n\nOperator-owned content.\n";
  fs.writeFileSync(path.join(project, ".agentlas", "project-soul-memory.md"), existingSoul, { mode: 0o600 });
  try {
    const { runHephaestus } = require("../dist/electron/hephaestus/engine.js");
    const result = await runHephaestus(
      "agentlas_cloud",
      ["project", "ensure", "--project", project, "--reason", "desktop-contract-test"],
      { cwd: project, timeoutMs: 120_000, locale: "en" },
    );
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.equal(result.json.schemaVersion, "agentlas.project-bootstrap.v1");
    assert.equal(result.json.status, "active");
    assert.equal(result.json.mergeOnly, true);
    assert.equal(result.json.privacyBlockInstalled, true);
    assert.deepEqual(result.json.overwritten, []);
    assert.equal(fs.readFileSync(path.join(project, ".agentlas", "project-soul-memory.md"), "utf8"), existingSoul);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "code-map", "project-map.json")), true);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "ontology-runtime.sqlite")), true);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "career-graph.sqlite")), true);
    console.log("Desktop -> Core project bootstrap: PASS");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error("Desktop -> Core project bootstrap: FAIL", error);
  app.exit(1);
});
