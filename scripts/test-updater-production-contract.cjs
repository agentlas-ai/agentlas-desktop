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
  CONTINUITY_V1_TABLES,
  DesktopUpdaterController,
  inspectInstallJournalFile,
} = require("../dist/electron/updater/controller.js");
const {
  captureUpdaterContinuity,
  verifyUpdaterContinuity,
} = require("../dist/electron/updater/continuity.js");
const { preflightUpdaterStartup } = require("../dist/electron/updater.js");

for (const requiredOntologyContinuityTable of ["run_events", "failure_events", "installed_agent_hub_bindings", "taste_draft_candidates", "taste_chip_workflows"]) {
  assert.ok(
    CONTINUITY_CORE_TABLES.includes(requiredOntologyContinuityTable),
    `${requiredOntologyContinuityTable} must be protected by updater continuity`,
  );
}

const compatibility = {
  minimumSourceAppVersion: "0.7.0",
  minimumRuntimeVersion: "1.0.4",
  minimumSchemaVersion: 35,
  targetSchemaVersion: 53,
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
    this.installArgs = [];
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

  quitAndInstall(isSilent, isForceRunAfter) {
    this.installCount += 1;
    this.installArgs.push([isSilent, isForceRunAfter]);
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
      schemaVersion: 2,
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

function snapshotForSchema(snapshot, schemaVersion, tables) {
  return {
    ...snapshot,
    schemaVersion,
    rowCounts: Object.fromEntries(tables.map((table) => [table, snapshot.rowCounts[table]])),
    tableIdentityHashes: Object.fromEntries(tables.map((table) => [table, snapshot.tableIdentityHashes[table]])),
  };
}

function installJournal(snapshot) {
  return {
    schemaVersion: 1,
    phase: "install-requested",
    sourceVersion: "0.7.28",
    targetVersion: "0.7.29",
    requestedAt: new Date(1_800_000_000_000).toISOString(),
    continuity: snapshot,
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
    quiesceWriters: options.quiesceWriters,
    captureContinuity: options.captureContinuity || continuity.capture,
    verifyContinuity: options.verifyContinuity || (async () => ({ ok: true, violations: [] })),
    broadcast: (state) => states.push(structuredClone(state)),
    openExternal: async (url) => opened.push(url),
    revealPath: (filePath) => revealed.push(filePath),
    schedule: false,
    now: options.now || (() => 1_800_000_000_000),
    removePath: options.removePath,
    recoverySessionRetryDelayMs: options.recoverySessionRetryDelayMs,
    recoverySessionRetryAttempts: options.recoverySessionRetryAttempts,
    waitForRecoveryRetry: options.waitForRecoveryRetry,
    refreshSessionForRecovery: options.refreshSessionForRecovery,
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

  const markerPath = path.join(layout.userDataPath, "updater", "install-journal-corrupt.v1.json");
  fs.writeFileSync(markerPath, "stale-marker");
  const journalClearOrder = [];
  const relaunched = makeController(layout, new FakeUpdater(), {
    currentVersion: "0.7.29",
    removePath: (target, options) => {
      if (target === markerPath || target === journalPath) journalClearOrder.push(target);
      fs.rmSync(target, options);
    },
  });
  await relaunched.controller.init();
  assert.equal(relaunched.controller.getState().status, "updated");
  assert.deepEqual(
    journalClearOrder,
    [markerPath, journalPath],
    "the marker must clear before the authoritative journal so a crash leaves re-verifiable truth",
  );
  assert.equal(fs.existsSync(journalPath), false, "verified relaunch clears the install intent");
  assert.equal(fs.existsSync(backupPath), true, "verified recovery copy remains available after success");
  relaunched.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function verifiedContinuityFailsClosedWhenJournalCannotBeDeleted() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const first = makeController(layout, new FakeUpdater({ updateInfo }));
  await first.controller.init();
  await first.controller.check();
  await first.controller.install();
  first.controller.dispose();

  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  const updater = new FakeUpdater();
  const failedCleanup = makeController(layout, updater, {
    currentVersion: "0.7.29",
    removePath: (target, options) => {
      if (target === journalPath) {
        const error = new Error("simulated EACCES");
        error.code = "EACCES";
        throw error;
      }
      fs.rmSync(target, options);
    },
  });
  await failedCleanup.controller.init();
  assert.equal(failedCleanup.controller.getState().status, "manual-required");
  assert.equal(failedCleanup.controller.getState().code, "install-state-corrupt");
  assert.equal(fs.existsSync(journalPath), true, "failed unlink must preserve the journal for the next safe startup");
  assert.equal((await failedCleanup.controller.check()).code, "install-state-corrupt");
  assert.equal(updater.checkCount, 0, "journal cleanup failure must pause every automatic update check");
  failedCleanup.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function installQuiescesWritersBeforeContinuityCapture() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const order = [];
  const updater = new FakeUpdater({ updateInfo });
  const continuity = mockContinuity(layout);
  const successful = makeController(layout, updater, {
    quiesceWriters: async () => {
      order.push("quiesce");
      return () => order.push("resume");
    },
    captureContinuity: async () => {
      order.push("capture");
      return continuity.capture();
    },
  });
  await successful.controller.init();
  await successful.controller.check();
  assert.equal((await successful.controller.install()).accepted, true);
  assert.deepEqual(order, ["quiesce", "capture"], "successful install must remain frozen after capture until app replacement");
  successful.controller.dispose();

  fs.rmSync(path.join(layout.userDataPath, "updater"), { recursive: true, force: true });
  const failedOrder = [];
  const failedUpdater = new FakeUpdater({ updateInfo });
  const failed = makeController(layout, failedUpdater, {
    quiesceWriters: async () => {
      failedOrder.push("quiesce");
      return () => failedOrder.push("resume");
    },
    captureContinuity: async () => {
      failedOrder.push("capture");
      throw new Error("synthetic backup failure");
    },
  });
  await failed.controller.init();
  await failed.controller.check();
  assert.equal((await failed.controller.install()).accepted, false);
  assert.deepEqual(failedOrder, ["quiesce", "capture", "resume"], "cancelled install must resume frozen writers");
  assert.equal(failedUpdater.installCount, 0);
  failed.controller.dispose();
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

async function snapshotTableSetsTolerateProtectionListGrowth() {
  const layout = makeLayout();
  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const currentSnapshot = mockContinuity(layout).snapshot();
  const legacySnapshot = snapshotForSchema(currentSnapshot, 1, CONTINUITY_V1_TABLES);

  fs.writeFileSync(journalPath, JSON.stringify(installJournal(legacySnapshot)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "valid",
    "a shipped v1 journal with the exact legacy table set must remain readable after table expansion",
  );

  const missingLegacyTable = structuredClone(legacySnapshot);
  delete missingLegacyTable.rowCounts.installed_agents;
  delete missingLegacyTable.tableIdentityHashes.installed_agents;
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(missingLegacyTable)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "corrupt",
    "v1 must not accept an arbitrary subset of its fixed protection set",
  );

  const expandedButDowngraded = structuredClone(legacySnapshot);
  expandedButDowngraded.rowCounts.run_events = currentSnapshot.rowCounts.run_events;
  expandedButDowngraded.tableIdentityHashes.run_events = currentSnapshot.tableIdentityHashes.run_events;
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(expandedButDowngraded)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "corrupt",
    "a v2 protection map must not masquerade as schemaVersion 1",
  );

  // v0.8.32 incident regression: v2 journals are written by the PREVIOUS app
  // version, so a snapshot protecting fewer tables than today's list is a
  // healthy journal, not a corrupt one. Treating it as corrupt quarantined the
  // journal and permanently paused auto-update on every machine that crossed
  // a release which grew CONTINUITY_CORE_TABLES.
  const olderReleaseSnapshot = structuredClone(currentSnapshot);
  delete olderReleaseSnapshot.rowCounts.experience_governance_relations;
  delete olderReleaseSnapshot.tableIdentityHashes.experience_governance_relations;
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(olderReleaseSnapshot)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "valid",
    "a v2 journal written before a table was added to CONTINUITY_CORE_TABLES must stay readable",
  );

  const smallerOlderSnapshot = structuredClone(currentSnapshot);
  delete smallerOlderSnapshot.rowCounts.run_events;
  delete smallerOlderSnapshot.tableIdentityHashes.run_events;
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(smallerOlderSnapshot)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "valid",
    "v2 accepts any self-consistent protected-table set from an older release",
  );

  const newerReleaseSnapshot = structuredClone(currentSnapshot);
  newerReleaseSnapshot.rowCounts.future_protected_table = 3;
  newerReleaseSnapshot.tableIdentityHashes.future_protected_table = "b".repeat(64);
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(newerReleaseSnapshot)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "valid",
    "a v2 journal written by a newer release with extra protected tables must stay readable",
  );

  const inconsistentMaps = structuredClone(currentSnapshot);
  delete inconsistentMaps.tableIdentityHashes.run_events;
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(inconsistentMaps)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "corrupt",
    "v2 must fail closed when rowCounts and tableIdentityHashes disagree on the table set",
  );

  const emptyMaps = structuredClone(currentSnapshot);
  emptyMaps.rowCounts = {};
  emptyMaps.tableIdentityHashes = {};
  fs.writeFileSync(journalPath, JSON.stringify(installJournal(emptyMaps)));
  assert.equal(
    inspectInstallJournalFile(journalPath).status,
    "corrupt",
    "v2 must fail closed on an empty protection map",
  );

  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function transientAccountRestoreReconcilesOnceAndClearsOnlyAfterFullSuccess() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const first = makeController(layout, new FakeUpdater({ updateInfo }));
  await first.controller.init();
  await first.controller.check();
  await first.controller.install();
  first.controller.dispose();

  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  let accountRestored = false;
  let verificationCalls = 0;
  let retryWaitCalls = 0;
  let refreshCalls = 0;
  let releaseRetryWait;
  let markRetryWaitStarted;
  const retryWaitGate = new Promise((resolve) => { releaseRetryWait = resolve; });
  const retryWaitStarted = new Promise((resolve) => { markRetryWaitStarted = resolve; });
  const updater = new FakeUpdater();
  const relaunched = makeController(layout, updater, {
    currentVersion: "0.7.29",
    verifyContinuity: async () => {
      verificationCalls += 1;
      return accountRestored
        ? { ok: true, violations: [] }
        : { ok: false, violations: ["account-session-not-restored"] };
    },
    waitForRecoveryRetry: async () => {
      retryWaitCalls += 1;
      markRetryWaitStarted();
      await retryWaitGate;
    },
    refreshSessionForRecovery: async () => {
      refreshCalls += 1;
      accountRestored = true;
    },
  });
  const firstInit = relaunched.controller.init();
  const duplicateInit = relaunched.controller.init();
  assert.equal(firstInit, duplicateInit, "concurrent init callers must share the same continuity safety gate");
  let duplicateInitSettled = false;
  void duplicateInit.then(() => { duplicateInitSettled = true; });
  await retryWaitStarted;
  await Promise.resolve();
  assert.equal(duplicateInitSettled, false, "no init caller may resolve before startup reconciliation finishes");
  assert.equal(verificationCalls, 1);
  assert.equal(retryWaitCalls, 1, "concurrent initialization must not start duplicate reconciliation waits");
  assert.equal(fs.existsSync(journalPath), true, "an in-flight verification must not clear durable recovery truth");
  releaseRetryWait();

  await Promise.all([firstInit, duplicateInit]);
  assert.equal(duplicateInitSettled, true);
  assert.equal(relaunched.controller.getState().status, "updated");
  assert.equal(verificationCalls, 2, "the bounded auth-settle path must run exactly one full retry before success");
  assert.equal(refreshCalls, 1, "the retry must re-read the durable auth session before full verification");
  assert.equal(fs.existsSync(journalPath), false, "the journal clears only after every continuity check succeeds");
  assert.equal(updater.checkCount, 0, "startup reconciliation must not contact the update feed");
  relaunched.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });
}

