#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
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
          privateModeCompliant: true,
          missing: [],
          overwritten: [],
          permissionIssues: [],
          trackedSensitivePaths: [],
          trackedSensitiveScanComplete: true,
          privacyWarnings: [],
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
      exitCode: null,
      json: null,
      stdout: "",
      stderr: "",
      error: "Could not find the Hephaestus engine (bundle missing).",
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

  const broadNegationProject = project("broad-negation");
  execFileSync("git", ["-C", broadNegationProject, "init", "--quiet"]);
  fs.writeFileSync(path.join(broadNegationProject, ".gitignore"), ".agentlas/\n!*/\n!*\n", "utf8");
  const broadNegation = await bootstrap.ensureDesktopProjectBootstrap({
    projectPath: broadNegationProject,
    access: { permission: "write" },
    runCore: async () => ({
      ok: false,
      exitCode: null,
      json: null,
      stdout: "",
      stderr: "",
      error: "Could not find the Hephaestus engine (bundle missing).",
    }),
  });
  assert.equal(broadNegation.mode, "desktop-fallback");
  execFileSync("git", ["-C", broadNegationProject, "check-ignore", "--quiet", ".agentlas/sitemap.json"]);
  const broadIgnore = fs.readFileSync(path.join(broadNegationProject, ".gitignore"), "utf8");
  assert.ok(broadIgnore.lastIndexOf(".agentlas/") > broadIgnore.lastIndexOf("!*"));

  const concurrentEditProject = project("concurrent-gitignore-edit");
  const concurrentIgnorePath = path.join(concurrentEditProject, ".gitignore");
  fs.writeFileSync(concurrentIgnorePath, "initial-rule/\n", "utf8");
  let concurrentEditInjected = false;
  await bootstrap.ensureDesktopProjectBootstrap({
    projectPath: concurrentEditProject,
    access: { permission: "write" },
    testHooks: {
      beforeFallbackIgnoreAppend: () => {
        if (concurrentEditInjected) return;
        concurrentEditInjected = true;
        fs.appendFileSync(concurrentIgnorePath, "concurrent-user-rule/\n", "utf8");
      },
    },
    runCore: async () => ({
      ok: false,
      exitCode: null,
      json: null,
      stdout: "",
      stderr: "",
      error: "Could not find the Hephaestus engine (bundle missing).",
    }),
  });
  assert.equal(concurrentEditInjected, true);
  const concurrentIgnore = fs.readFileSync(concurrentIgnorePath, "utf8");
  assert.match(concurrentIgnore, /^initial-rule\/$/m);
  assert.match(concurrentIgnore, /^concurrent-user-rule\/$/m, "concurrent user edits must never be overwritten");
  assert.match(concurrentIgnore, /^\.agentlas\/$/m);

  const privacyWarningProject = project("core-privacy-warning");
  const privacyWarning = await bootstrap.ensureDesktopProjectBootstrap({
    projectPath: privacyWarningProject,
    access: { permission: "full" },
    runCore: async () => ({
      ok: true,
      exitCode: 0,
      json: {
        schemaVersion: "agentlas.project-bootstrap.v1",
        status: "privacy_warning",
        mergeOnly: true,
        privacyBlockInstalled: true,
        privateModeCompliant: true,
        missing: [],
        overwritten: [],
        permissionIssues: [],
        trackedSensitivePaths: [".agentlas/project-soul-memory.md"],
        trackedSensitiveScanComplete: true,
        privacyWarnings: [],
      },
      stdout: "",
      stderr: "",
    }),
  });
  assert.equal(privacyWarning.mode, "core-privacy-warning");

  const nonGitProject = project("non-git-core-warning");
  const nonGitResult = await bootstrap.ensureDesktopProjectBootstrap({
    projectPath: nonGitProject,
    access: { permission: "full" },
    runCore: async () => ({
      ok: true,
      exitCode: 0,
      json: {
        schemaVersion: "agentlas.project-bootstrap.v1",
        status: "privacy_warning",
        mergeOnly: true,
        privacyBlockInstalled: true,
        privateModeCompliant: true,
        missing: [],
        overwritten: [],
        permissionIssues: [],
        trackedSensitivePaths: [],
        trackedSensitiveScanComplete: false,
        privacyWarnings: ["tracked_sensitive_scan_incomplete"],
      },
      stdout: "",
      stderr: "",
    }),
  });
  assert.equal(nonGitResult.mode, "core", "non-Git folders must not remain permanently unactivated");

  const malformedCoreProject = project("malformed-core-success");
  await assert.rejects(
    bootstrap.ensureDesktopProjectBootstrap({
      projectPath: malformedCoreProject,
      access: { permission: "full" },
      runCore: async () => ({
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
      }),
    }),
    /incomplete project bootstrap contract/,
  );
  assert.equal(fs.existsSync(path.join(malformedCoreProject, ".agentlas")), false);
  assert.equal(fs.existsSync(path.join(malformedCoreProject, ".gitignore")), false);

  const oversizedIgnoreProject = project("oversized-ignore");
  const oversizedIgnorePath = path.join(oversizedIgnoreProject, ".gitignore");
  fs.writeFileSync(oversizedIgnorePath, Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(
    bootstrap.ensureDesktopProjectBootstrap({
      projectPath: oversizedIgnoreProject,
      access: { permission: "write" },
      runCore: async () => ({
        ok: false,
        exitCode: null,
        json: null,
        stdout: "",
        stderr: "",
        error: "Could not find the Hephaestus engine (bundle missing).",
      }),
    }),
    /safe bootstrap limit/,
  );
  assert.equal(fs.statSync(oversizedIgnorePath).size, 1024 * 1024 + 1);
  assert.equal(fs.existsSync(path.join(oversizedIgnoreProject, ".agentlas")), false);

  if (process.platform !== "win32") {
    const symlinkIgnoreProject = project("symlink-ignore");
    const externalIgnore = path.join(temp, "external.gitignore");
    fs.writeFileSync(externalIgnore, "external-only\n", "utf8");
    fs.symlinkSync(externalIgnore, path.join(symlinkIgnoreProject, ".gitignore"));
    await assert.rejects(
      bootstrap.ensureDesktopProjectBootstrap({
        projectPath: symlinkIgnoreProject,
        access: { permission: "write" },
        runCore: async () => ({
          ok: false,
          exitCode: null,
          json: null,
          stdout: "",
          stderr: "",
          error: "Could not find the Hephaestus engine (bundle missing).",
        }),
      }),
      /regular non-symbolic-link file/,
    );
    assert.equal(fs.readFileSync(externalIgnore, "utf8"), "external-only\n");
    assert.equal(fs.existsSync(path.join(symlinkIgnoreProject, ".agentlas")), false);
  }

  const lockTimeoutProject = project("core-lock-timeout");
  await assert.rejects(
    bootstrap.ensureDesktopProjectBootstrap({
      projectPath: lockTimeoutProject,
      access: { permission: "write" },
      runCore: async () => ({
        ok: false,
        exitCode: 1,
        json: { error: "project_bootstrap_lock_timeout" },
        stdout: '{"error":"project_bootstrap_lock_timeout"}\n',
        stderr: "",
      }),
    }),
    /failed before its write state could be verified/,
  );
  assert.equal(fs.existsSync(path.join(lockTimeoutProject, ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(lockTimeoutProject, ".agentlas")), false);

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
