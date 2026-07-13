#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-desktop-bootstrap-contract-"));

function project(name) {
  const target = path.join(temp, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

async function main() {
  await app.whenReady();
  const bootstrap = require("../dist/electron/architecture/project-bootstrap.js");

  const coreProject = project("core-success");
  let coreCalls = 0;
  const coreResult = await bootstrap.ensureDesktopProjectBootstrap({
    projectPath: coreProject,
    access: { permission: "full" },
    reason: "desktop-contract-test",
    runCore: async (moduleName, args, options) => {
      coreCalls += 1;
      assert.equal(moduleName, "agentlas_cloud");
      assert.deepEqual(args.slice(0, 2), ["project", "ensure"]);
      assert.equal(args[args.indexOf("--project") + 1], fs.realpathSync.native(coreProject));
      assert.equal(options.cwd, fs.realpathSync.native(coreProject));
      return {
        ok: true,
        exitCode: 0,
        json: {
          schemaVersion: "agentlas.project-bootstrap.v1",
          status: "active",
          mergeOnly: true,
          privacyBlockInstalled: true,
        },
        stdout: "",
        stderr: "",
      };
    },
  });
  assert.equal(coreResult.mode, "core");
  assert.equal(coreCalls, 1);
  assert.equal(fs.existsSync(path.join(coreProject, ".agentlas")), false, "Core owns the canonical writes");

  const fallbackProject = project("fallback");
  fs.writeFileSync(path.join(fallbackProject, ".gitignore"), "node_modules/\n", "utf8");
  fs.mkdirSync(path.join(fallbackProject, ".agentlas"), { mode: 0o700 });
  const existingSoul = "# Existing operator memory\n\nNever replace me.\n";
  fs.writeFileSync(path.join(fallbackProject, ".agentlas", "project-soul-memory.md"), existingSoul, { mode: 0o600 });
  const fallback = await bootstrap.ensureDesktopProjectBootstrap({
    projectPath: fallbackProject,
    projectName: "Fallback Project",
    access: { permission: "write" },
    runCore: async () => ({
      ok: false,
      exitCode: 2,
      json: null,
      stdout: "",
      stderr: "old core",
    }),
  });
  assert.equal(fallback.mode, "desktop-fallback");
  assert.equal(fs.readFileSync(path.join(fallbackProject, ".agentlas", "project-soul-memory.md"), "utf8"), existingSoul);
  const ignore = fs.readFileSync(path.join(fallbackProject, ".gitignore"), "utf8");
  assert.match(ignore, /^node_modules\/$/m, "existing ignore content must be preserved");
  assert.match(ignore, /^\.agentlas\/$/m, "the whole local state directory must be private before seeding");
  assert.equal(fs.existsSync(path.join(fallbackProject, ".agentlas", "sitemap.json")), true);
  assert.equal(fs.existsSync(path.join(fallbackProject, ".agentlas", "memory-tickets.jsonl")), true);
  for (const forbidden of [".env.example", "signing", "credentials"]) {
    assert.equal(fs.existsSync(path.join(fallbackProject, forbidden)), false, `fallback must not create ${forbidden}`);
  }
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(fallbackProject, ".agentlas", "sitemap.json")).mode & 0o777, 0o600);
  }

  for (const [name, access] of [
    ["site-agent-app", { permission: "full", agentAppMode: true }],
    ["mobile-restricted", { permission: "full", restrictedReadBoundary: true }],
    ["unattended-read", { permission: "read" }],
  ]) {
    const deniedProject = project(name);
    let deniedCoreCalls = 0;
    await assert.rejects(
      bootstrap.ensureDesktopProjectBootstrap({
        projectPath: deniedProject,
        access,
        runCore: async () => {
          deniedCoreCalls += 1;
          throw new Error("must not run");
        },
      }),
      /interactive writable Desktop project/,
    );
    assert.equal(deniedCoreCalls, 0);
    assert.equal(fs.existsSync(path.join(deniedProject, ".agentlas")), false);
    assert.equal(fs.existsSync(path.join(deniedProject, ".gitignore")), false);
  }

  const activationSource = fs.readFileSync(path.join(__dirname, "..", "electron", "architecture", "activation.ts"), "utf8");
  assert.match(activationSource, /export async function recordFolderVisit/);
  assert.match(activationSource, /bootstrap\.mode === "core"/);
  assert.doesNotMatch(activationSource, /ACTIVATE_AT_VISITS|ensureProjectMemory/);
  const clientSource = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp", "client.ts"), "utf8");
  assert.match(clientSource, /await recordFolderVisit\([\s\S]*restrictedReadBoundary[\s\S]*agentAppMode/);

  console.log("Desktop project bootstrap boundary: PASS");
}

main()
  .catch((error) => {
    console.error("Desktop project bootstrap boundary: FAIL", error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
    app.exit(process.exitCode || 0);
  });
