// Agentlas Desktop production updater adapter.
//
// The state machine lives in updater/controller.ts so permission, compatibility,
// continuity, and retry behavior can be proven without launching or replacing a
// real app. This adapter binds it to Electron's app/window/shell APIs.
import { app, BrowserWindow, dialog, net, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { updaterCanUseOfficialInstaller } from "../shared/types";
import type { UpdaterActionResult, UpdaterState } from "../shared/types";
import { bootAuthFromKeychain, getAuthSession, type AuthRestoreResult } from "./auth";
import { quiesceAutomationSchedulerForUpdate } from "./automation-scheduler";
import { quiesceHubBookmarkSyncForUpdate } from "./hub-bookmark-sync";
import {
  DesktopUpdaterController,
  inspectInstallJournalFile,
  type ContinuitySnapshot,
} from "./updater/controller";
import {
  captureUpdaterContinuity,
  readBundledRuntimeVersion,
  readDatabaseSchemaVersion,
  verifyUpdaterContinuity,
  verifyUpdaterRecoveryCopies,
} from "./updater/continuity";
import {
  inspectMacInstalledAppTrust,
  repairMacInstalledAppGeneratedPythonCaches,
} from "./updater/mac-app-trust";
import { userDataDir, userDataPath } from "./runtime-paths";

// electron-updater is CommonJS in the main process bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

// electron-updater launches a renamed AppImage using a copy of the current
// environment. When the downloaded file has a versioned name, that copy can
// retain the old APPIMAGE path even after the updater has moved the payload.
// The AppImage runtime then waits on the stale executable instead of reaching
// Agentlas' post-install journal reconciliation. Advance the inherited path at
// the updater's filename-change boundary, before its detached spawn occurs.
if (process.platform === "linux") {
  autoUpdater.on("appimage-filename-updated", (destination: unknown) => {
    if (typeof destination !== "string" || !path.isAbsolute(destination)) {
      console.error("[updater] AppImage filename update returned an invalid launch path");
      return;
    }
    process.env.APPIMAGE = destination;
    // The verifier may have launched the baseline from an extracted APPDIR,
    // and a real AppImage runtime can likewise leave a mount/extraction
    // directory in the inherited environment. Once the payload is renamed,
    // that directory belongs to the old image. Remove it before the detached
    // target spawn so the new AppImage resolves its own APPDIR.
    delete process.env.APPDIR;
  });
}

let controller: DesktopUpdaterController | null = null;
let fallbackState: UpdaterState = { status: "idle" };
let startupRecovery: { targetVersion?: string; backupPath?: string } | null = null;
const stateListeners = new Set<(state: UpdaterState) => void>();
const OFFICIAL_DESKTOP_INSTALL_URL = "https://agentlas.cloud/desktop";
const OFFICIAL_DESKTOP_RELEASES_URL = "https://github.com/agentlas-ai/agentlas-desktop-releases/releases";
// The public release repository also carries Agentlas Science archives. GitHub's
// `/releases/latest` is therefore not a Desktop channel: whichever product was
// published last can win it. The Web release registry already selects the
// verified Desktop tag by its actual platform assets, so Desktop must resolve
// its feed through that registry before asking electron-updater to check.
const OFFICIAL_DESKTOP_RELEASE_METADATA_URL = "https://agentlas.cloud/api/desktop/latest";
const OFFICIAL_DESKTOP_RELEASE_REPOSITORY = "agentlas-ai/agentlas-desktop-releases";
const DESKTOP_RELEASE_METADATA_TIMEOUT_MS = 10_000;
const DESKTOP_RELEASE_METADATA_MAX_BYTES = 128 * 1024;

interface DesktopReleaseMetadataSnapshot {
  ready?: unknown;
  version?: unknown;
  releaseTag?: unknown;
}

function validatedDesktopReleaseTag(metadata: DesktopReleaseMetadataSnapshot | null): string | null {
  if (!metadata || metadata.ready !== true) return null;
  const version = typeof metadata.version === "string" ? metadata.version.trim() : "";
  const tag = typeof metadata.releaseTag === "string" ? metadata.releaseTag.trim() : "";
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) return null;
  return tag;
}

/** Read the canonical, verified Desktop release registry without GitHub's
 * cross-product `releases/latest` ambiguity. */
