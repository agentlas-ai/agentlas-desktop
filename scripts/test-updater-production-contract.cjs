#!/usr/bin/env node
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const watchdog = setTimeout(() => {
  console.error("test-updater-production-contract: TIMEOUT");
  app.exit(1);
  process.exit(1);
}, 45_000);

const {
  CONTINUITY_CORE_TABLES,
  DesktopUpdaterController,
} = require("../dist/electron/updater/controller.js");
const {
  captureUpdaterContinuity,
  verifyUpdaterContinuity,
} = require("../dist/electron/updater/continuity.js");
const { preflightUpdaterStartup } = require("../dist/electron/updater.js");

const compatibility = {
  minimumSourceAppVersion: "0.7.0",
  minimumRuntimeVersion: "1.0.4",
  minimumSchemaVersion: 35,
  targetSchemaVersion: 51,
  bundledRuntimeVersion: "1.1.12",
};

class FakeUpdater extends EventEmitter {
  constructor(options = {}) {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = true;
    this.updateInfo = options.updateInfo || null;
    this.downloadError = options.downloadError || null;
    this.installError = options.installError || null;
    this.checkGate = options.checkGate || null;
    this.checkCount = 0;
    this.downloadCount = 0;
    this.installCount = 0;
  }

  async checkForUpdates() {
    this.checkCount += 1;
    this.emit("checking-for-update");
    if (this.checkGate) await this.checkGate;
    if (!this.updateInfo) {
      this.emit("update-not-available", { version: "0.7.28" });
      return { isUpdateAvailable: false, updateInfo: { version: "0.7.28" } };
    }
    this.emit("update-available", this.updateInfo);
    return { isUpdateAvailable: true, updateInfo: this.updateInfo };
  }

  async downloadUpdate() {
    this.downloadCount += 1;
    if (this.downloadError) throw this.downloadError;
    this.emit("download-progress", { percent: 41.6 });
    this.emit("update-downloaded", this.updateInfo);
    return ["update.zip"];
  }

  quitAndInstall() {
    this.installCount += 1;
    if (this.installError) throw this.installError;
  }
}

function makeLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-updater-contract-"));
  const homePath = path.join(root, "home");
  const userDataPath = path.join(root, "user-data");
  const resourcesPath = path.join(root, "resources");
  const bundlePath = path.join(root, "Applications", "Agentlas.app");
  const execPath = path.join(bundlePath, "Contents", "MacOS", "Agentlas");
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(execPath, "previous-app-binary");
  fs.chmodSync(execPath, 0o755);
  return { root, homePath, userDataPath, resourcesPath, bundlePath, execPath };
}

function mockContinuity(layout) {
  const backupPath = path.join(layout.userDataPath, "updater", "recovery", "0.7.29", "agentlas.sqlite");
  const agentsBackupPath = path.join(path.dirname(backupPath), "agents");
  const rowCounts = Object.fromEntries(CONTINUITY_CORE_TABLES.map((table) => [table, 0]));
  Object.assign(rowCounts, { installed_agents: 2, firms: 1, hub_agent_bookmarks: 1 });
  const tableIdentityHashes = Object.fromEntries(CONTINUITY_CORE_TABLES.map((table) => [table, "a".repeat(64)]));
  return {
    snapshot: () => ({
      schemaVersion: 1,
      userDataPath: layout.userDataPath,
      databasePath: path.join(layout.userDataPath, "agentlas.sqlite"),
      backupPath,
      databaseSchemaVersion: 51,
      rowCounts,
      tableIdentityHashes,
      agentDirectoryNames: ["alpha", "beta"],
      agentAssetHashes: {},
      agentsBackupPath,
      authCookiePresent: true,
      accountSignedIn: true,
      accountExpiresAt: 1_900_000_000_000,
      routeFilePresent: false,
      routeFileHash: null,
      routeBackupPath: null,
      capturedAt: new Date(0).toISOString(),
    }),
    capture: async () => {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.mkdirSync(agentsBackupPath, { recursive: true });
      fs.writeFileSync(backupPath, "safe-sqlite-backup");
      return mockContinuity(layout).snapshot();
    },
  };
}

