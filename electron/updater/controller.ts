import fs from "node:fs";
import path from "node:path";
import { compareSemVer, parseSemVer } from "../../shared/semver";
import type {
  UpdaterActionResult,
  UpdaterCompatibility,
  UpdaterErrorCode,
  UpdaterState,
} from "../../shared/types";

const JOURNAL_SCHEMA_VERSION = 1;
const OFFICIAL_DOWNLOAD_URL = "https://agentlas.cloud/desktop";

export const CONTINUITY_CORE_TABLES = [
  "installed_agents",
  "firms",
  "hub_agent_bookmarks",
  "agent_groups",
  "projects",
  "chats",
  "chat_messages",
  "memory_entries",
  "automations",
  "automation_runs",
  "agent_evolution_proposals",
  "agent_evolution_receipts",
  "agent_asset_versions",
  "agent_apps",
  "agent_tools",
  "agent_surfaces",
  "mcp_servers",
  "agent_mcp_servers",
  "agent_runtime_overrides",
] as const;

type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface UpdateInfoLike {
  version?: string;
  agentlasCompatibility?: unknown;
}

export interface UpdateCheckResultLike {
  isUpdateAvailable?: boolean;
  updateInfo?: UpdateInfoLike;
}

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: UpdaterEvent, listener: (...args: any[]) => void): unknown;
  removeListener?(event: UpdaterEvent, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface ContinuitySnapshot {
  schemaVersion: 1;
  userDataPath: string;
  databasePath: string;
  backupPath: string;
  databaseSchemaVersion: number;
  rowCounts: Record<string, number>;
  tableIdentityHashes: Record<string, string>;
  agentDirectoryNames: string[];
  agentAssetHashes: Record<string, string>;
  agentsBackupPath: string;
  authCookiePresent: boolean;
  accountSignedIn: boolean;
  accountExpiresAt?: number;
  routeFilePresent: boolean;
  routeFileHash: string | null;
  routeBackupPath: string | null;
  capturedAt: string;
}

export interface ContinuityVerification {
  ok: boolean;
  violations: string[];
}

export interface InstallJournal {
  schemaVersion: 1;
  phase: "install-requested" | "blocked" | "recovery-required";
  sourceVersion: string;
  targetVersion: string;
  requestedAt: string;
  reasonCode?: UpdaterErrorCode;
  continuity: ContinuitySnapshot;
}

export type InstallJournalInspection =
  | { status: "none" }
  | { status: "valid"; journal: InstallJournal }
  | { status: "corrupt" };

interface CorruptJournalMarker {
  schemaVersion: 1;
  detectedAt: string;
  detectedAppVersion: string;
}

export interface UpdaterControllerDependencies {
  updater: AutoUpdaterLike;
  currentVersion: () => string;
  platform: NodeJS.Platform | string;
  execPath: string;
  resourcesPath: string;
  userDataPath: string;
  homePath: string;
  uid: number | null;
  runtimeVersion: () => string | null;
  databaseSchemaVersion: () => number | null;
  /** Stop mutable background writers and resolve only after their current work drains. */
  quiesceWriters?: () => Promise<void | (() => void)>;
  captureContinuity: (targetVersion: string) => Promise<ContinuitySnapshot>;
  verifyContinuity: (snapshot: ContinuitySnapshot) => Promise<ContinuityVerification>;
  broadcast: (state: UpdaterState) => void;
  openExternal: (url: string) => Promise<void>;
  revealPath: (filePath: string) => void;
  logger?: Pick<Console, "log" | "warn" | "error">;
  now?: () => number;
  initialDelayMs?: number;
  checkIntervalMs?: number;
  schedule?: boolean;
  manualDownloadUrl?: string;
  removePath?: (target: string, options: { recursive?: boolean; force?: boolean }) => void;
}

interface InstallAccessResult {
  ok: boolean;
  bundlePath: string | null;
  reason?: string;
}

const terminalStates = new Set<UpdaterState["status"]>([
  "downloaded",
  "installing",
  "recovery-required",
]);

const updaterErrorCodes = new Set<UpdaterErrorCode>([
  "config-missing",
  "check-failed",
  "download-failed",
  "install-not-owned",
  "install-not-applied",
  "install-state-corrupt",
  "legacy-cleanup-failed",
  "install-start-failed",
  "continuity-backup-failed",
  "continuity-violation",
  "compatibility-metadata-missing",
  "minimum-app-version",
  "minimum-runtime-version",
  "minimum-schema-version",
]);

function safeMessage(code: UpdaterErrorCode): string {
  switch (code) {
    case "config-missing":
      return "This build has no verified update channel. The installed app was left unchanged.";
    case "check-failed":
      return "The update server could not be reached. The installed app was left unchanged.";
    case "download-failed":
      return "The update could not be downloaded. The installed app was left unchanged.";
    case "install-not-owned":
      return "Automatic install is disabled because this app is owned by another macOS account. Use the official installer once; your local Agentlas data stays in place.";
    case "install-not-applied":
      return "The previous update was not applied, so Agentlas will not repeat the same install. The existing app and local data were preserved.";
    case "install-state-corrupt":
      return "The previous update state could not be verified. Automatic install is paused and the existing app and local data were left unchanged; use the official installer.";
    case "legacy-cleanup-failed":
      return "A previous macOS update instruction could not be removed. Automatic updates are paused to prevent another install loop.";
    case "install-start-failed":
      return "The update could not start safely. The existing app and local data were preserved; use the official installer.";
    case "continuity-backup-failed":
      return "Agentlas could not create the local-state recovery copy, so the update was not applied.";
    case "continuity-violation":
      return "Some local Agentlas state could not be verified after the update. Use the recovery copy if available; otherwise use the official installer.";
    case "compatibility-metadata-missing":
      return "This release does not declare the required Agentlas compatibility boundary. Automatic install was not attempted.";
    case "minimum-app-version":
      return "This release needs a newer Agentlas base app. Use the official installer; local data will stay in the same user folder.";
    case "minimum-runtime-version":
      return "This release is not compatible with the installed Agentlas runtime. Use the official installer to replace both together.";
    case "minimum-schema-version":
      return "This release cannot safely migrate the installed Agentlas data schema. Do not install the same release manually; use a supported bridge version or recovery guidance.";
  }
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseUpdaterCompatibility(value: unknown): UpdaterCompatibility | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const minimumSourceAppVersion = typeof raw.minimumSourceAppVersion === "string" ? raw.minimumSourceAppVersion : "";
  const minimumRuntimeVersion = typeof raw.minimumRuntimeVersion === "string" ? raw.minimumRuntimeVersion : "";
  const bundledRuntimeVersion = typeof raw.bundledRuntimeVersion === "string" ? raw.bundledRuntimeVersion : "";
  const minimumSchemaVersion = asNonNegativeInteger(raw.minimumSchemaVersion);
  const targetSchemaVersion = asNonNegativeInteger(raw.targetSchemaVersion);
  if (
    !parseSemVer(minimumSourceAppVersion) ||
    !parseSemVer(minimumRuntimeVersion) ||
    !parseSemVer(bundledRuntimeVersion) ||
    minimumSchemaVersion === null ||
    targetSchemaVersion === null ||
    targetSchemaVersion < minimumSchemaVersion ||
    (compareSemVer(bundledRuntimeVersion, minimumRuntimeVersion) ?? -1) < 0
  ) {
    return null;
  }
  return {
    minimumSourceAppVersion,
    minimumRuntimeVersion,
    minimumSchemaVersion,
    targetSchemaVersion,
    bundledRuntimeVersion,
  };
}

export function resolveMacAppBundle(execPath: string): string | null {
  const normalized = path.resolve(execPath);
  const parts = normalized.split(path.sep);
  const appIndex = parts.findIndex((part) => part.toLowerCase().endsWith(".app"));
  if (appIndex < 0) return null;
  return parts.slice(0, appIndex + 1).join(path.sep) || path.sep;
}

export function evaluateInstallAccess(input: {
  platform: string;
  execPath: string;
  uid: number | null;
}): InstallAccessResult {
  if (input.platform !== "darwin") return { ok: true, bundlePath: null };
  const bundlePath = resolveMacAppBundle(input.execPath);
  if (!bundlePath) return { ok: false, bundlePath: null, reason: "not-running-from-app-bundle" };
  try {
    const bundleStat = fs.statSync(bundlePath);
    const executableStat = fs.statSync(input.execPath);
    if (input.uid !== null && (bundleStat.uid !== input.uid || executableStat.uid !== input.uid)) {
      return { ok: false, bundlePath, reason: "bundle-owner-mismatch" };
    }
    fs.accessSync(bundlePath, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundlePath), fs.constants.W_OK);
    return { ok: true, bundlePath };
  } catch {
    return { ok: false, bundlePath, reason: "bundle-not-replaceable" };
  }
}