async function readDesktopReleaseMetadata(): Promise<DesktopReleaseMetadataSnapshot | null> {
  return new Promise<DesktopReleaseMetadataSnapshot | null>((resolve) => {
    let settled = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    const finish = (value: DesktopReleaseMetadataSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = net.request({
      method: "GET",
      url: OFFICIAL_DESKTOP_RELEASE_METADATA_URL,
      redirect: "follow",
    });
    const timer = setTimeout(() => {
      try { request.abort(); } catch { /* already finished */ }
      finish(null);
    }, DESKTOP_RELEASE_METADATA_TIMEOUT_MS);
    timer.unref?.();
    request.setHeader("Accept", "application/json");
    request.setHeader("User-Agent", "Agentlas-Desktop-update-check");
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.on("data", () => undefined);
        response.on("end", () => finish(null));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > DESKTOP_RELEASE_METADATA_MAX_BYTES) {
          try { request.abort(); } catch { /* already finished */ }
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DesktopReleaseMetadataSnapshot;
          finish(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
        } catch {
          finish(null);
        }
      });
      response.on("error", () => finish(null));
    });
    request.on("error", () => finish(null));
    try {
      request.end();
    } catch {
      finish(null);
    }
  });
}

/** Point electron-updater at the exact Desktop tag for this check. */
async function configureDesktopReleaseFeed(): Promise<void> {
  const metadata = await readDesktopReleaseMetadata();
  const tag = validatedDesktopReleaseTag(metadata);
  if (!tag) return;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `https://github.com/${OFFICIAL_DESKTOP_RELEASE_REPOSITORY}/releases/download/${tag}/`,
  });
}

let desktopFeedResolverInstalled = false;

/** Keep scheduled and manual checks on the product-specific feed. */
function installDesktopFeedResolver(): void {
  if (desktopFeedResolverInstalled) return;
  const nativeCheckForUpdates = autoUpdater.checkForUpdates.bind(autoUpdater);
  autoUpdater.checkForUpdates = async () => {
    await configureDesktopReleaseFeed();
    return nativeCheckForUpdates();
  };
  desktopFeedResolverInstalled = true;
}

function updateConfigPath(): string {
  return path.join(process.resourcesPath, "app-update.yml");
}

function hasBundledUpdateConfig(): boolean {
  try {
    return fs.existsSync(updateConfigPath());
  } catch {
    return false;
  }
}

/**
 * The version the update feed offers right now, or null when it cannot be read.
 *
 * Use the same canonical Desktop release registry that powers the public
 * download page. The GitHub repository intentionally contains both Desktop
 * and Science releases, so its generic `/releases/latest` endpoint cannot be
 * used as a product-specific pre-install guard.
 */
async function readOfferedVersion(): Promise<string | null> {
  const metadata = await readDesktopReleaseMetadata();
  const tag = validatedDesktopReleaseTag(metadata);
  return tag ? tag.slice(1) : null;
}

