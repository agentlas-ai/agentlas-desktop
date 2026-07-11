#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { app } = require("electron");

const originalLoad = Module._load;
let keychainDeleteShouldFail = false;
let connectLauncherStub = null;
let connectSpawnStub = null;
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
  const parentFile = String(parent?.filename || "").replace(/\\/g, "/");
  if (
    connectLauncherStub &&
    request === "../mcp-tools/browser-cdp-launcher" &&
    parentFile.endsWith("/dist/electron/browser/connect.js")
  ) {
    return connectLauncherStub;
  }
  if (
    connectSpawnStub &&
    request === "node:child_process" &&
    parentFile.endsWith("/dist/electron/browser/connect.js")
  ) {
    return { ...originalLoad.call(this, request, parent, isMain), spawn: connectSpawnStub };
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
  const vault = require("../dist/electron/store/browser-vault.js");
  const launcher = require("../dist/electron/mcp-tools/browser-cdp-launcher.js");
  const owned = { state: "owned", pid: 4242, reason: "listener-and-marker-match" };
  let reconcileCalls = 0;
  let reconcileImpl = async () => owned;
  let portReadyImpl = async () => true;
  connectLauncherStub = {
    ...launcher,
    browserCdpPortReady: async (...args) => portReadyImpl(...args),
    reconcileBrowserCdpOwnerWithRetry: async (...args) => {
      reconcileCalls += 1;
      return reconcileImpl(...args);
    },
    resolveChromeExe: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  };
  const spawnCalls = [];
  const pendingChildExitTurns = [];
  connectSpawnStub = (executable, args) => {
    const child = new EventEmitter();
    child.pid = 50_000 + spawnCalls.length;
    child.killed = false;
    child.unref = () => undefined;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    spawnCalls.push({ executable, args: [...args], child });
    // A real ChildProcess exits asynchronously. Keep the mock asynchronous too,
    // but track the turn so teardown cannot close SQLite before connect.ts has
    // finished its exit-event audit log.
    const exitTurn = new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          child.emit("exit", 0, null);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    pendingChildExitTurns.push(exitTurn);
    return child;
  };
  const browser = require("../dist/electron/browser/connect.js");
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
    assert.equal(vault.normalizeSite("https://www.Example.com/path?q=1"), "example.com");
    assert.equal(vault.normalizeSite("https://example.com:8443/login"), "example.com:8443");
    assert.equal(
      vault.normalizeSite("https://user:password@example.com/login"),
      "",
      "browser site keys must reject URL userinfo so credentials cannot reach logs",
    );
    await assert.rejects(
      vault.upsertBrowserSite({ site: "https://user:password@example.com" }),
      /Site address is empty/,
    );

    await vault.upsertBrowserSite({ site: "same.example" });
    let releaseSameOwnership;
    reconcileCalls = 0;
    reconcileImpl = () => new Promise((resolve) => { releaseSameOwnership = resolve; });
    const sameFirst = browser.browserOpenLogin("same.example");
    const sameSecond = browser.browserOpenLogin("same.example");
    assert.equal(sameFirst, sameSecond, "same-site concurrent login requests must share one flight");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    assert.equal(spawnCalls.length, 0, "Chrome must not spawn before ownership settles");
    releaseSameOwnership(owned);
    const sameResults = await Promise.all([sameFirst, sameSecond]);
    assert.ok(sameResults.every((item) => item.ok));
    assert.equal(spawnCalls.length, 1, "same-site double calls must spawn one login window");

    await vault.upsertBrowserSite({ site: "first.example" });
    await vault.upsertBrowserSite({ site: "second.example" });
    const releases = [];
    reconcileCalls = 0;
    spawnCalls.length = 0;
    reconcileImpl = () => new Promise((resolve) => { releases.push(resolve); });
    const firstOpen = browser.browserOpenLogin("first.example");
    const secondOpen = browser.browserOpenLogin("second.example");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1, "different-site login requests must not inspect ownership concurrently");
    releases.shift()(owned);
    assert.equal((await firstOpen).ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 2, "the queued site must start after the first request settles");
    releases.shift()(owned);
    assert.equal((await secondOpen).ok, true);
    assert.deepEqual(
      spawnCalls.map((call) => call.args.at(-1)),
      ["https://first.example", "https://second.example"],
      "cross-site login windows must preserve request order",
    );
    reconcileImpl = async () => owned;

    await vault.upsertBrowserSite({ site: "cleanup.example" });
    let readyChecks = 0;
    portReadyImpl = async () => {
      readyChecks += 1;
      return readyChecks > 1;
    };
    reconcileImpl = async () => ({
      state: "foreign",
      pid: 99_999,
      reason: "listener-command-mismatch",
    });
    spawnCalls.length = 0;
    const cleanupResult = await browser.browserOpenLogin("cleanup.example");
    assert.equal(cleanupResult.ok, false);
    assert.equal(spawnCalls.length, 1);
    assert.equal(
      spawnCalls[0].child.killed,
      true,
      "a Chrome child spawned for a listener that cannot be verified must be terminated",
    );

    await vault.upsertBrowserSite({ site: "safe-log.example" });
    portReadyImpl = async () => true;
    reconcileImpl = async () => ({
      state: "unverifiable",
      pid: null,
      reason: "Command failed while reading /Users/private/credential.txt",
    });
    const safeLogResult = await browser.browserOpenLogin("safe-log.example");
    assert.equal(safeLogResult.ok, false);
    const safeLog = store.getDb()
      .prepare("SELECT target, meta FROM browser_action_logs WHERE action = 'session.login_window_blocked' AND site = ? ORDER BY ts DESC LIMIT 1")
      .get("safe-log.example");
    assert.equal(safeLog.target, "https://safe-log.example");
    assert.deepEqual(JSON.parse(safeLog.meta), {
      state: "unverifiable",
      reasonCode: "inspection-error",
      pid: null,
      port: 9333,
    });
    assert.doesNotMatch(safeLog.meta, /Users|credential/i, "raw local error details must not persist in browser logs");
    reconcileImpl = async () => owned;

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
    console.log("browser approval timeout/queue/login-session/CDP single-flight contract ok");
  } finally {
    Module._load = originalLoad;
    await Promise.all(pendingChildExitTurns);
    store.getDb().close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