async function realViolationSurvivesAccountRestoreAndEveryRetry() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const first = makeController(layout, new FakeUpdater({ updateInfo }));
  await first.controller.init();
  await first.controller.check();
  await first.controller.install();
  first.controller.dispose();

  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  let verificationCalls = 0;
  let retryWaitCalls = 0;
  const updater = new FakeUpdater();
  const relaunched = makeController(layout, updater, {
    currentVersion: "0.7.29",
    verifyContinuity: async () => {
      verificationCalls += 1;
      return {
        ok: false,
        violations: ["account-session-not-restored", "row-count-regressed:installed_agents"],
      };
    },
    waitForRecoveryRetry: async () => { retryWaitCalls += 1; },
  });
  await relaunched.controller.init();
  assert.equal(relaunched.controller.getState().status, "recovery-required");
  assert.equal(fs.existsSync(journalPath), true);
  const retried = await relaunched.controller.check();
  assert.equal(retried.status, "recovery-required", "runtime checks must not unlock a partially bootstrapped app");
  assert.equal(verificationCalls, 1, "a real violation alongside auth delay must bypass the transient retry path");
  assert.equal(retryWaitCalls, 0);
  assert.equal(fs.existsSync(journalPath), true, "a real continuity violation must never delete the journal");
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).phase, "recovery-required");
  assert.equal(updater.checkCount, 0);
  relaunched.controller.dispose();
  fs.rmSync(layout.root, { recursive: true, force: true });

  const emergedLayout = makeLayout();
  const emergedFirst = makeController(emergedLayout, new FakeUpdater({ updateInfo }));
  await emergedFirst.controller.init();
  await emergedFirst.controller.check();
  await emergedFirst.controller.install();
  emergedFirst.controller.dispose();
  const emergedJournalPath = path.join(emergedLayout.userDataPath, "updater", "install-journal.v1.json");
  let emergedCalls = 0;
  const emergedViolation = makeController(emergedLayout, new FakeUpdater(), {
    currentVersion: "0.7.29",
    verifyContinuity: async () => {
      emergedCalls += 1;
      return emergedCalls === 1
        ? { ok: false, violations: ["account-session-not-restored"] }
        : { ok: false, violations: ["row-count-regressed:installed_agents"] };
    },
    waitForRecoveryRetry: async () => {},
  });
  await emergedViolation.controller.init();
  assert.equal(emergedCalls, 2, "the auth retry must re-run the complete continuity verifier");
  assert.equal(emergedViolation.controller.getState().status, "recovery-required");
  assert.equal(fs.existsSync(emergedJournalPath), true, "a real violation discovered on retry must preserve the journal");
  emergedViolation.controller.dispose();
  fs.rmSync(emergedLayout.root, { recursive: true, force: true });
}