function broadcast(state: UpdaterState): void {
  fallbackState = state;
  for (const listener of stateListeners) {
    try {
      listener(state);
    } catch {
      // A lifecycle observer must never interfere with the updater authority.
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send("updater:state", state);
  }
}

function databasePath(): string {
  return process.env.AGENTLAS_STORE_PATH?.trim() || userDataPath("agentlas.sqlite");
}

function installJournalPath(userDataPath: string): string {
  return path.join(userDataPath, "updater", "install-journal.v1.json");
}

/**
 * Native updaters do not agree on a relaunch argument. NSIS can append one,
 * while AppImageUpdater launches the replacement with an empty argument list.
 * The durable updater state is therefore the cross-platform authority for a
 * relaunch that may need to wait for the old process to release its instance
 * lock. A corrupt marker counts too: that launch must reach the fail-closed
 * recovery UI instead of being mistaken for an ordinary second instance.
 */
export function hasUpdaterInstallRecoveryState(userDataPath = userDataDir()): boolean {
  if (process.env.NODE_ENV === "development" || process.env.AGENTLAS_QA_USER_DATA_DIR?.trim()) {
    return false;
  }
  const updaterDir = path.dirname(installJournalPath(userDataPath));
  return fs.existsSync(installJournalPath(userDataPath))
    || fs.existsSync(path.join(updaterDir, "install-journal-corrupt.v1.json"));
}

function persistCorruptJournalHold(userDataPath: string): void {
  const journal = installJournalPath(userDataPath);
  if (!fs.existsSync(journal)) return;
  const updaterDir = path.dirname(journal);
  const marker = path.join(updaterDir, "install-journal-corrupt.v1.json");
  const quarantine = `${journal}.corrupt-${Date.now()}`;
  const temporary = `${marker}.${process.pid}.tmp`;
  fs.mkdirSync(updaterDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({
      schemaVersion: 1,
      detectedAt: new Date().toISOString(),
      detectedAppVersion: app.getVersion(),
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    fs.renameSync(journal, quarantine);
    fs.renameSync(temporary, marker);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(journal) && fs.existsSync(quarantine)) fs.renameSync(quarantine, journal);
    throw error;
  }
}

export interface UpdaterStartupPreflight {
  pendingInstall: boolean;
  targetVersion?: string;
  recoveryBackupAvailable: boolean;
}

/**
 * Runs before initStore. It never opens the live DB: it only validates the
 * durable journal and already-captured recovery copies so a migration cannot
 * begin without a reachable fallback.
 */
export function preflightUpdaterStartup(userDataPath = userDataDir()): UpdaterStartupPreflight {
  if (process.env.NODE_ENV === "development" || process.env.AGENTLAS_QA_USER_DATA_DIR?.trim()) {
    return { pendingInstall: false, recoveryBackupAvailable: false };
  }
  const inspection = inspectInstallJournalFile(installJournalPath(userDataPath));
  if (inspection.status === "none") {
    startupRecovery = null;
    return { pendingInstall: false, recoveryBackupAvailable: false };
  }
  if (inspection.status === "corrupt") {
    persistCorruptJournalHold(userDataPath);
    startupRecovery = {};
    throw new Error("Updater install journal failed the pre-migration safety gate");
  }
  const snapshot: ContinuitySnapshot | undefined = inspection.journal.continuity;
  if (!snapshot) {
    // The install deliberately proceeded without a recovery copy. There is
    // nothing to verify, and refusing to boot over a missing convenience would
    // strand the user in exactly the way this gate was rewritten to avoid.
    startupRecovery = null;
    return { pendingInstall: true, targetVersion: inspection.journal.targetVersion, recoveryBackupAvailable: false };
  }
  startupRecovery = {
    targetVersion: inspection.journal.targetVersion,
    backupPath: snapshot.backupPath,
  };
  // The recovery copy is a convenience backup, not a precondition (owner
  // decision, 2026-08-03). Nothing compares it to anything: the post-install
  // continuity gate was already retired on 2026-07-26 after 10/10 of its
  // violations on a real machine turned out to be ordinary app activity —
  // Hub sync timestamps and a reseeded system prompt — while row counts and
  // the schema version matched. With no consumer left, verifying the copy here
  // could only do one thing: abandon a healthy pending install because a
  // convenience file was missing. Trust the local database, let the migration
  // transaction do the actual protecting, and report the copy's availability
  // instead of gating on it.
  const recoveryBackupAvailable = (() => {
    try {
      return fs.existsSync(snapshot.backupPath);
    } catch {
      return false;
    }
  })();
  return {
    pendingInstall: true,
    targetVersion: inspection.journal.targetVersion,
    recoveryBackupAvailable,
  };
}

/** Marks that this startup already attempted an automatic post-update repair. */
function bootRepairMarkerPath(userDataPath = userDataDir()): string {
  return path.join(userDataPath, "updater", "post-update-boot-repair.json");
}

/**
 * Recovers automatically when the first startup after an update fails.
 *
 * The previous behaviour showed a dialog asking the person to go find a
 * database copy, then quit — a dead end that left the app unusable and made a
 * transient failure look permanent. Startup can fail for reasons that have
 * nothing to do with data (a renderer asset that did not load, a half-written
 * pending payload), and all of those clear on their own.
 *
 * So: discard the pending-install bookkeeping and relaunch once. If the very
 * next boot fails the same way, stop relaunching — an unbounded loop is worse
 * than a plain exit — and let the normal startup error path report it.
 */
export async function handleUpdaterBootstrapFailure(error: unknown): Promise<boolean> {
  if (!startupRecovery) return false;
  console.error("[updater] guarded startup failed", error);
  const userDataPath = userDataDir();
  const marker = bootRepairMarkerPath(userDataPath);

  let alreadyRepaired = false;
  try {
    alreadyRepaired = fs.existsSync(marker);
  } catch {
    alreadyRepaired = false;
  }

  // Whatever the cause, a pending install must not be replayed into the same
  // failure on every launch. Drop it so the next boot starts clean and the
  // ordinary feed check can fetch the release again.
  try {
    persistCorruptJournalHold(userDataPath);
  } catch (cleanupError) {
    console.error("[updater] could not clear the pending install after a failed boot", cleanupError);
  }
  startupRecovery = null;

  if (alreadyRepaired) {
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      // A stale marker only costs one skipped auto-repair next time.
    }
    console.error("[updater] post-update startup failed twice; not relaunching again");
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 });
  } catch (markerError) {
    // Without the marker a second failure would relaunch again. Refuse to
    // relaunch at all rather than risk a boot loop.
    console.error("[updater] could not arm the post-update repair marker; skipping relaunch", markerError);
    return false;
  }

  console.error("[updater] post-update startup failed; clearing the pending install and relaunching once");
  app.relaunch();
  return true;
}