function isValidContinuitySnapshot(value: unknown): value is ContinuitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const rowCounts = raw.rowCounts as Record<string, unknown> | null;
  const tableIdentityHashes = raw.tableIdentityHashes as Record<string, unknown> | null;
  const agentAssetHashes = raw.agentAssetHashes as Record<string, unknown> | null;
  return (
    raw.schemaVersion === 1 &&
    typeof raw.userDataPath === "string" &&
    path.isAbsolute(raw.userDataPath) &&
    typeof raw.databasePath === "string" &&
    path.isAbsolute(raw.databasePath) &&
    typeof raw.backupPath === "string" &&
    path.isAbsolute(raw.backupPath) &&
    asNonNegativeInteger(raw.databaseSchemaVersion) !== null &&
    rowCounts !== null &&
    typeof rowCounts === "object" &&
    !Array.isArray(rowCounts) &&
    CONTINUITY_CORE_TABLES.every((table) => asNonNegativeInteger(rowCounts[table]) !== null) &&
    tableIdentityHashes !== null &&
    typeof tableIdentityHashes === "object" &&
    !Array.isArray(tableIdentityHashes) &&
    CONTINUITY_CORE_TABLES.every(
      (table) => typeof tableIdentityHashes[table] === "string" && /^[a-f0-9]{64}$/.test(tableIdentityHashes[table] as string),
    ) &&
    Array.isArray(raw.agentDirectoryNames) &&
    raw.agentDirectoryNames.every((entry) => typeof entry === "string") &&
    agentAssetHashes !== null &&
    typeof agentAssetHashes === "object" &&
    !Array.isArray(agentAssetHashes) &&
    Object.entries(agentAssetHashes).every(
      ([key, hash]) => key.length > 0 && typeof hash === "string" && /^(?:file|symlink):[a-f0-9]{64}$/.test(hash),
    ) &&
    typeof raw.agentsBackupPath === "string" &&
    path.isAbsolute(raw.agentsBackupPath) &&
    typeof raw.authCookiePresent === "boolean" &&
    typeof raw.accountSignedIn === "boolean" &&
    (raw.accountExpiresAt === undefined || asNonNegativeInteger(raw.accountExpiresAt) !== null) &&
    typeof raw.routeFilePresent === "boolean" &&
    (raw.routeFileHash === null || (typeof raw.routeFileHash === "string" && /^[a-f0-9]{64}$/.test(raw.routeFileHash))) &&
    (raw.routeBackupPath === null || (typeof raw.routeBackupPath === "string" && path.isAbsolute(raw.routeBackupPath))) &&
    (raw.routeFilePresent
      ? typeof raw.routeFileHash === "string" && typeof raw.routeBackupPath === "string"
      : raw.routeFileHash === null && raw.routeBackupPath === null) &&
    typeof raw.capturedAt === "string" &&
    Number.isFinite(Date.parse(raw.capturedAt))
  );
}

