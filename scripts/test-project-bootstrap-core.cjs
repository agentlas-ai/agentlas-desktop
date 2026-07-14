const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  await app.whenReady();
  const coreRoot = process.env.HEPHAESTUS_RUNTIME_ROOT;
  assert.ok(coreRoot && fs.existsSync(path.join(coreRoot, "agentlas_cloud", "project_bootstrap.py")), "new Agentlas Core runtime is required");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-desktop-project-bootstrap-"));
  fs.writeFileSync(path.join(project, "main.ts"), "export function desktopFirstContact() { return true; }\n");
  try {
    const { runHephaestus } = require("../dist/electron/hephaestus/engine.js");
    const result = await runHephaestus(
      "agentlas_cloud",
      ["project", "ensure", "--project", project, "--reason", "desktop-contract-test"],
      { cwd: project, timeoutMs: 120_000, locale: "en" },
    );
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.equal(result.json.schemaVersion, "agentlas.project-bootstrap.v1");
    assert.equal(["active", "privacy_warning"].includes(result.json.status), true);
    assert.equal(result.json.mergeOnly, true);
    assert.equal(result.json.privacyBlockInstalled, true);
    assert.equal(result.json.privateModeCompliant, true);
    assert.deepEqual(result.json.missing, []);
    assert.deepEqual(result.json.overwritten, []);
    assert.deepEqual(result.json.permissionIssues, []);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "project-soul-memory.md")), true);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "code-map", "project-map.json")), true);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "ontology-runtime.sqlite")), true);
    assert.equal(fs.existsSync(path.join(project, ".agentlas", "career-graph.sqlite")), true);

    const activation = fs.readFileSync(path.join(__dirname, "..", "electron", "architecture", "activation.ts"), "utf8");
    assert.match(activation, /export async function recordFolderVisit/);
    assert.match(activation, /\["project", "ensure"/);
    assert.doesNotMatch(activation, /ACTIVATE_AT_VISITS|visits\s*>=\s*2/);
    console.log("desktop project bootstrap core: PASS");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