/** Clears the one-shot marker once the app has actually reached a healthy start. */
export function noteHealthyStartup(userDataPath = userDataDir()): void {
  try {
    fs.rmSync(bootRepairMarkerPath(userDataPath), { force: true });
  } catch {
    // Best effort; a leftover marker only suppresses one future auto-repair.
  }
}

export function getUpdaterState(): UpdaterState {
  return controller?.getState() ?? fallbackState;
}

/** Main-process lifecycle observer for native handoff failures after install(). */
export function onUpdaterStateChange(listener: (state: UpdaterState) => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export interface AutoUpdaterInitOptions {
  initialAuthRestore?: AuthRestoreResult;
  onDeferredAuthRestore?: () => void;
}

/** Called only after initStore() and auth restoration have completed. */
export async function initAutoUpdater(options: AutoUpdaterInitOptions = {}): Promise<void> {
  if (process.env.NODE_ENV === "development") {
    console.log("[updater] dev mode — skipping auto-update");
    return;
  }
  if (process.env.AGENTLAS_QA_USER_DATA_DIR?.trim()) {
    console.log("[updater] QA mode — skipping auto-update");
    return;
  }
  installDesktopFeedResolver();
  const hasUpdateConfig = hasBundledUpdateConfig();
  if (!hasUpdateConfig) console.warn(`[updater] app-update.yml missing — automatic checks are disabled (${updateConfigPath()})`);
  const dispatchDeferredAuthRestore = () => {
    if (!controller || !options.onDeferredAuthRestore) return;
    const state = controller.getState().status;
    const controllerRequested = controller.hasDeferredSessionRestoreRequest();
    const initialRestoreWasTemporary =
      options.initialAuthRestore?.status === "temporarily-unavailable";
    // A controller request came from a verified journal and is safe to dispatch
    // only after that journal was deleted. Initial-only temporary auth also
    // covers ordinary startup where no continuity journal exists.
    if (controllerRequested && state !== "updated") return;
    if (!controllerRequested && !initialRestoreWasTemporary) return;
    // Controller-owned retries can restore the account while reconciling. In
    // that case no deferred loop is needed, but leave the request intact: only
    // the successful scheduling path below is allowed to consume it.
    if (getAuthSession().signedIn) return;
    try {
      options.onDeferredAuthRestore();
      // Never consume a journal request merely because init returned. It stays
      // durable in the controller until the main-process retry was scheduled.
      if (controllerRequested) controller.consumeDeferredSessionRestoreRequest();
    } catch (error) {
      // Auth UI reconciliation is best-effort and happens only after the
      // authoritative journal transaction has completed.
      console.warn("[updater] deferred account-session restore scheduling failed", error);
    }
  };
  if (controller) {
    await controller.init();
    dispatchDeferredAuthRestore();
    return;
  }

  const userDataPath = userDataDir();
  const dbPath = databasePath();
  const sourceRoot = path.resolve(__dirname, "../..");
  controller = new DesktopUpdaterController({
    updater: autoUpdater,
    currentVersion: () => app.getVersion(),
    platform: process.platform,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    userDataPath,
    homePath: app.getPath("home"),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    runtimeVersion: () => readBundledRuntimeVersion(process.resourcesPath, sourceRoot),
    offeredVersion: readOfferedVersion,
    databaseSchemaVersion: () => readDatabaseSchemaVersion(dbPath),
    inspectInstalledAppTrust: (bundlePath) => inspectMacInstalledAppTrust({
      bundlePath,
      policyPath: path.join(process.resourcesPath, "macos-release-signing-policy.json"),
    }),
    repairInstalledAppTrust: (bundlePath, diagnostic) => repairMacInstalledAppGeneratedPythonCaches({
      bundlePath,
      diagnostic,
    }),
    quiesceWriters: async () => {
      // Set both gates immediately, then wait for their current writes to
      // settle before continuity copies/hash counts are captured.
      const hubResumePromise = quiesceHubBookmarkSyncForUpdate();
      let automationResume: (() => void) | undefined;
      try {
        automationResume = await quiesceAutomationSchedulerForUpdate();
        const hubResume = await hubResumePromise;
        return () => {
          hubResume();
          automationResume?.();
        };
      } catch (error) {
        try {
          const hubResume = await hubResumePromise;
          hubResume();
        } catch {
          // The original quiescence error remains authoritative.
        }
        automationResume?.();
        throw error;
      }
    },
    captureContinuity: (targetVersion) => {
      const account = getAuthSession();
      return captureUpdaterContinuity({
        userDataPath,
        databasePath: dbPath,
        targetVersion,
        accountSignedIn: account.signedIn,
        ...(account.expiresAt !== undefined ? { accountExpiresAt: account.expiresAt } : {}),
      });
    },
    verifyContinuity: (snapshot) =>
      verifyUpdaterContinuity({
        snapshot,
        currentUserDataPath: userDataPath,
        currentDatabasePath: dbPath,
        currentAccountSignedIn: getAuthSession().signedIn,
      }),
    initialSessionRestore: options.initialAuthRestore,
    refreshSessionForRecovery: bootAuthFromKeychain,
    releaseInstanceLockForInstall: () => {
      if (app.hasSingleInstanceLock()) app.releaseSingleInstanceLock();
    },
    reacquireInstanceLockAfterInstallFailure: () => app.requestSingleInstanceLock(),
    broadcast,
    revealPath: (filePath) => shell.showItemInFolder(filePath),
    schedule: hasUpdateConfig,
  });
  await controller.init();
  dispatchDeferredAuthRestore();
  // The native fallback now repairs and relaunches on its own, so nothing
  // created. All other authoritative states have closed the preflight window.
  startupRecovery = null;
  if (!hasUpdateConfig && controller.getState().status === "idle") {
    broadcast({
      status: "error",
      code: "config-missing",
      error: "This build has no verified update channel. The installed app was left unchanged.",
      canRetry: false,
    });
  }
}

export function disposeAutoUpdater(): void {
  controller?.dispose();
  controller = null;
}

/** Subscribe to the native updater instance that actually performs installs. */
/** Manual and scheduled checks share one in-flight promise and return main-authoritative state. */
export async function checkSafely(): Promise<UpdaterState> {
  if (!controller) {
    if (!hasBundledUpdateConfig()) {
      broadcast({
        status: "error",
        code: "config-missing",
        error: "This build has no verified update channel. The installed app was left unchanged.",
        canRetry: false,
      });
    }
    return fallbackState;
  }
  return controller.check();
}

/** The controller creates a verified SQLite recovery copy before this can quit the app. */
export async function quitAndInstall(): Promise<UpdaterActionResult> {
  if (!controller) return { accepted: false, state: fallbackState };
  return controller.install();
}

export async function openManualDownload(): Promise<UpdaterActionResult> {
  const state = controller?.getState() ?? fallbackState;
  // 허용 여부는 shared/types.ts 의 updaterCanUseOfficialInstaller 한 곳에서 온다 —
  // 화면과 여기가 손으로 유지되는 두 벌이면 반드시 갈린다.
  const canUseOfficialInstaller = updaterCanUseOfficialInstaller(state);
  if (!canUseOfficialInstaller) {
    return { accepted: false, state };
  }
  try {
    await shell.openExternal(OFFICIAL_DESKTOP_INSTALL_URL);
    return { accepted: true, state };
  } catch {
    return { accepted: false, state };
  }
}

/** Open the public, read-only release record without changing updater state. */
export async function openReleaseNotes(version?: string): Promise<UpdaterActionResult> {
  const state = controller?.getState() ?? fallbackState;
  const safeVersion = typeof version === "string" && /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
  const url = safeVersion
    ? `${OFFICIAL_DESKTOP_RELEASES_URL}/tag/v${encodeURIComponent(safeVersion)}`
    : OFFICIAL_DESKTOP_RELEASES_URL;
  try {
    await shell.openExternal(url);
    return { accepted: true, state };
  } catch {
    return { accepted: false, state };
  }
}

export async function revealRecoveryBackup(): Promise<UpdaterActionResult> {
  if (!controller) return { accepted: false, state: fallbackState };
  return controller.revealRecoveryBackup();
}