function isValidJournal(value: unknown): value is InstallJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    (raw.phase === "install-requested" || raw.phase === "blocked" || raw.phase === "recovery-required") &&
    typeof raw.sourceVersion === "string" &&
    Boolean(parseSemVer(raw.sourceVersion)) &&
    typeof raw.targetVersion === "string" &&
    Boolean(parseSemVer(raw.targetVersion)) &&
    typeof raw.requestedAt === "string" &&
    Number.isFinite(Date.parse(raw.requestedAt)) &&
    (raw.reasonCode === undefined || (typeof raw.reasonCode === "string" && updaterErrorCodes.has(raw.reasonCode as UpdaterErrorCode))) &&
    isValidContinuitySnapshot(raw.continuity)
  );
}

export function inspectInstallJournalFile(file: string): InstallJournalInspection {
  if (!fs.existsSync(file)) return { status: "none" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isValidJournal(parsed) ? { status: "valid", journal: parsed } : { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ACLs inherit the userData boundary rather than POSIX modes.
    }
    try {
      const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Some platforms do not permit directory fsync; atomic rename still applies.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function mergeCheckedAt(state: UpdaterState, checkedAt: number | undefined): UpdaterState {
  return checkedAt ? { ...state, lastCheckedAt: checkedAt } : state;
}

export class DesktopUpdaterController {
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly now: () => number;
  private readonly manualDownloadUrl: string;
  private readonly removePath: (target: string, options: { recursive?: boolean; force?: boolean }) => void;
  private state: UpdaterState = { status: "idle" };
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private checkPromise: Promise<UpdaterState> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private availablePromise: Promise<void> | null = null;
  private installPromise: Promise<UpdaterActionResult> | null = null;
  private availableVersion: string | null = null;
  private blockedTargetVersion: string | null = null;
  private blockedReasonCode: UpdaterErrorCode = "install-not-applied";
  private recoveryBackupPath: string | null = null;
  private automaticInstallPaused = false;
  private lastCheckedAt: number | undefined;
  private initialized = false;
  private readonly listeners: Array<{ event: UpdaterEvent; listener: (...args: any[]) => void }> = [];

  constructor(private readonly deps: UpdaterControllerDependencies) {
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? Date.now;
    this.manualDownloadUrl = deps.manualDownloadUrl ?? OFFICIAL_DOWNLOAD_URL;
    this.removePath = deps.removePath ?? ((target, options) => fs.rmSync(target, options));
  }

  getState(): UpdaterState {
    return this.state;
  }

  private publish(next: UpdaterState): UpdaterState {
    this.state = mergeCheckedAt(next, this.lastCheckedAt);
    this.deps.broadcast(this.state);
    return this.state;
  }

  private listen(event: UpdaterEvent, listener: (...args: any[]) => void): void {
    this.listeners.push({ event, listener });
    this.deps.updater.on(event, listener);
  }

  private journalPath(): string {
    return path.join(this.deps.userDataPath, "updater", "install-journal.v1.json");
  }

  private corruptJournalMarkerPath(): string {
    return path.join(this.deps.userDataPath, "updater", "install-journal-corrupt.v1.json");
  }

  private updaterCachePath(): string {
    return path.join(this.deps.homePath, "Library", "Caches", "agentlas-desktop-updater");
  }

  private shipItPath(): string {
    return path.join(this.deps.homePath, "Library", "Caches", "com.agentlas.desktop.ShipIt");
  }

  private readJournal(): InstallJournal | null {
    const file = this.journalPath();
    if (!fs.existsSync(file)) {
      const markerFile = this.corruptJournalMarkerPath();
      if (!fs.existsSync(markerFile)) return null;
      try {
        const marker = JSON.parse(fs.readFileSync(markerFile, "utf8")) as Partial<CorruptJournalMarker>;
        const detectedVersion = typeof marker.detectedAppVersion === "string" ? marker.detectedAppVersion : null;
        const currentVersion = this.deps.currentVersion();
        const markerValid =
          marker.schemaVersion === 1 &&
          Boolean(detectedVersion && parseSemVer(detectedVersion)) &&
          Boolean(parseSemVer(currentVersion));
        if (markerValid && compareSemVer(currentVersion, detectedVersion!) !== 0) {
          fs.rmSync(markerFile, { force: true });
          return null;
        }
        if (markerValid) {
          this.automaticInstallPaused = true;
          return null;
        }
      } catch (error) {
        this.logger.warn("[updater] corrupt journal marker could not be read", error);
      }
      try {
        const quarantine = `${markerFile}.corrupt-${this.now()}`;
        fs.renameSync(markerFile, quarantine);
        try {
          writeJsonAtomic(markerFile, {
            schemaVersion: 1,
            detectedAt: new Date(this.now()).toISOString(),
            detectedAppVersion: this.deps.currentVersion(),
          } satisfies CorruptJournalMarker);
        } catch (error) {
          fs.renameSync(quarantine, markerFile);
          throw error;
        }
      } catch (error) {
        this.logger.warn("[updater] corrupt journal marker could not be renewed", error);
      }
      this.automaticInstallPaused = true;
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isValidJournal(parsed)) throw new Error("invalid updater journal");
      return parsed;
    } catch (error) {
      const quarantine = `${file}.corrupt-${this.now()}`;
      try {
        writeJsonAtomic(this.corruptJournalMarkerPath(), {
          schemaVersion: 1,
          detectedAt: new Date(this.now()).toISOString(),
          detectedAppVersion: this.deps.currentVersion(),
        } satisfies CorruptJournalMarker);
        fs.renameSync(file, quarantine);
      } catch {
        // Keep the corrupt file in place if the durable marker/quarantine cannot be created.
      }
      this.automaticInstallPaused = true;
      this.logger.warn("[updater] install journal could not be read", error);
      return null;
    }
  }

  private writeJournal(journal: InstallJournal): void {
    writeJsonAtomic(this.journalPath(), journal);
  }

  private clearJournal(): void {
    try {
      fs.rmSync(this.journalPath(), { force: true });
      fs.rmSync(this.corruptJournalMarkerPath(), { force: true });
    } catch (error) {
      this.logger.warn("[updater] failed to clear install journal", error);
    }
  }

  private clearStaleInstallArtifacts(): boolean {
    let cleared = true;
    const updaterCache = this.updaterCachePath();
    for (const candidate of [path.join(updaterCache, "pending"), path.join(updaterCache, "update.zip")]) {
      try {
        this.removePath(candidate, { recursive: true, force: true });
      } catch (error) {
        cleared = false;
        this.logger.warn("[updater] failed to clear stale updater cache", error);
      }
      if (fs.existsSync(candidate)) cleared = false;
    }
    if (this.deps.platform !== "darwin") return cleared;
    const shipIt = this.shipItPath();
    const shipItState = path.join(shipIt, "ShipItState.plist");
    try {
      this.removePath(shipItState, { force: true });
      if (fs.existsSync(shipIt)) {
        for (const entry of fs.readdirSync(shipIt, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("update.")) {
            this.removePath(path.join(shipIt, entry.name), { recursive: true, force: true });
          }
        }
      }
    } catch (error) {
      cleared = false;
      this.logger.warn("[updater] failed to clear stale ShipIt state", error);
    }
    if (fs.existsSync(shipItState)) cleared = false;
    try {
      if (
        fs.existsSync(shipIt) &&
        fs.readdirSync(shipIt, { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name.startsWith("update."))
      ) {
        cleared = false;
      }
    } catch {
      cleared = false;
    }
    return cleared;
  }

  private cleanupOrBlock(version?: string): boolean {
    if (this.clearStaleInstallArtifacts()) return true;
    this.automaticInstallPaused = true;
    this.blockedTargetVersion = version ?? null;
    this.blockedReasonCode = "legacy-cleanup-failed";
    this.publish(this.manualState(version, "legacy-cleanup-failed"));
    return false;
  }

  private manualState(version: string | undefined, code: UpdaterErrorCode): UpdaterState {
    const canRetry = code === "continuity-backup-failed" || code === "legacy-cleanup-failed";
    const offersInstaller = new Set<UpdaterErrorCode>([
      "install-not-owned",
      "install-not-applied",
      "install-state-corrupt",
      "install-start-failed",
      "minimum-app-version",
      "minimum-runtime-version",
    ]).has(code);
    return {
      status: "manual-required",
      version,
      code,
      error: safeMessage(code),
      canRetry,
      ...(offersInstaller ? { manualDownloadUrl: this.manualDownloadUrl } : {}),
    };
  }

  private incompatibleState(
    version: string | undefined,
    code: UpdaterErrorCode,
    compatibility?: UpdaterCompatibility,
  ): UpdaterState {
    const offersInstaller = code === "minimum-app-version" || code === "minimum-runtime-version";
    return {
      status: "incompatible",
      version,
      code,
      error: safeMessage(code),
      canRetry: code === "compatibility-metadata-missing",
      ...(offersInstaller ? { manualDownloadUrl: this.manualDownloadUrl } : {}),
      compatibility,
    };
  }

  private errorState(code: UpdaterErrorCode): UpdaterState {
    return {
      status: "error",
      version: this.state.version,
      code,
      error: safeMessage(code),
      canRetry: code === "check-failed" || code === "download-failed",
    };
  }

  private compatibilityFailure(compatibility: UpdaterCompatibility): UpdaterErrorCode | null {
    const currentVersion = this.deps.currentVersion();
    if ((compareSemVer(currentVersion, compatibility.minimumSourceAppVersion) ?? -1) < 0) {
      return "minimum-app-version";
    }
    const runtimeVersion = this.deps.runtimeVersion();
    if (!runtimeVersion || (compareSemVer(runtimeVersion, compatibility.minimumRuntimeVersion) ?? -1) < 0) {
      return "minimum-runtime-version";
    }
    const schemaVersion = this.deps.databaseSchemaVersion();
    if (schemaVersion === null || schemaVersion < compatibility.minimumSchemaVersion) {
      return "minimum-schema-version";
    }
    if (schemaVersion > compatibility.targetSchemaVersion) {
      return "minimum-schema-version";
    }
    return null;
  }

  private async reconcileJournal(): Promise<void> {
    const journal = this.readJournal();
    if (!journal) {
      // At process start there is no active check/download yet. Without our durable
      // install journal, ShipItState/update.zip can only be a legacy orphan; discard
      // it and let the next signed feed check obtain a fresh payload.
      if (!this.cleanupOrBlock()) return;
      if (this.automaticInstallPaused) {
        this.publish(this.manualState(undefined, "install-state-corrupt"));
      }
      return;
    }
    this.blockedTargetVersion = journal.targetVersion;
    this.blockedReasonCode = journal.reasonCode ?? "install-not-applied";
    this.recoveryBackupPath = journal.continuity.backupPath;
    const comparison = compareSemVer(this.deps.currentVersion(), journal.targetVersion);
    if (comparison !== null && comparison >= 0) {
      const verification = await this.deps.verifyContinuity(journal.continuity).catch((error) => {
        this.logger.warn("[updater] continuity verification failed", error);
        return { ok: false, violations: ["verification-failed"] };
      });
      if (!verification.ok) {
        this.writeJournal({ ...journal, phase: "recovery-required", reasonCode: "continuity-violation" });
        this.publish({
          status: "recovery-required",
          version: journal.targetVersion,
          code: "continuity-violation",
          error: safeMessage("continuity-violation"),
          canRetry: false,
          recoveryBackupAvailable: fs.existsSync(journal.continuity.backupPath),
        });
        return;
      }
      if (!this.cleanupOrBlock(journal.targetVersion)) {
        this.writeJournal({ ...journal, phase: "blocked", reasonCode: "legacy-cleanup-failed" });
        return;
      }
      this.clearJournal();
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.publish({ status: "updated", version: journal.targetVersion });
      return;
    }
    if (!this.cleanupOrBlock(journal.targetVersion)) {
      this.writeJournal({ ...journal, phase: "blocked", reasonCode: "legacy-cleanup-failed" });
      return;
    }
    const reasonCode = journal.reasonCode ?? "install-not-applied";
    this.blockedReasonCode = reasonCode;
    this.writeJournal({ ...journal, phase: "blocked", reasonCode });
    this.publish(this.manualState(journal.targetVersion, reasonCode));
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.deps.updater.autoDownload = false;
    this.deps.updater.autoInstallOnAppQuit = false;

    this.listen("checking-for-update", () => {
      if (!terminalStates.has(this.state.status)) this.publish({ status: "checking" });
    });
    this.listen("update-available", (info: UpdateInfoLike) => {
      this.availablePromise = this.handleUpdateAvailable(info);
      void this.availablePromise.finally(() => {
        this.availablePromise = null;
      });
    });
    this.listen("update-not-available", () => {
      if (terminalStates.has(this.state.status) || this.downloadPromise) return;
      this.publish({ status: "not-available" });
    });
    this.listen("download-progress", (progress: { percent?: number }) => {
      if (!this.availableVersion || terminalStates.has(this.state.status)) return;
      const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent!))) : 0;
      this.publish({ status: "downloading", version: this.availableVersion, progress: percent });
    });
    this.listen("update-downloaded", (info: UpdateInfoLike) => {
      const version = typeof info?.version === "string" ? info.version : this.availableVersion ?? undefined;
      if (!version || !this.isNewer(version)) {
        if (!this.cleanupOrBlock(version)) return;
        this.publish({ status: "not-available" });
        return;
      }
      this.availableVersion = version;
      this.publish({
        status: "downloaded",
        version,
        progress: 100,
        compatibility: this.state.compatibility,
      });
    });
    this.listen("error", (error: unknown) => {
      this.logger.warn("[updater] electron-updater error", error);
      if (this.state.status === "installing") {
        const journal = this.readJournal();
        if (journal) this.writeJournal({ ...journal, phase: "blocked", reasonCode: "install-start-failed" });
        this.blockedTargetVersion = this.state.version ?? null;
        this.blockedReasonCode = "install-start-failed";
        if (!this.cleanupOrBlock(this.state.version)) return;
        this.publish(this.manualState(this.state.version, "install-start-failed"));
        return;
      }
      if (this.state.status === "downloaded" || this.state.status === "recovery-required") return;
      this.publish(this.errorState(this.downloadPromise ? "download-failed" : "check-failed"));
    });

    await this.reconcileJournal();
    if (this.state.status === "recovery-required" || this.automaticInstallPaused) return;
    if (this.deps.schedule === false) return;

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.check();
    }, this.deps.initialDelayMs ?? 15_000);
    this.initialTimer.unref?.();
    this.timer = setInterval(() => {
      void this.check();
    }, this.deps.checkIntervalMs ?? 60 * 60 * 1000);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
    for (const { event, listener } of this.listeners) this.deps.updater.removeListener?.(event, listener);
    this.listeners.length = 0;
    this.initialized = false;
  }

  private isNewer(version: string | undefined): boolean {
    const comparison = compareSemVer(version, this.deps.currentVersion());
    return comparison !== null && comparison > 0;
  }

  private async handleUpdateAvailable(info: UpdateInfoLike): Promise<void> {
    const version = typeof info?.version === "string" ? info.version : undefined;
    if (!version || !this.isNewer(version)) {
      if (!this.cleanupOrBlock(version)) return;
      this.publish({ status: "not-available" });
      return;
    }
    if (this.availableVersion === version && (this.downloadPromise || this.state.status === "downloaded")) return;
    if (this.blockedTargetVersion === version) {
      this.publish(this.manualState(version, this.blockedReasonCode));
      return;
    }

    const compatibility = parseUpdaterCompatibility(info.agentlasCompatibility);
    if (!compatibility) {
      this.publish(this.incompatibleState(version, "compatibility-metadata-missing"));
      return;
    }
    const compatibilityFailure = this.compatibilityFailure(compatibility);
    if (compatibilityFailure) {
      this.publish(this.incompatibleState(version, compatibilityFailure, compatibility));
      return;
    }
    const access = evaluateInstallAccess({
      platform: this.deps.platform,
      execPath: this.deps.execPath,
      uid: this.deps.uid,
    });
    if (!access.ok) {
      this.blockedTargetVersion = version;
      this.blockedReasonCode = "install-not-owned";
      if (!this.cleanupOrBlock(version)) return;
      this.publish(this.manualState(version, "install-not-owned"));
      return;
    }

    this.availableVersion = version;
    this.publish({ status: "available", version, compatibility });
    this.publish({ status: "downloading", version, progress: 0, compatibility });
    this.downloadPromise = this.deps.updater
      .downloadUpdate()
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn("[updater] download failed", error);
        this.publish(this.errorState("download-failed"));
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    await this.downloadPromise;
  }

  check(): Promise<UpdaterState> {
    if (this.checkPromise) return this.checkPromise;
    if (this.automaticInstallPaused) {
      if (this.state.code !== "legacy-cleanup-failed" || !this.clearStaleInstallArtifacts()) {
        return Promise.resolve(this.state);
      }
      this.automaticInstallPaused = false;
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.publish({ status: "idle" });
    }
    if (this.state.status === "installing" || this.state.status === "recovery-required" || this.state.status === "downloaded") {
      return Promise.resolve(this.state);
    }
    this.checkPromise = (async () => {
      this.publish({ status: "checking" });
      try {
        const result = await this.deps.updater.checkForUpdates();
        const info = result?.updateInfo;
        if (result?.isUpdateAvailable && info) {
          await this.handleUpdateAvailable(info);
          if (this.availablePromise) await this.availablePromise;
        } else if (this.state.status === "checking") {
          this.publish({ status: "not-available" });
        }
      } catch (error) {
        this.logger.warn("[updater] check failed", error);
        if (!terminalStates.has(this.state.status)) this.publish(this.errorState("check-failed"));
      } finally {
        this.lastCheckedAt = this.now();
        this.publish(this.state);
      }
      return this.state;
    })().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  install(): Promise<UpdaterActionResult> {
    if (this.installPromise) return this.installPromise;
    const isRetryableSafetyBlock =
      this.state.status === "manual-required" &&
      this.state.code === "continuity-backup-failed" &&
      this.state.canRetry === true;
    if (
      (this.state.status !== "downloaded" && !isRetryableSafetyBlock) ||
      !this.state.version ||
      !this.isNewer(this.state.version)
    ) {
      return Promise.resolve({ accepted: false, state: this.state });
    }
    this.installPromise = this.installOnce().finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  private async installOnce(): Promise<UpdaterActionResult> {
    const version = this.state.version;
    if (!version) return { accepted: false, state: this.state };
    const access = evaluateInstallAccess({ platform: this.deps.platform, execPath: this.deps.execPath, uid: this.deps.uid });
    if (!access.ok) {
      this.blockedTargetVersion = version;
      this.blockedReasonCode = "install-not-owned";
      if (!this.cleanupOrBlock(version)) return { accepted: false, state: this.state };
      return { accepted: false, state: this.publish(this.manualState(version, "install-not-owned")) };
    }

    let resumeWriters: (() => void) | undefined;
    try {
      resumeWriters = (await this.deps.quiesceWriters?.()) || undefined;
    } catch (error) {
      this.logger.warn("[updater] writer quiescence failed", error);
      return { accepted: false, state: this.publish(this.manualState(version, "continuity-backup-failed")) };
    }

    let keepWritersQuiesced = false;
    try {
      let continuity: ContinuitySnapshot;
      try {
        continuity = await this.deps.captureContinuity(version);
        this.recoveryBackupPath = continuity.backupPath;
      } catch (error) {
        this.logger.warn("[updater] continuity backup failed", error);
        return { accepted: false, state: this.publish(this.manualState(version, "continuity-backup-failed")) };
      }

      const journal: InstallJournal = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        phase: "install-requested",
        sourceVersion: this.deps.currentVersion(),
        targetVersion: version,
        requestedAt: new Date(this.now()).toISOString(),
        continuity,
      };
      try {
        this.writeJournal(journal);
      } catch (error) {
        this.logger.warn("[updater] install journal write failed", error);
        return { accepted: false, state: this.publish(this.manualState(version, "continuity-backup-failed")) };
      }

      this.publish({
        status: "installing",
        version,
        progress: 100,
        compatibility: this.state.compatibility,
        recoveryBackupAvailable: true,
      });
      try {
        // Windows updates must reuse the existing installation without opening
        // the NSIS setup wizard. The second flag relaunches Agentlas afterward.
        this.deps.updater.quitAndInstall(true, true);
        keepWritersQuiesced = true;
        return { accepted: true, state: this.state };
      } catch (error) {
        this.logger.warn("[updater] quitAndInstall failed", error);
        this.writeJournal({ ...journal, phase: "blocked", reasonCode: "install-start-failed" });
        this.blockedTargetVersion = version;
        this.blockedReasonCode = "install-start-failed";
        if (!this.cleanupOrBlock(version)) return { accepted: false, state: this.state };
        return { accepted: false, state: this.publish(this.manualState(version, "install-start-failed")) };
      }
    } finally {
      if (!keepWritersQuiesced) {
        try {
          resumeWriters?.();
        } catch (error) {
          this.logger.warn("[updater] failed to resume writers after cancelled install", error);
        }
      }
    }
  }

  async openManualDownload(): Promise<UpdaterActionResult> {
    const allowed =
      this.state.manualDownloadUrl === this.manualDownloadUrl ||
      (this.state.status === "recovery-required" && !this.state.recoveryBackupAvailable);
    if (!allowed) return { accepted: false, state: this.state };
    try {
      await this.deps.openExternal(this.manualDownloadUrl);
      return { accepted: true, state: this.state };
    } catch (error) {
      this.logger.warn("[updater] failed to open official download page", error);
      return { accepted: false, state: this.state };
    }
  }

  revealRecoveryBackup(): UpdaterActionResult {
    if (
      this.state.status !== "recovery-required" ||
      !this.recoveryBackupPath ||
      !fs.existsSync(this.recoveryBackupPath)
    ) {
      return { accepted: false, state: this.state };
    }
    this.deps.revealPath(this.recoveryBackupPath);
    return { accepted: true, state: this.state };
  }
}
