// Agentlas Desktop production updater adapter.
//
// The state machine lives in updater/controller.ts so permission, compatibility,
// continuity, and retry behavior can be proven without launching or replacing a
// real app. This adapter binds it to Electron's app/window/shell APIs.
import { app, BrowserWindow, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { UpdaterActionResult, UpdaterState } from "../shared/types";
import { getAuthSession } from "./auth";
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

// electron-updater is CommonJS in the main process bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

let controller: DesktopUpdaterController | null = null;
let fallbackState: UpdaterState = { status: "idle" };
let startupRecovery: { targetVersion?: string; backupPath?: string } | null = null;

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
  if (!recovery.ok) throw new Error("Updater recovery copies failed the pre-migration safety gate");
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
    ? [korean ? "복구본 보기" : "Show recovery copy", korean ? "공식 설치 파일" : "Official installer", korean ? "종료" : "Quit"]
    : [korean ? "공식 설치 파일" : "Official installer", korean ? "종료" : "Quit"];
  const result = await dialog.showMessageBox({
    type: "error",
    title: korean ? "업데이트 복구가 필요합니다" : "Update recovery required",
    message: korean
      ? "업데이트 후 로컬 상태를 확인하기 전에 시작을 중단했습니다. 기존 복구본이나 공식 설치 파일을 사용하세요."
      : "Startup stopped before post-update local state could be verified. Use the preserved recovery copy or official installer.",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (backupAvailable && result.response === 0 && startupRecovery.backupPath) {
    shell.showItemInFolder(startupRecovery.backupPath);
  } else if ((!backupAvailable && result.response === 0) || (backupAvailable && result.response === 1)) {
    await shell.openExternal("https://agentlas.cloud/desktop");
  }
  return true;
}

export function getUpdaterState(): UpdaterState {
  return controller?.getState() ?? fallbackState;
}

/** Called only after initStore() and auth restoration have completed. */
export async function initAutoUpdater(): Promise<void> {
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
  if (controller) return;

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
    broadcast,
    openExternal: (url) => shell.openExternal(url),
    revealPath: (filePath) => shell.showItemInFolder(filePath),
    schedule: hasUpdateConfig,
  });
  await controller.init();
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