function makeController(layout, updater, options = {}) {
  const states = [];
  const revealed = [];
  const opened = [];
  const continuity = mockContinuity(layout);
  const controller = new DesktopUpdaterController({
    updater,
    currentVersion: () => options.currentVersion || "0.7.28",
    platform: options.platform || "darwin",
    execPath: layout.execPath,
    resourcesPath: layout.resourcesPath,
    userDataPath: layout.userDataPath,
    homePath: layout.homePath,
    uid: options.uid === undefined ? process.getuid() : options.uid,
    runtimeVersion: () => options.runtimeVersion === undefined ? "1.1.12" : options.runtimeVersion,
    databaseSchemaVersion: () => options.databaseSchemaVersion === undefined ? 51 : options.databaseSchemaVersion,
    captureContinuity: options.captureContinuity || continuity.capture,
    verifyContinuity: options.verifyContinuity || (async () => ({ ok: true, violations: [] })),
    broadcast: (state) => states.push(structuredClone(state)),
    openExternal: async (url) => opened.push(url),
    revealPath: (filePath) => revealed.push(filePath),
    schedule: false,
    now: options.now || (() => 1_800_000_000_000),
    removePath: options.removePath,
    logger: { log() {}, warn() {}, error() {} },
  });
  return { controller, states, revealed, opened, continuity };
}

function seedStaleMacInstallState(layout) {
  const updaterCache = path.join(layout.homePath, "Library", "Caches", "agentlas-desktop-updater");
  const shipIt = path.join(layout.homePath, "Library", "Caches", "com.agentlas.desktop.ShipIt");
  fs.mkdirSync(path.join(updaterCache, "pending"), { recursive: true });
  fs.writeFileSync(path.join(updaterCache, "pending", "update-info.json"), "{}");
  fs.writeFileSync(path.join(updaterCache, "update.zip"), "stale");
  fs.mkdirSync(path.join(shipIt, "update.missing"), { recursive: true });
  fs.writeFileSync(path.join(shipIt, "ShipItState.plist"), "stale-update-path");
  fs.writeFileSync(path.join(shipIt, "update.missing", "ghost"), "ghost");
  return { updaterCache, shipIt };
}

