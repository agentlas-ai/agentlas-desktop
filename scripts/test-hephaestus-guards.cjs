#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, dialog } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-hep-guard-"));

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

(async () => {
  let exitCode = 0;
  const originalShowMessageBox = dialog.showMessageBox;
  try {
    const messageBoxes = [];
    dialog.showMessageBox = async (...args) => {
      const opts = args.length === 2 ? args[1] : args[0];
      messageBoxes.push(opts);
      return { response: messageBoxes.length === 1 ? 0 : 1 };
    };

    const { PathGuardError, confirmUpload, resolveFolderArg } = require("../dist/electron/hephaestus/path-guard.js");
    const { hepPackage, hepPublish, securityScan } = require("../dist/electron/hephaestus/commands.js");

    const agentRoot = path.join(tempDir, "safe-agent");
    writeFile(path.join(agentRoot, "AGENTS.md"), "# Safe Agent\n\nOnly this folder should be accepted.\n");
    const safeResolved = resolveFolderArg(agentRoot);
    assert.equal(safeResolved, fs.realpathSync.native(agentRoot));

    assert.throws(() => resolveFolderArg(""), PathGuardError);
    assert.throws(() => resolveFolderArg("-flag"), /옵션처럼 보입니다/);
    assert.throws(() => resolveFolderArg(path.join(tempDir, "missing")), /폴더를 찾을 수 없습니다/);

    const filePath = path.join(tempDir, "not-a-folder.txt");
    fs.writeFileSync(filePath, "not a folder", "utf8");
    assert.throws(() => resolveFolderArg(filePath), /디렉터리/);
    assert.throws(() => resolveFolderArg(os.homedir()), /너무 넓은 시스템 폴더/);

    const cancel = await confirmUpload(safeResolved, "marketplace", null);
    assert.equal(cancel, false, "cancel button must block upload");
    assert.match(messageBoxes[0].detail, /Agentlas Hub/);
    assert.match(messageBoxes[0].detail, new RegExp(safeResolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const approve = await confirmUpload(safeResolved, "private-link", null);
    assert.equal(approve, true, "upload button should explicitly approve upload");
    assert.match(messageBoxes[1].detail, /Agentlas Cloud/);

    assert.throws(() => hepPublish("-danger", "marketplace", { dryRun: true }), /잘못된 폴더/);
    assert.throws(() => hepPackage("-danger"), /잘못된 폴더/);
    assert.throws(() => securityScan("-danger"), /잘못된 폴더/);

    console.log(
      JSON.stringify(
        {
          ok: true,
          safeResolved,
          messageBoxes: messageBoxes.length,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    dialog.showMessageBox = originalShowMessageBox;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