async function accountRestoreRetryIsStrictlyBounded() {
  const layout = makeLayout();
  const updateInfo = { version: "0.7.29", agentlasCompatibility: compatibility };
  const first = makeController(layout, new FakeUpdater({ updateInfo }));
  await first.controller.init();
  await first.controller.check();
  await first.controller.install();
  first.controller.dispose();

  let verificationCalls = 0;
  let refreshCalls = 0;
  const journalPath = path.join(layout.userDataPath, "updater", "install-journal.v1.json");
  const unresolved = makeController(layout, new FakeUpdater(), {
    currentVersion: "0.7.29",
    verifyContinuity: async () => {
      verificationCalls += 1;
      return { ok: false, violations: ["account-session-not-restored"] };
    },
    recoverySessionRetryAttempts: 2,
    waitForRecoveryRetry: async () => {},
    refreshSessionForRecovery: async () => { refreshCalls += 1; },
  });
  await unresolved.controller.init();
  assert.equal(verificationCalls, 3, "two bounded retries mean one initial verification plus exactly two retries");
  assert.equal(refreshCalls, 2);
  assert.equal(unresolved.controller.getState().status, "recovery-required");
  assert.equal(fs.existsSync(journalPath), true, "an exhausted auth retry must retain the durable journal");
  unresolved.controller.dispose();
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
    { label: "future schema", info: { version: "0.7.29", agentlasCompatibility: compatibility }, options: { databaseSchemaVersion: 54 }, code: "minimum-schema-version" },
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
  assert.deepEqual(
    installUpdater.installArgs,
    [[true, true]],
    "Windows updates must install silently and relaunch Agentlas",
  );
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
    CREATE TABLE run_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE failure_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, error_code TEXT NOT NULL);
    CREATE TABLE installed_agent_hub_bindings (
      installed_agent_id TEXT PRIMARY KEY,
      agent_definition_id TEXT NOT NULL,
      agent_release_id TEXT NOT NULL,
      source TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );
    CREATE TABLE taste_draft_candidates (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_memory_id TEXT NOT NULL,
      source_memory_hash TEXT NOT NULL,
      base_package_hash TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT,
      started_at TEXT,
      status TEXT,
      node_states_json TEXT
    );
    PRAGMA user_version = 51;
  `);
  db.prepare("INSERT INTO installed_agents (id, slug) VALUES (?, ?)").run("a1", "alpha");
  db.prepare("INSERT INTO firms (id) VALUES (?)").run("f1");
  db.prepare("INSERT INTO hub_agent_bookmarks (slug) VALUES (?)").run("hub-alpha");
  db.prepare("INSERT INTO chat_messages (id, chat_id, text) VALUES (?, ?, ?)").run("m1", "c1", "keep this message");
  db.prepare("INSERT INTO memory_entries (id, content) VALUES (?, ?)").run("mem1", "keep this memory");
  db.prepare("INSERT INTO run_events (id, run_id, kind) VALUES (?, ?, ?)").run("run-event-1", "run-1", "invoke_completed");
  db.prepare("INSERT INTO failure_events (id, run_id, error_code) VALUES (?, ?, ?)").run("failure-event-1", "run-1", "runtime_failed");
  db.prepare(
    "INSERT INTO installed_agent_hub_bindings (installed_agent_id, agent_definition_id, agent_release_id, source, bound_at) VALUES (?, ?, ?, ?, ?)",
  ).run("a1", "agd_exact_1", "agr_exact_1", "hub-install", "2026-07-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO taste_draft_candidates (id, agent_id, source_memory_id, source_memory_hash, base_package_hash, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("taste-draft-1", "a1", "mem1", "a".repeat(64), "b".repeat(64), "observation");
  db.prepare("INSERT INTO automations (id, name) VALUES (?, ?)").run("auto1", "keep this automation");
  const insertAutomationRun = db.prepare(
    "INSERT INTO automation_runs (id, automation_id, started_at, status, node_states_json) VALUES (?, ?, ?, ?, ?)",
  );
  insertAutomationRun.run(
    "automation-run-orphan",
    "deleted-parent",
    "2026-07-01T00:00:00.000Z",
    "running",
    JSON.stringify({ trigger: "done", worker: "running" }),
  );
  insertAutomationRun.run(
    "automation-run-recovered",
    "auto1",
    "2026-07-01T00:00:00.000Z",
    "running",
    JSON.stringify({ trigger: "done", worker: "running" }),
  );
  insertAutomationRun.run(
    "automation-run-terminal",
    "auto1",
    "2026-07-01T00:00:00.000Z",
    "ok",
    JSON.stringify({ trigger: "done", worker: "done" }),
  );
  const freshRunStartedAt = new Date(1_800_000_000_000 - 60_000).toISOString();
  insertAutomationRun.run(
    "automation-run-fresh",
    "auto1",
    freshRunStartedAt,
    "running",
    JSON.stringify({ trigger: "done", worker: "running" }),
  );
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
  assert.equal(snapshot.schemaVersion, 2, "new recovery captures must use the complete v2 protection profile");
  assert.equal(snapshot.databaseSchemaVersion, 51);
  assert.equal(snapshot.rowCounts.installed_agents, 1);
  assert.equal(snapshot.rowCounts.chat_messages, 1);
  assert.equal(snapshot.rowCounts.memory_entries, 1);
  assert.equal(snapshot.rowCounts.run_events, 1);
  assert.equal(snapshot.rowCounts.failure_events, 1);
  assert.equal(snapshot.rowCounts.installed_agent_hub_bindings, 1);
  assert.equal(snapshot.rowCounts.taste_draft_candidates, 1);
  assert.equal(snapshot.rowCounts.automations, 1);
  assert.equal(snapshot.rowCounts.automation_runs, 4);
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
  const legacySnapshot = snapshotForSchema(snapshot, 1, CONTINUITY_V1_TABLES);
  const legacyVerification = await verifyUpdaterContinuity({
    snapshot: legacySnapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.equal(
    legacyVerification.ok,
    true,
    `the fixed v1 protection profile must remain verifiable: ${legacyVerification.violations.join(", ")}`,
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

  const migratedAutomationRuns = new Database(databasePath);
  migratedAutomationRuns.prepare("DELETE FROM automation_runs WHERE id = ?").run("automation-run-orphan");
  migratedAutomationRuns.prepare(
    "UPDATE automation_runs SET status = 'error', node_states_json = ? WHERE id = ?",
  ).run(JSON.stringify({ trigger: "done", worker: "failed" }), "automation-run-recovered");
  migratedAutomationRuns.pragma("user_version = 52");
  migratedAutomationRuns.close();
  const approvedAutomationRunMigration = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.equal(
    approvedAutomationRunMigration.ok,
    true,
    `v52 orphan/recovery migration must pass continuity: ${approvedAutomationRunMigration.violations.join(", ")}`,
  );

  const illegallyRecoveredFreshRun = new Database(databasePath);
  illegallyRecoveredFreshRun.prepare(
    "UPDATE automation_runs SET status = 'error', node_states_json = ? WHERE id = ?",
  ).run(JSON.stringify({ trigger: "done", worker: "failed" }), "automation-run-fresh");
  illegallyRecoveredFreshRun.close();
  const freshRecoveryViolation = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    freshRecoveryViolation.violations.some((entry) =>
      entry.startsWith("protected-value-changed:automation_runs:status:")
    ),
    "v52 continuity allowance must reject running→error for a fresh active run",
  );
  const restoreFreshRun = new Database(databasePath);
  restoreFreshRun.prepare(
    "UPDATE automation_runs SET status = 'running', node_states_json = ? WHERE id = ?",
  ).run(JSON.stringify({ trigger: "done", worker: "running" }), "automation-run-fresh");
  restoreFreshRun.close();

  const illegalAutomationRunDelete = new Database(databasePath);
  illegalAutomationRunDelete.prepare("DELETE FROM automation_runs WHERE id = ?").run("automation-run-terminal");
  illegalAutomationRunDelete.close();
  const missingProtectedAutomationRun = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    missingProtectedAutomationRun.violations.some((entry) => entry.startsWith("protected-row-missing:automation_runs:")),
    "v52 allowance must not hide deletion of a terminal/live-parent snapshot",
  );
  const restoreProtectedAutomationRun = new Database(databasePath);
  restoreProtectedAutomationRun.prepare(
    "INSERT INTO automation_runs (id, automation_id, started_at, status, node_states_json) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "automation-run-terminal",
    "auto1",
    "2026-07-01T00:00:00.000Z",
    "ok",
    JSON.stringify({ trigger: "done", worker: "done" }),
  );
  restoreProtectedAutomationRun.close();

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

  const lostOntologyIdentity = new Database(databasePath);
  lostOntologyIdentity.prepare("DELETE FROM installed_agent_hub_bindings WHERE installed_agent_id = ?").run("a1");
  lostOntologyIdentity.close();
  const ontologyIdentityViolation = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    ontologyIdentityViolation.violations.some((entry) => entry.startsWith("row-count-regressed:installed_agent_hub_bindings")),
    "an update must fail continuity when an exact Hub ontology binding disappears",
  );
  const restoreOntologyIdentity = new Database(databasePath);
  restoreOntologyIdentity.prepare(
    "INSERT INTO installed_agent_hub_bindings (installed_agent_id, agent_definition_id, agent_release_id, source, bound_at) VALUES (?, ?, ?, ?, ?)",
  ).run("a1", "agd_exact_1", "agr_exact_1", "hub-install", "2026-07-01T00:00:00.000Z");
  restoreOntologyIdentity.close();

  const lostTasteDraft = new Database(databasePath);
  lostTasteDraft.prepare("DELETE FROM taste_draft_candidates WHERE id = ?").run("taste-draft-1");
  lostTasteDraft.close();
  const tasteDraftViolation = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    tasteDraftViolation.violations.some((entry) => entry.startsWith("row-count-regressed:taste_draft_candidates")),
    "an update must fail continuity when a private per-agent Taste draft disappears",
  );
  const restoreTasteDraft = new Database(databasePath);
  restoreTasteDraft.prepare(
    "INSERT INTO taste_draft_candidates (id, agent_id, source_memory_id, source_memory_hash, base_package_hash, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("taste-draft-1", "a1", "mem1", "a".repeat(64), "b".repeat(64), "observation");
  restoreTasteDraft.close();

  const lostLearningLedger = new Database(databasePath);
  lostLearningLedger.prepare("DELETE FROM run_events WHERE id = ?").run("run-event-1");
  lostLearningLedger.close();
  const learningLedgerViolation = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: true,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    learningLedgerViolation.violations.some((entry) => entry.startsWith("row-count-regressed:run_events")),
    "an update must fail continuity when the per-agent activity ledger disappears",
  );
  const restoreLearningLedger = new Database(databasePath);
  restoreLearningLedger.prepare("INSERT INTO run_events (id, run_id, kind) VALUES (?, ?, ?)")
    .run("run-event-1", "run-1", "invoke_completed");
  restoreLearningLedger.close();

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

async function v53HubBookmarkKeyMigrationIsNarrowlyApproved() {
  const layout = makeLayout();
  const databasePath = path.join(layout.userDataPath, "agentlas.sqlite");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE hub_agent_bookmarks (
      slug TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL DEFAULT 'agent',
      listing_json TEXT NOT NULL,
      bookmarked_at TEXT NOT NULL
    );
    INSERT INTO hub_agent_bookmarks (slug, entity_kind, listing_json, bookmarked_at)
    VALUES ('hub-alpha', 'team', '{"slug":"hub-alpha","entityKind":"team"}', '2026-07-01T00:00:00.000Z');
    PRAGMA user_version = 52;
  `);
  db.close();

  const snapshot = await captureUpdaterContinuity({
    userDataPath: layout.userDataPath,
    databasePath,
    targetVersion: "0.7.34",
    accountSignedIn: false,
    now: () => 1_800_000_000_000,
  });

  const migrated = new Database(databasePath);
  migrated.transaction(() => {
    migrated.exec(`
      ALTER TABLE hub_agent_bookmarks RENAME TO hub_agent_bookmarks_v52;
      CREATE TABLE hub_agent_bookmarks (
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        listing_json TEXT NOT NULL,
        bookmarked_at TEXT NOT NULL,
        server_updated_at TEXT,
        sync_state TEXT NOT NULL,
        last_sync_error TEXT,
        claim_workspace_id TEXT,
        PRIMARY KEY(workspace_id, entity_kind, slug)
      );
      INSERT INTO hub_agent_bookmarks (
        workspace_id, slug, entity_kind, listing_json, bookmarked_at,
        server_updated_at, sync_state, last_sync_error, claim_workspace_id
      )
      SELECT '__device__', slug, entity_kind, listing_json, bookmarked_at,
             NULL, 'clean', NULL, NULL
      FROM hub_agent_bookmarks_v52;
      DROP TABLE hub_agent_bookmarks_v52;
      PRAGMA user_version = 53;
    `);
  })();
  migrated.close();

  const approved = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: false,
    now: () => 1_800_000_000_001,
  });
  assert.equal(
    approved.ok,
    true,
    `v53 device/composite-key migration must pass continuity: ${approved.violations.join(", ")}`,
  );

  const pendingDeleteMutation = new Database(databasePath);
  pendingDeleteMutation.prepare("UPDATE hub_agent_bookmarks SET sync_state = 'pending_delete' WHERE slug = ?").run("hub-alpha");
  pendingDeleteMutation.close();
  const unsafeNewField = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: false,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    unsafeNewField.violations.some((entry) =>
      entry.startsWith("protected-value-changed:hub_agent_bookmarks:sync_state:")
    ),
    "v53 allowance must reject a migration that turns a preserved bookmark into a delete outbox row",
  );
  const restoreCleanBookmark = new Database(databasePath);
  restoreCleanBookmark.prepare("UPDATE hub_agent_bookmarks SET sync_state = 'clean' WHERE slug = ?").run("hub-alpha");
  restoreCleanBookmark.close();

  const changed = new Database(databasePath);
  changed.prepare("UPDATE hub_agent_bookmarks SET listing_json = ? WHERE slug = ?").run('{"slug":"replaced"}', "hub-alpha");
  changed.close();
  const protectedValueChanged = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: false,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    protectedValueChanged.violations.some((entry) => entry.startsWith("protected-value-changed:hub_agent_bookmarks:listing_json:")),
    "v53 allowance must not hide bookmark payload mutation",
  );

  const moved = new Database(databasePath);
  moved.prepare("UPDATE hub_agent_bookmarks SET listing_json = ?, workspace_id = ? WHERE slug = ?")
    .run('{"slug":"hub-alpha","entityKind":"team"}', "other-workspace", "hub-alpha");
  moved.close();
  const missingDeviceIdentity = await verifyUpdaterContinuity({
    snapshot,
    currentUserDataPath: layout.userDataPath,
    currentDatabasePath: databasePath,
    currentAccountSignedIn: false,
    now: () => 1_800_000_000_001,
  });
  assert.ok(
    missingDeviceIdentity.violations.some((entry) => entry.startsWith("protected-row-missing:hub_agent_bookmarks:")),
    "v53 allowance must require the exact preserved device-scope identity",
  );
  fs.rmSync(layout.root, { recursive: true, force: true });
}

