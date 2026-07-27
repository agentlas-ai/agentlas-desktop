// Agentlas Desktop production updater adapter.
//
// The state machine lives in updater/controller.ts so permission, compatibility,
// continuity, and retry behavior can be proven without launching or replacing a
// real app. This adapter binds it to Electron's app/window/shell APIs.
import { app, BrowserWindow, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
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

// electron-updater is CommonJS in the main process bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

let controller: DesktopUpdaterController | null = null;
let fallbackState: UpdaterState = { status: "idle" };
let startupRecovery: { targetVersion?: string; backupPath?: string } | null = null;
const stateListeners = new Set<(state: UpdaterState) => void>();

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
  return process.env.AGENTLAS_STORE_PATH?.trim() || path.join(app.getPath("userData"), "agentlas.sqlite");
}

function installJournalPath(userDataPath: string): string {
  return path.join(userDataPath, "updater", "install-journal.v1.json");
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
export function preflightUpdaterStartup(userDataPath = app.getPath("userData")): UpdaterStartupPreflight {
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
  const snapshot: ContinuitySnapshot = inspection.journal.continuity;
  startupRecovery = {
    targetVersion: inspection.journal.targetVersion,
    backupPath: snapshot.backupPath,
  };
  const recovery = verifyUpdaterRecoveryCopies({ snapshot, currentUserDataPath: userDataPath });
  if (!recovery.ok) {
    // 이 게이트의 계약은 "폴백 없이 마이그레이션 금지"이지 "폴백 없이 부팅 금지"가
    // 아니다. 던지면 저널은 남고 복구 사본은 여전히 없으므로 다음 실행도, 그 다음도
    // 같은 자리에서 죽는다 — 파일을 손으로 지우기 전엔 앱이 열리지 않는다. 실제로
    // 실패한 네이티브 설치는 blocked 저널을 무기한 남기고, 앱 자신이
    // shell.showItemInFolder로 사용자를 그 폴더에 보내므로 사본이 사라지는 경로는
    // 평범하다. 대기 중인 설치를 포기하고 부팅을 계속하는 쪽이 엄격히 더 안전하다:
    // 마이그레이션은 시작되지 않고, 사용자는 앱을 되찾는다.
    console.error(
      `[updater] pre-migration recovery copies unusable (${recovery.violations.join(", ") || "unknown"}); ` +
        "abandoning the pending install and continuing startup",
    );
    persistCorruptJournalHold(userDataPath);
    startupRecovery = null;
    return { pendingInstall: false, recoveryBackupAvailable: false };
  }
  return {
    pendingInstall: true,
    targetVersion: inspection.journal.targetVersion,
    recoveryBackupAvailable: true,
  };
}

/** Native fallback used when migration/bootstrap fails before renderer recovery UI exists. */
export async function handleUpdaterBootstrapFailure(error: unknown): Promise<boolean> {
  if (!startupRecovery) return false;
  console.error("[updater] guarded startup failed", error);
  const backupAvailable = Boolean(startupRecovery.backupPath && fs.existsSync(startupRecovery.backupPath));
  fallbackState = {
    status: "recovery-required",
    version: startupRecovery.targetVersion,
    code: "continuity-violation",
    error: "Agentlas stopped before background work because post-update local state could not be verified.",
    canRetry: false,
    recoveryBackupAvailable: backupAvailable,
  };
  const korean = app.getLocale().toLowerCase().startsWith("ko");
  const buttons = backupAvailable
    ? [korean ? "복구본 보기" : "Show recovery copy", korean ? "종료" : "Quit"]
    : [korean ? "종료" : "Quit"];
  const result = await dialog.showMessageBox({
    type: "error",
    title: korean ? "업데이트 복구가 필요합니다" : "Update recovery required",
    message: korean
      ? "업데이트 후 로컬 상태를 확인하기 전에 시작을 중단했습니다. 보존된 복구본은 앱 안에서 확인할 수 있습니다."
      : "Startup stopped before post-update local state could be verified. The preserved recovery copy remains available in the app.",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (backupAvailable && result.response === 0 && startupRecovery.backupPath) {
    shell.showItemInFolder(startupRecovery.backupPath);
  }
  return true;
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
  const hasUpdateConfig = hasBundledUpdateConfig();
  if (!hasUpdateConfig) console.warn(`[updater] app-update.yml missing — automatic checks are disabled (${updateConfigPath()})`);
  const dispatchDeferredAuthRestore = () => {
    if (!controller || !options.onDeferredAuthRestore) return;
    const state = controller.getState().status;
    if (state === "recovery-required") return;
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

  const userDataPath = app.getPath("userData");
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
    broadcast,
    revealPath: (filePath) => shell.showItemInFolder(filePath),
    schedule: hasUpdateConfig,
  });
  await controller.init();
  dispatchDeferredAuthRestore();
  // Keep the native fallback armed until a recovery-required renderer can be
  // created. All other authoritative states have closed the preflight window.
  if (controller.getState().status !== "recovery-required") startupRecovery = null;
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
  if (!controller) return { accepted: false, state: fallbackState };
  return controller.openManualDownload();
}

export async function revealRecoveryBackup(): Promise<UpdaterActionResult> {
  if (!controller) return { accepted: false, state: fallbackState };
  return controller.revealRecoveryBackup();
}
