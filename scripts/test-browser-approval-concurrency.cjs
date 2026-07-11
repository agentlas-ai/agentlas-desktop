#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { app } = require("electron");

const originalLoad = Module._load;
let keychainDeleteShouldFail = false;
Module._load = function loadWithKeytarStub(request, parent, isMain) {
  if (request === "keytar") {
    return {
      getPassword: async () => null,
      setPassword: async () => undefined,
      deletePassword: async () => {
        if (keychainDeleteShouldFail) throw new Error("fixture keychain unavailable");
        return true;
      },
      findCredentials: async () => [],
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-browser-approval-"));
  app.setPath("userData", tmp);
  process.env.AGENTLAS_BROWSER_APPROVAL_TIMEOUT_MS = "25";
  process.env.AGENTLAS_CDP_PORT = "9333";
  process.env.AGENTLAS_CDP_PROFILE = path.join(tmp, "cdp-profile");
  const store = require("../dist/electron/store/db.js");
  const browser = require("../dist/electron/browser/connect.js");
  const vault = require("../dist/electron/store/browser-vault.js");
  const launcher = require("../dist/electron/mcp-tools/browser-cdp-launcher.js");
  try {
    store.initStore();
    const result = await browser.browserRequestApproval({
      site: "example.com",
      actionType: "send",
      summary: "send a message",
    });
    assert.equal(result, "denied", "timeout must fail closed");
    assert.equal(
      store.getDb().prepare("SELECT COUNT(*) AS n FROM browser_permissions").get().n,
      0,
      "timeout must not become a durable site+action deny",
    );
    assert.ok(
      browser.browserLoginArgs("/tmp/profile", "https://example.com").includes(
        "--remote-debugging-port=9333",
      ),
      "manual login must share the automation CDP port",
    );

    await vault.upsertBrowserSite({ site: "readded.example" });
    vault.setBrowserPermission("readded.example", "send", "always");
    assert.equal(vault.getBrowserPermission("readded.example", "send"), "always");
    keychainDeleteShouldFail = true;
    await assert.rejects(
      vault.deleteBrowserSite("readded.example"),
      /fixture keychain unavailable/,
      "a failed legacy-secret cleanup must fail the site deletion",
    );
    assert.ok(vault.getBrowserSite("readded.example"), "failed cleanup must preserve the site for retry");
    assert.equal(
      vault.getBrowserPermission("readded.example", "send"),
      "always",
      "failed cleanup must preserve permissions until the deletion can complete",
    );
    keychainDeleteShouldFail = false;
    await vault.deleteBrowserSite("readded.example");
    assert.equal(
      vault.getBrowserPermission("readded.example", "send"),
      null,
      "deleting a site must delete its durable permissions",
    );

    launcher.writeBrowserCdpOwner(process.pid);
    const ownerFile = launcher.browserCdpOwnerPath();
    const ownerRecord = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    assert.equal(ownerRecord.pid, process.pid);
    assert.equal(ownerRecord.port, Number(process.env.AGENTLAS_CDP_PORT));
    assert.equal(fs.statSync(ownerFile).mode & 0o777, 0o600, "owner marker must remain private");
    launcher.clearBrowserCdpOwner(process.pid + 1);
    assert.equal(fs.existsSync(ownerFile), true, "another pid cannot clear the owner marker");
    launcher.clearBrowserCdpOwner(process.pid);
    assert.equal(fs.existsSync(ownerFile), false);

    const sheet = fs.readFileSync(
      path.join(__dirname, "../renderer/components/BrowserActionApprovalSheet.tsx"),
      "utf8",
    );
    assert.match(sheet, /const req = queue\[0\] \?\? null;/, "approval UI must render FIFO head");
    assert.match(sheet, /\[\.\.\.current, r\]/, "simultaneous approvals must queue, not overwrite");
    assert.match(sheet, /req\.expiresAt - Date\.now\(\)/, "expired sheets must auto-close");

    const connect = fs.readFileSync(path.join(__dirname, "../electron/browser/connect.ts"), "utf8");
    const exitHandler = connect.match(/child\.on\("exit",[\s\S]*?\n\s*}\);/)?.[0] ?? "";
    assert.doesNotMatch(exitHandler, /setBrowserSession\([^,]+,\s*"valid"\)/, "Chrome exit is not login proof");
    console.log("browser approval timeout/queue/login-session contract ok");
  } finally {
    store.getDb().close();
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