(async () => {
  await rootOwnedBundleFailsClosed();
  await legacyOrphanShipItStateIsClearedBeforeFreshCheck();
  await undeletableLegacyStatePausesAutomaticUpdates();
  await corruptInstallJournalFailsClosedAcrossRelaunch();
  await semanticallyDamagedJournalFailsClosed();
  await snapshotTableSetsTolerateProtectionListGrowth();
  await installJournalStopsFailedApplyLoopAndReconcilesSuccess();
  await verifiedContinuityFailsClosedWhenJournalCannotBeDeleted();
  await installQuiescesWritersBeforeContinuityCapture();
  await transientAccountRestoreReconcilesOnceAndClearsOnlyAfterFullSuccess();
  await realViolationSurvivesAccountRestoreAndEveryRetry();
  await accountRestoreRetryIsStrictlyBounded();
  await continuityViolationSurfacesRecovery();
  await compatibilityBoundariesFailBeforeDownload();
  await continuityBackupFailureRemainsVisibleAndRetryable();
  await transientFailuresAndConcurrencyPreserveTruth();
  await realSqliteContinuityBackupIsVerifiedAndSecretSafe();
  await v53HubBookmarkKeyMigrationIsNarrowlyApproved();
  console.log("test-updater-production-contract: PASS (legacy-orphan, cleanup-fail-closed, root-owned, corrupt-journal, no-loop, protected-continuity, compatibility, concurrency)");
  clearTimeout(watchdog);
  app.exit(0);
})().catch((error) => {
  clearTimeout(watchdog);
  console.error(error);
  app.exit(1);
});