async function rootOwnedBundleFailsClosed() {
  const layout = makeLayout();
  const updater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  const { controller, opened } = makeController(layout, updater, { uid: process.getuid() + 1 });
  await controller.init();
  const first = await controller.check();
  assert.equal(first.status, "manual-required");
  assert.equal(first.code, "install-not-owned");
  assert.equal(updater.downloadCount, 0, "root/other-owned app must not download an auto-install payload");
  const second = await controller.check();
  assert.equal(second.code, "install-not-owned", "repeated checks must retain the real ownership reason");
  assert.equal(updater.downloadCount, 0, "same blocked target must never enter a download/install loop");
  assert.equal((await controller.install()).accepted, false);
  assert.equal(updater.installCount, 0);
  assert.equal(fs.readFileSync(layout.execPath, "utf8"), "previous-app-binary");
  assert.equal((await controller.openManualDownload()).accepted, true);
  assert.deepEqual(opened, ["https://agentlas.cloud/desktop"]);
  controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function installJournalStopsFailedApplyLoopAndReconcilesSuccess() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const firstUpdater = new FakeUpdater({ updateInfo });
  const first = makeController(layout, firstUpdater);
  await first.controller.init();
  assert.equal((await first.controller.check()).status, "downloaded");
  assert.equal(firstUpdater.downloadCount, 1);
  const installResult = await first.controller.install();
  assert.equal(installResult.accepted, true);
  assert.equal(installResult.state.status, "installing");
  assert.equal(firstUpdater.installCount, 1);
  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  assert.equal(fs.existsSync(journalPath), true, "install intent must be durable before quitAndInstall");
  const backupPath = first.continuity.snapshot().backupPath;
  assert.equal(fs.existsSync(backupPath), true);
  first.controller.dispose();

  const stale = seedStaleMacInstallState(layout);
  const retryUpdater = new FakeUpdater({ updateInfo });
  const retry = makeController(layout, retryUpdater);
  await retry.controller.init();
  assert.equal(retry.controller.getState().status, "manual-required");
  assert.equal(retry.controller.getState().code, "install-not-applied");
  assert.equal(fs.existsSync(path.join(stale.shipIt, "ShipItState.plist")), false, "failed ShipIt instruction must be cleared");
  assert.equal(fs.existsSync(path.join(stale.shipIt, "update.missing")), false, "failed ShipIt payload dir must be cleared");
  assert.equal(fs.existsSync(path.join(stale.updaterCache, "update.zip")), false, "stale update zip must be cleared");
  await retry.controller.check();
  assert.equal(retryUpdater.downloadCount, 0, "failed target must not be downloaded or installed again");
  assert.equal(retryUpdater.installCount, 0);
  assert.equal(fs.readFileSync(layout.execPath, "utf8"), "previous-app-binary", "failed apply leaves previous app intact");
  retry.controller.dispose();

  const relaunched = makeController(layout, new FakeUpdater(), { currentVersion: "0.7.29" });
  await relaunched.controller.init();
  assert.equal(relaunched.controller.getState().status, "updated");
  assert.equal(fs.existsSync(journalPath), false, "verified relaunch clears the install intent");
  assert.equal(fs.existsSync(backupPath), true, "verified recovery copy remains available after success");
  relaunched.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function legacyOrphanShipItStateIsClearedBeforeFreshCheck() {
  const layout = makeLayout();
  const stale = seedStaleMacInstallState(layout);
  const updater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  const { controller } = makeController(layout, updater);
  await controller.init();
  assert.equal(fs.existsSync(path.join(stale.shipIt, "ShipItState.plist")), false);
  assert.equal(fs.existsSync(path.join(stale.shipIt, "update.missing")), false);
  assert.equal(fs.existsSync(path.join(stale.updaterCache, "update.zip")), false);
  assert.equal(
    (await controller.check()).status,
    "downloaded",
    "startup cleanup must not block a freshly verified update check",
  );
  assert.equal(updater.downloadCount, 1);
  controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function undeletableLegacyStatePausesAutomaticUpdates() {
  const layout = makeLayout();
  const stale = seedStaleMacInstallState(layout);
  const updater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  const { controller } = makeController(layout, updater, {
    removePath: (target, options) => {
      if (target.endsWith("ShipItState.plist")) {
        const error = new Error("simulated EACCES");
        error.code = "EACCES";
        throw error;
      }
      fs.rmSync(target, options);
    },
  });
  await controller.init();
  assert.equal(controller.getState().status, "manual-required");
  assert.equal(controller.getState().code, "legacy-cleanup-failed");
  assert.equal(fs.existsSync(path.join(stale.shipIt, "ShipItState.plist")), true);
  assert.equal((await controller.check()).code, "legacy-cleanup-failed");
  assert.equal(updater.checkCount, 0);
  assert.equal(updater.downloadCount, 0);
  controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function corruptInstallJournalFailsClosedAcrossRelaunch() {
  const layout = makeLayout();
  const updaterDirectory = path.join(layout.userDataPath, "updater");
  fs.mkdirSync(updaterDirectory, { recursive: true });
  fs.writeFileSync(path.join(updaterDirectory, "install-journal.v1.json"), "{not-json");
  const stale = seedStaleMacInstallState(layout);

  const firstUpdater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  const first = makeController(layout, firstUpdater);
  await first.controller.init();
  assert.equal(first.controller.getState().status, "manual-required");
  assert.equal(first.controller.getState().code, "install-state-corrupt");
  assert.equal((await first.controller.check()).code, "install-state-corrupt");
  assert.equal(firstUpdater.checkCount, 0, "corrupt install truth must pause automatic checks");
  assert.equal(fs.existsSync(path.join(stale.shipIt, "ShipItState.plist")), false);
  assert.equal(fs.existsSync(path.join(updaterDirectory, "install-journal-corrupt.v1.json")), true);
  first.controller.dispose();

  const secondUpdater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  fs.writeFileSync(path.join(updaterDirectory, "install-journal-corrupt.v1.json"), "{also-not-json");
  const second = makeController(layout, secondUpdater);
  await second.controller.init();
  assert.equal(second.controller.getState().code, "install-state-corrupt", "pause must survive relaunch");
  assert.equal(secondUpdater.checkCount, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(updaterDirectory, "install-journal-corrupt.v1.json"), "utf8")).detectedAppVersion,
    "0.7.28",
    "an invalid marker must be renewed so a later manual version change can release the hold",
  );
  second.controller.dispose();

  const manuallyReplaced = makeController(layout, new FakeUpdater(), { currentVersion: "0.7.29" });
  await manuallyReplaced.controller.init();
  assert.equal(manuallyReplaced.controller.getState().status, "idle", "a changed app version resolves the corrupt-version hold");
  assert.equal(fs.existsSync(path.join(updaterDirectory, "install-journal-corrupt.v1.json")), false);
  manuallyReplaced.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function semanticallyDamagedJournalFailsClosed() {
  const layout = makeLayout();
  const updaterDirectory = path.join(layout.userDataPath, "updater");
  fs.mkdirSync(updaterDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(updaterDirectory, "install-journal.v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      phase: "install-requested",
      sourceVersion: "0.7.28",
      targetVersion: "0.7.29",
      requestedAt: new Date(0).toISOString(),
      continuity: {
        schemaVersion: 1,
        userDataPath: layout.userDataPath,
        databasePath: path.join(layout.userDataPath, "agentlas.sqlite"),
        backupPath: path.join(updaterDirectory, "recovery", "agentlas.sqlite"),
        databaseSchemaVersion: 51,
        rowCounts: {},
      },
    }),
  );
  const updater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  const { controller } = makeController(layout, updater);
  await controller.init();
  assert.equal(controller.getState().code, "install-state-corrupt");
  assert.equal(updater.checkCount, 0);
  controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function continuityViolationSurfacesRecovery() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const first = makeController(layout, new FakeUpdater({ updateInfo }));
  await first.controller.init();
  await first.controller.check();
  await first.controller.install();
  const backupPath = first.continuity.snapshot().backupPath;
  first.controller.dispose();

  const failed = makeController(layout, new FakeUpdater(), {
    currentVersion: "0.7.29",
    verifyContinuity: async () => ({ ok: false, violations: ["agent-directory-missing:alpha"] }),
  });
  await failed.controller.init();
  assert.equal(failed.controller.getState().status, "recovery-required");
  assert.equal(failed.controller.getState().code, "continuity-violation");
  assert.equal(failed.controller.getState().recoveryBackupAvailable, true);
  assert.equal(failed.controller.revealRecoveryBackup().accepted, true);
  assert.deepEqual(failed.revealed, [backupPath]);
  assert.equal((await failed.controller.check()).status, "recovery-required", "recovery state must not be overwritten by checks");
  failed.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function compatibilityBoundariesFailBeforeDownload() {
  const cases = [
    { label: "missing metadata", info: { version: "0.7.29" }, options: {}, code: "compatibility-metadata-missing" },
    { label: "old app", info: { version: "0.7.29", agentlasCompatibility: compatibility }, options: { currentVersion: "0.6.9" }, code: "minimum-app-version" },
    { label: "old runtime", info: { version: "0.7.29", agentlasCompatibility: compatibility }, options: { runtimeVersion: "1.0.3" }, code: "minimum-runtime-version" },
    { label: "old schema", info: { version: "0.7.29", agentlasCompatibility: compatibility }, options: { databaseSchemaVersion: 34 }, code: "minimum-schema-version" },
    { label: "future schema", info: { version: "0.7.29", agentlasCompatibility: compatibility }, options: { databaseSchemaVersion: 52 }, code: "minimum-schema-version" },
  ];
  for (const testCase of cases) {
    const layout = makeLayout();
    const updater = new FakeUpdater({ updateInfo: testCase.info });
    const { controller, opened } = makeController(layout, updater, testCase.options);
    await controller.init();
    const state = await controller.check();
    assert.equal(state.status, "incompatible", testCase.label);
    assert.equal(state.code, testCase.code, testCase.label);
    assert.equal(updater.downloadCount, 0, `${testCase.label}: incompatible releases must not download`);
    if (testCase.code === "minimum-app-version" || testCase.code === "minimum-runtime-version") {
      assert.equal(state.manualDownloadUrl, "https://agentlas.cloud/desktop");
    } else {
      assert.equal(state.manualDownloadUrl, undefined, `${testCase.label}: unsafe same-release installer must not be offered`);
      assert.equal((await controller.openManualDownload()).accepted, false);
      assert.deepEqual(opened, [], `${testCase.label}: main must reject a renderer attempt to bypass the compatibility gate`);
    }
    controller.dispose();
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
}

async function continuityBackupFailureRemainsVisibleAndRetryable() {
  const layout = makeLayout();
  const updater = new FakeUpdater({ updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility } });
  const continuity = mockContinuity(layout);
  let captures = 0;
  const { controller } = makeController(layout, updater, {
    captureContinuity: async () => {
      captures += 1;
      if (captures === 1) throw new Error("disk temporarily unavailable");
      return continuity.capture();
    },
  });
  await controller.init();
  await controller.check();
  const failed = await controller.install();
  assert.equal(failed.accepted, false);
  assert.equal(failed.state.status, "manual-required");
  assert.equal(failed.state.code, "continuity-backup-failed");
  assert.equal(failed.state.canRetry, true);
  assert.equal(failed.state.manualDownloadUrl, undefined);
  assert.equal((await controller.install()).accepted, true, "explicit retry should re-run the safety backup");
  assert.equal(updater.installCount, 1);
  controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function transientFailuresAndConcurrencyPreserveTruth() {
  const failedLayout = makeLayout();
  fs.writeFileSync(path.join(failedLayout.userDataPath, "user-marker"), "keep-me");
  const failedUpdater = new FakeUpdater({
    updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility },
    downloadError: new Error("network details must not reach renderer"),
  });
  const failed = makeController(failedLayout, failedUpdater);
  await failed.controller.init();
  const failedState = await failed.controller.check();
  assert.equal(failedState.status, "error");
  assert.equal(failedState.code, "download-failed");
  assert.equal(failedState.canRetry, true);
  assert.doesNotMatch(failedState.error, /network details/);
  assert.equal(fs.readFileSync(path.join(failedLayout.userDataPath, "user-marker"), "utf8"), "keep-me");
  assert.equal(fs.readFileSync(failedLayout.execPath, "utf8"), "previous-app-binary");
  failed.controller.dispose();
  fs.rmSync(failedLayout.root, { recursive: true, force: true });

  const concurrentLayout = makeLayout();
  let releaseCheck;
  const gate = new Promise((resolve) => { releaseCheck = resolve; });
  const concurrentUpdater = new FakeUpdater({ checkGate: gate });
  const concurrent = makeController(concurrentLayout, concurrentUpdater);
  await concurrent.controller.init();
  const one = concurrent.controller.check();
  const two = concurrent.controller.check();
  assert.equal(one, two, "concurrent checks must share one promise");
  releaseCheck();
  assert.equal((await one).status, "not-available");
  assert.equal(concurrentUpdater.checkCount, 1);
  concurrent.controller.dispose();
  fs.rmSync(concurrentLayout.root, { recursive: true, force: true });

  const installLayout = makeLayout();
  const installUpdater = new FakeUpdater({
    updateInfo: { version: "0.7.29", agentlasCompatibility: compatibility },
  });
  const installContinuity = mockContinuity(installLayout);
  let captureCount = 0;
  let releaseCapture;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  const installing = makeController(installLayout, installUpdater, {
    captureContinuity: async () => {
      captureCount += 1;
      await captureGate;
      return installContinuity.capture();
    },
  });
  await installing.controller.init();
  await installing.controller.check();
  const installOne = installing.controller.install();
  const installTwo = installing.controller.install();
  assert.equal(installOne, installTwo, "concurrent install clicks must share one promise");
  releaseCapture();
  assert.equal((await installOne).accepted, true);
  assert.equal(captureCount, 1);
  assert.equal(installUpdater.installCount, 1, "quitAndInstall must run exactly once");
  installing.controller.dispose();
  fs.rmSync(installLayout.root, { recursive: true, force: true });
}

async function realSqliteContinuityBackupIsVerifiedAndSecretSafe() {
  const layout = makeLayout();
  const databasePath = path.join(layout.userDataPath, "agentlas.sqlite");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE installed_agents (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE firms (id TEXT PRIMARY KEY);
    CREATE TABLE hub_agent_bookmarks (slug TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE chats (id TEXT PRIMARY KEY);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE memory_entries (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    PRAGMA user_version = 51;
  `);
  db.prepare("INSERT INTO installed_agents (id, slug) VALUES (?, ?)").run("a1", "alpha");
  db.prepare("INSERT INTO firms (id) VALUES (?)").run("f1");
  db.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-alpha");
  db.prepare("INSERT INTO chat_messages (id, chat_id, text) VALUES (?, ?, ?)").run("m1", "c1", "keep this message");
  db.prepare("INSERT INTO memory_entries (id, content) VALUES (?, ?)").run("mem1", "keep this memory");
  db.prepare("INSERT INTO automations (id, name) VALUES (?, ?)").run("auto1", "keep this automation");
  db.close();
  fs.mkdirSync(path.join(layout.userDataPath, "agents", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(layout.userDataPath, "agents", "alpha", "AGENT.md"), "original-agent-asset");
  fs.mkdirSync(path.join(layout.userDataPath, "auth"), { recursive: true });
  fs.writeFileSync(path.join(layout.userDataPath, "auth", "session-cookie.v1.json"), "encrypted-secret");
  fs.writeFileSync(path.join(layout.userDataPath, "agent-routes.json"), "{}");

  const snapshot = await captureUpdaterContinuity({
    userDataPath: layout.userDataPath,
    databasePath,
    targetVersion: "0.7.29",
    accountSignedIn: true,
    accountExpiresAt: 1_900_000_000_000,
    now: () => 1_800_000_000_000,
  });
  assert.equal(snapshot.databaseSchemaVersion, 51);
  assert.equal(snapshot.rowCounts.installed_agents, 1);
  assert.equal(snapshot.rowCounts.chat_messages, 1);
  assert.equal(snapshot.rowCounts.memory_entries, 1);
  assert.equal(snapshot.rowCounts.automations, 1);
  assert.equal(snapshot.authCookiePresent, true);
  assert.equal(fs.existsSync(snapshot.backupPath), true);
  const recoveryFiles = fs.readdirSync(path.dirname(snapshot.backupPath)).sort();
  assert.deepEqual(
    recoveryFiles,
    ["agent-routes.json", "agentlas.sqlite", "agents", "continuity.json"],
    "recovery must contain SQLite, managed agent assets, and routes but never auth secrets",
  );
  assert.equal(
    (await verifyUpdaterContinuity({
      snapshot,
      currentUserDataPath: layout.userDataPath,
      currentDatabasePath: databasePath,
      currentAccountSignedIn: true,
      now: () => 1_800_000_000_001,
    })).ok,
    true,
  );
  const accountNotRestored = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: false,
    now: () => 1_800_000_000_001,
  });
  assert.equal(accountNotRestored.ok, false);
  assert.ok(accountNotRestored.violations.includes("account-session-not-restored"));
  fs.rmSync(path.join(layout.userDataPath, "auth", "session-cookie.v1.json"), { force: true });
  const expiredAccount = await verifyUpdaterContinuity({
    snapshot: { ...snapshot, accountExpiresAt: 1_700_000_000_000 },
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: false,
    now: () => 1_800_000_000_001,
  });
  assert.equal(
    expiredAccount.violations.some((entry) => entry.startsWith("account-session")),
    false,
    "natural session expiry must not be reported as updater data loss",
  );
  fs.writeFileSync(path.join(layout.userDataPath, "auth", "session-cookie.v1.json"), "encrypted-secret");

  const otherDatabasePath = path.join(layout.userDataPath, "other.sqlite");
  fs.copyFileSync(databasePath, otherDatabasePath);
  const wrongDatabase = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: otherDatabasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(wrongDatabase.violations.includes("database-path-changed"));

  const mutated = new Database(databasePath);
  mutated.prepare("DELETE FROM hub_agent_bookmarks WHERE slug = ?").run("hub-alpha");
  mutated.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-replaced");
  mutated.close();
  const identityChanged = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(identityChanged.violations.includes("table-identity-changed:hub_agent_bookmarks"));
  const restored = new Database(databasePath);
  restored.prepare("DELETE FROM hub_agent_bookmarks WHERE slug = ?").run("hub-replaced");
  restored.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-alpha");
  restored.close();

  const replacementWithGrowth = new Database(databasePath);
  replacementWithGrowth.prepare("DELETE FROM hub_agent_bookmarks WHERE slug = ?").run("hub-alpha");
  replacementWithGrowth.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-new-1");
  replacementWithGrowth.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-new-2");
  replacementWithGrowth.close();
  const missingOldIdentity = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    missingOldIdentity.violations.some((entry) => entry.startsWith("protected-row-missing:hub_agent_bookmarks:")),
    "new rows must not hide deletion of a pre-update identity",
  );
  const growthRestore = new Database(databasePath);
  growthRestore.prepare("DELETE FROM hub_agent_bookmarks").run();
  growthRestore.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-alpha");
  growthRestore.close();

  const contentMutation = new Database(databasePath);
  contentMutation.prepare("UPDATE chat_messages SET text = ? WHERE id = ?").run("silently replaced", "m1");
  contentMutation.close();
  const protectedContentChanged = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    protectedContentChanged.violations.some((entry) => entry.startsWith("protected-value-changed:chat_messages:text:")),
  );
  const contentRestore = new Database(databasePath);
  contentRestore.prepare("UPDATE chat_messages SET text = ? WHERE id = ?").run("keep this message", "m1");
  contentRestore.close();

  fs.writeFileSync(path.join(layout.userDataPath, "agents", "alpha", "AGENT.md"), "changed-agent-asset");
  const assetChanged = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(assetChanged.violations.includes("agent-asset-changed:alpha/AGENT.md"));
  fs.writeFileSync(path.join(layout.userDataPath, "agents", "alpha", "AGENT.md"), "original-agent-asset");

  fs.writeFileSync(path.join(layout.userDataPath, "agent-routes.json"), '{"changed":true}');
  const routeChanged = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(routeChanged.violations.includes("agent-routes-changed"));
  fs.writeFileSync(path.join(layout.userDataPath, "agent-routes.json"), "{}");
  fs.rmSync(path.join(layout.userDataPath, "agents", "alpha"), { recursive: true, force: true });
  const regressed = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.equal(regressed.ok, false);
  assert.ok(regressed.violations.includes("agent-directory-missing:alpha"));

  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const journal = {
    schemaVersion: 1,
    phase: "install-requested",
    sourceVersion: "0.7.28",
    targetVersion: "0.7.29",
    requestedAt: new Date(1_800_000_000_000).toISOString(),
    continuity: snapshot,
  };
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  const preflight = preflightUpdaterStartup(layout.userDataPath);
  assert.equal(preflight.pendingInstall, true);
  assert.equal(preflight.recoveryBackupAvailable, true);
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      ...journal,
      continuity: { ...snapshot, backupPath: path.join(path.dirname(snapshot.backupPath), "missing.sqlite") },
    }),
  );
  assert.throws(
    () => preflightUpdaterStartup(layout.userDataPath),
    /pre-migration safety gate/,
    "migration must not start when the journal recovery set is unavailable",
  );
  fs.rmSync(layout.root, { recursive: true, force: true });
}

(async () => {
  await rootOwnedBundleFailsClosed();
  await legacyOrphanShipItStateIsClearedBeforeFreshCheck();
  await undeletableLegacyStatePausesAutomaticUpdates();
  await corruptInstallJournalFailsClosedAcrossRelaunch();
  await semanticallyDamagedJournalFailsClosed();
  await installJournalStopsFailedApplyLoopAndReconcilesSuccess();
  await continuityViolationSurfacesRecovery();
  await compatibilityBoundariesFailBeforeDownload();
  await continuityBackupFailureRemainsVisibleAndRetryable();
  await transientFailuresAndConcurrencyPreserveTruth();
  await realSqliteContinuityBackupIsVerifiedAndSecretSafe();
  console.log("test-updater-production-contract: PASS (legacy-orphan, cleanup-fail-closed, root-owned, corrupt-journal, no-loop, protected-continuity, compatibility, concurrency)");
  clearTimeout(watchdog);
  app.quit();
  process.exit(0);
})().catch((error) => {
  clearTimeout(watchdog);
  console.error(error);
  app.quit();
  process.exit(1);
});
