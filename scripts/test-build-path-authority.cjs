#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-build-authority-"));
  process.env.AGENTLAS_FS_GRANT_STORE = path.join(root, "grants.json");
  await app.whenReady();

  const access = require("../dist/electron/fs/access.js");
  const { resolveHephaestusBuildRequest } = require("../dist/electron/hephaestus/build-access.js");
  const { resolveCloudAgentPackageRequest } = require("../dist/electron/cloud-agents/access.js");
  const { stageAttachments } = require("../dist/electron/hephaestus/build-attachments.js");
  const { verifiedCompletedPackageRoot } = require("../dist/electron/hephaestus/build-result-path.js");

  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  const note = path.join(source, "note.md");
  fs.writeFileSync(note, "trusted attachment\n", "utf8");

  const workspaceGrant = access.grantPath(workspace, { durable: true });
  const noteGrant = access.grantPath(note, { durable: false, exactFile: true });
  const resolved = resolveHephaestusBuildRequest({
    request: "Build an agent",
    workspaceGrant,
    attachments: [{ grant: noteGrant, name: "note.md" }],
  });
  assert.equal(resolved.workspace, fs.realpathSync.native(workspace));
  assert.equal(resolved.attachments[0].path, fs.realpathSync.native(note));
  const packageRoot = path.join(workspace, "generated-agent");
  fs.mkdirSync(packageRoot);
  assert.equal(access.resolveFsReadPath(packageRoot, workspaceGrant.scope), fs.realpathSync.native(packageRoot));
  assert.deepEqual(
    verifiedCompletedPackageRoot(workspace, "BUILD_COMPLETE: generated-agent"),
    { root: fs.realpathSync.native(packageRoot) },
  );
  const actualPackageRoot = path.join(workspace, "actual-package");
  fs.mkdirSync(actualPackageRoot);
  assert.deepEqual(
    verifiedCompletedPackageRoot(
      workspace,
      "BUILD_COMPLETE: generated-agent\nLater work replaced that draft.\nBUILD_COMPLETE: actual-package",
    ),
    { root: fs.realpathSync.native(actualPackageRoot) },
    "the final BUILD_COMPLETE receipt must select the scanned and delivered package",
  );
  assert.deepEqual(
    verifiedCompletedPackageRoot(workspace, `BUILD_COMPLETE: ${path.basename(workspace)}`),
    { root: fs.realpathSync.native(workspace) },
    "a package written directly into the approved workspace remains valid",
  );
  assert.match(
    verifiedCompletedPackageRoot(workspace, "BUILD_COMPLETE: ../source").error,
    /invalid|outside/i,
    "traversal-like completion paths must stay unverified",
  );
  const completionFile = path.join(workspace, "not-a-package.md");
  fs.writeFileSync(completionFile, "not a directory\n");
  assert.match(
    verifiedCompletedPackageRoot(workspace, "BUILD_COMPLETE: not-a-package.md").error,
    /not a directory/i,
  );
  const completionLink = path.join(workspace, "outside-link");
  fs.symlinkSync(source, completionLink);
  assert.match(
    verifiedCompletedPackageRoot(workspace, "BUILD_COMPLETE: outside-link").error,
    /verified|scope|symbolic/i,
    "a symlink completion target must never become the scanned/delivered package root",
  );
  assert.throws(
    () => access.resolveFsReadPath(source, workspaceGrant.scope),
    /scope|outside|denied/i,
    "import/publish targets must remain inside the approved build workspace",
  );
  assert.equal(
    resolveCloudAgentPackageRequest({ rootGrant: workspaceGrant }).rootPath,
    fs.realpathSync.native(workspace),
    "Cloud packaging must resolve the native-picker capability in main",
  );
  assert.throws(
    () => resolveCloudAgentPackageRequest({ rootGrant: { ...workspaceGrant, path: source } }),
    /capability|scope|path/i,
    "a renderer cannot retarget a Cloud package capability to another folder",
  );

  assert.throws(
    () => resolveHephaestusBuildRequest({
      request: "tampered workspace",
      workspaceGrant: { ...workspaceGrant, path: source },
    }),
    /capability|scope|path/i,
    "a renderer path that does not match the picker capability must be rejected",
  );
  assert.throws(
    () => resolveHephaestusBuildRequest({
      request: "tampered attachment",
      workspaceGrant,
      attachments: [{ grant: { ...noteGrant, path: "/etc/passwd" }, name: "passwd" }],
    }),
    /capability|scope|path/i,
    "an arbitrary attachment path must not inherit another file's capability",
  );
  assert.throws(
    () => resolveHephaestusBuildRequest({
      request: "too many attachments",
      workspaceGrant,
      attachments: Array.from({ length: 65 }, () => ({ grant: noteGrant, name: "note.md" })),
    }),
    /at most 64 attachments/i,
  );

  const staged = stageAttachments(workspace, resolved.attachments);
  assert.equal(staged.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(workspace, "_attachments", "note.md"), "utf8"), "trusted attachment\n");

  const overlap = stageAttachments(workspace, [{ path: workspace, name: "workspace" }]);
  assert.ok(overlap.errors.some((item) => /overlaps the output workspace/.test(item)));
  assert.equal(fs.existsSync(path.join(workspace, "_attachments", "workspace")), false);

  const linkedDir = path.join(root, "linked-dir");
  fs.mkdirSync(linkedDir);
  fs.symlinkSync("/etc/passwd", path.join(linkedDir, "outside-link"));
  const linked = stageAttachments(workspace, [{ path: linkedDir, name: "linked-dir" }]);
  assert.ok(linked.errors.some((item) => /symbolic links are not staged/.test(item)));
  assert.equal(fs.existsSync(path.join(workspace, "_attachments", "linked-dir", "outside-link")), false);

  const largeDir = path.join(root, "large-dir");
  fs.mkdirSync(largeDir);
  const largeFile = path.join(largeDir, "too-large.bin");
  fs.writeFileSync(largeFile, "");
  fs.truncateSync(largeFile, 200 * 1024 * 1024 + 1);
  const large = stageAttachments(workspace, [{ path: largeDir, name: "large-dir" }]);
  assert.ok(large.errors.some((item) => /size cap exceeded/.test(item)));
  assert.equal(fs.existsSync(path.join(workspace, "_attachments", "large-dir", "too-large.bin")), false);

  const ipcSource = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
  assert.match(ipcSource, /team:importLocalFolder[\s\S]{0,220}resolveFsReadPath\(input\.path, input\.scope\)/);
  assert.match(ipcSource, /hephaestus:publish[\s\S]{0,520}resolveFsReadPath\(input\.folder, input\.scope\)/);
  assert.match(ipcSource, /hephaestus:securityScan[\s\S]{0,260}resolveFsReadPath\(input\.folder, input\.scope\)/);

  fs.rmSync(root, { recursive: true, force: true });
  console.log("build path authority and attachment staging: PASS");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
