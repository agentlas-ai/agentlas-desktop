import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareSemVer, parseSemVer } from "../../shared/semver";
import type {
  UpdaterActionResult,
  UpdaterCompatibility,
  UpdaterDiagnostic,
  UpdaterDiagnosticCategory,
  UpdaterErrorCode,
  UpdaterState,
} from "../../shared/types";

const JOURNAL_SCHEMA_VERSION = 1;
const CONTINUITY_GATE_VERSION = 2;
/**
 * How long a failed install may suppress further attempts. Long enough that a
 * genuinely broken machine is not retried in a loop; short enough that a user
 * who hit a transient failure is back on the update track the same day.
 */
const HOLD_EXPIRY_MS = 6 * 60 * 60 * 1000;
const RECOVERY_SESSION_RETRY_DELAY_MS = 500;
const RECOVERY_SESSION_RETRY_ATTEMPTS = 4;
const NATIVE_INSTALL_WATCHDOG_MS = 20_000;
const NATIVE_INSTALL_RETRY_BASE_DELAY_MS = 1_000;
const NATIVE_INSTALL_RETRY_MAX_DELAY_MS = 5 * 60_000;
const TRANSIENT_RETRY_BASE_DELAY_MS = 30_000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 15 * 60_000;
const LAUNCHCTL_SERVICE_ABSENT = 113;

export const CONTINUITY_CORE_TABLES = [
  "installed_agents",
  "firms",
  "hub_agent_bookmarks",
  "projects",
  "chats",
  "chat_messages",
  "chat_goal_contracts",
  "chat_message_attachments",
  "memory_entries",
  // Per-agent activity and failure ledgers are the evidence behind My Agents
  // learning/evolution views. Losing them would make a used agent look empty.
  "run_events",
  "failure_events",
  "automations",
  "automation_runs",
  // Accepted fs/chain/webhook/poll deliveries must survive an app update. The
  // bound run receipt is what prevents a post-update replay of external work.
  "automation_trigger_events",
  "agent_evolution_proposals",
  "agent_evolution_receipts",
  "agent_asset_versions",
  "experience_packs",
  "experience_candidates",
  "experience_promotion_receipts",
  "experience_export_intents",
  // Canonical value-free lineage is protected. relation_nodes/edges/state are
  // deliberately omitted because they are disposable rebuildable projections.
  "experience_lineage_events",
  // Human/curator assertions are authoritative; unlike semantic relation
  // nodes/edges they must never be regenerated or inferred after an update.
  "experience_governance_relations",
  // Canonical portable bundles, idempotency keys and Cloud receipts are owned
  // local recovery state; they must survive an application update.
  "experience_cloud_uploads",
  // Privacy-safe automatic intake decisions are the local audit trail. They
  // contain hashes/reason codes only and must not be silently re-run after an update.
  "experience_auto_intake_receipts",
  // Private Taste observations are distinct from operational Experience and
  // must survive updates without being inferred again from mutable Memory.
  "taste_draft_candidates",
  "taste_chip_workflows",
  // Exact Hub AgentDefinition + release identity cannot be reconstructed from
  // slug, local id, package hash or latest-release inference after an update.
  "installed_agent_hub_bindings",
  "agent_apps",
  "agent_tools",
  "agent_surfaces",
  "mcp_servers",
  "agent_mcp_servers",
  "agent_runtime_overrides",
  // Canonical durable Task and its agent-participation history. The Task is the
  // object One/Work/Mobile all project; participation survives free agent
  // deletion via agent_slug. Verification is snapshot-self-set, so appending
  // these is safe — a pre-v71 snapshot never asked for them, a v72+ snapshot
  // includes them. (Never reintroduce an exact-match table-list gate.)
  "tasks",
  "task_agent_participants",
] as const;

// schemaVersion 1 journals shipped before the Experience/Ontology continuity
// expansion contain this original table set. Keep accepting those durable
// journals; newly captured snapshots still include every table above.
export const CONTINUITY_V1_TABLES = [
  "installed_agents",
  "firms",
  "hub_agent_bookmarks",
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
  releaseNotes?: unknown;
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

/**
 * Reads the version the update feed offers *right now*, without touching
 * electron-updater's own state. `null` means the feed could not be read.
 *
 * Why this exists: the version we downloaded was chosen when the check ran,
 * which can be days before the user presses install. In August 2026 two
 * releases had to be withdrawn hours after publication; anyone whose app had
 * already downloaded one still installed it, because nothing looked again.
 */
export type OfferedVersionReader = () => Promise<string | null>;

export interface ContinuitySnapshot {
  schemaVersion: 1 | 2;
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

export type RecoverySessionRefreshResult =
  | { status: "restored"; signedIn: true }
  | { status: "missing" | "expired" | "invalid" | "native-unavailable" | "temporarily-unavailable"; signedIn: false };

export interface InstallJournal {
  schemaVersion: 1;
  /**
   * Version 2 defers boot repair projections until continuity passes. Journals
   * without this field came from the legacy ordering that could create a false
   * recovery hold and are eligible for one-time stale-hold recovery.
   */
  continuityGateVersion?: 2;
  phase: "install-requested" | "blocked" | "recovery-required";
  sourceVersion: string;
  targetVersion: string;
  requestedAt: string;
  reasonCode?: UpdaterErrorCode;
  diagnostic?: UpdaterDiagnostic;
  /** Number of failed native handoffs for this source/target pair. */
  nativeInstallFailures?: number;
  /** Epoch milliseconds; avoids a tight retry loop after helper/payload failures. */
  retryAfter?: number;
  /**
   * Best-effort pre-install snapshot. Absent when the copy could not be taken —
   * a backup is a convenience for manual recovery, never a precondition for
   * updating. Crash safety during a schema change is owned by the migration
   * transactions in the store, which hold regardless of this field.
   */
  continuity?: ContinuitySnapshot;
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
  /** Value-free macOS source identity check owned by main process. */
  inspectInstalledAppTrust: (bundlePath: string) => Promise<InstalledAppTrustResult>;
  /** Narrow repair for generated Python cache files inside an otherwise official bundle. */
  repairInstalledAppTrust?: (bundlePath: string, diagnostic: UpdaterDiagnostic) => Promise<boolean>;
  /** Stop mutable background writers and resolve only after their current work drains. */
  quiesceWriters?: () => Promise<void | (() => void)>;
  captureContinuity: (targetVersion: string) => Promise<ContinuitySnapshot>;
  verifyContinuity: (snapshot: ContinuitySnapshot) => Promise<ContinuityVerification>;
  broadcast: (state: UpdaterState) => void;
  revealPath: (filePath: string) => void;
  logger?: Pick<Console, "log" | "warn" | "error">;
  now?: () => number;
  initialDelayMs?: number;
  checkIntervalMs?: number;
  schedule?: boolean;
  removePath?: (target: string, options: { recursive?: boolean; force?: boolean }) => void;
  recoverySessionRetryDelayMs?: number;
  recoverySessionRetryAttempts?: number;
  waitForRecoveryRetry?: (delayMs: number) => Promise<void>;
  initialSessionRestore?: RecoverySessionRefreshResult;
  refreshSessionForRecovery?: () => Promise<void | RecoverySessionRefreshResult>;
  /** Release the app's single-instance lock immediately before native spawn. */
  releaseInstanceLockForInstall?: () => void;
  /** Restore the lock if native spawn fails and this process remains alive. */
  reacquireInstanceLockAfterInstallFailure?: () => boolean;
  nativeInstallWatchdogMs?: number;
  nativeInstallRetryBaseDelayMs?: number;
  transientRetryBaseDelayMs?: number;
  transientRetryMaxDelayMs?: number;
  /** Test seam for fail-closed launchd inspection/bootout before stale macOS cleanup. */
  runLaunchctl?: (args: string[]) => number;
  /**
   * Re-reads what the feed offers, immediately before an install is handed off.
   * Required: leaving it optional would let a wiring mistake silently restore
   * the behavior this guard exists to remove.
   */
  offeredVersion: OfferedVersionReader;
}

interface InstallAccessResult {
  ok: boolean;
  bundlePath: string | null;
  reason?: string;
}

export type InstalledAppTrustResult =
  | { ok: true }
  | { ok: false; diagnostic: UpdaterDiagnostic };

const terminalStates = new Set<UpdaterState["status"]>([
  "downloaded",
  "installing",
]);

const updaterErrorCodes = new Set<UpdaterErrorCode>([
  "config-missing",
  "check-failed",
  "download-failed",
  "install-not-owned",
  "install-source-untrusted",
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

const updaterDiagnosticMessages = {
  "source-signature-class": "The running app is not signed with the official Developer ID application certificate.",
  "source-identity": "The running app does not match the pinned Agentlas application identity.",
  "source-seal": "The running app has the official identity, but its signed contents changed after packaging.",
  "source-designated-requirement": "The running app does not satisfy the pinned Agentlas signing requirement.",
  "source-gatekeeper": "macOS Gatekeeper did not accept the running Agentlas app.",
  "source-verification-unavailable": "The running app signature could not be verified by macOS.",
  "native-install-signature": "The native updater rejected the application signature identity.",
  "native-install-permission": "The native updater could not replace the application with the current macOS permissions.",
  "native-install-space": "The native updater did not have enough free disk space to stage the update.",
  "native-install-payload": "The native updater could not find or open the downloaded update payload.",
  "native-install-state": "The native updater could not prepare its local install state.",
  "native-install-timeout": "The native updater did not complete its handoff in time.",
  "native-install-unknown": "The native updater stopped before application replacement began.",
} as const satisfies Record<UpdaterDiagnosticCategory, string>;

export function updaterDiagnostic(category: UpdaterDiagnosticCategory): UpdaterDiagnostic {
  return { category, message: updaterDiagnosticMessages[category] };
}

/**
 * `category` is the durable fact; `message` is this release's wording of it.
 *
 * Requiring the persisted message to equal the current English sentence tied
 * journal validity to display copy: release N writes a journal carrying the
 * sentence it shipped, release N+1 edits any of the thirteen strings above —
 * ordinary copy work, including translation — and every journal written by N
 * becomes invalid on read. A pending install then reads as corrupt for a reason
 * no one would connect to the edit that caused it. Validate the closed enum and
 * re-derive the wording, so the record survives the words.
 */
export function isValidUpdaterDiagnostic(value: unknown): value is UpdaterDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.category !== "string" || !(raw.category in updaterDiagnosticMessages)) return false;
  return raw.message === undefined || typeof raw.message === "string";
}

function nativeErrorClassifierText(error: unknown): string {
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown };
    return `${typeof coded.code === "string" ? coded.code : ""} ${error.message}`.slice(0, 4_096);
  }
  if (error && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    return `${typeof raw.code === "string" ? raw.code : ""} ${typeof raw.message === "string" ? raw.message : ""}`.slice(0, 4_096);
  }
  return "";
}

/** Classifies locally, then discards native error text before persistence/UI. */
export function redactNativeUpdaterDiagnostic(error: unknown): UpdaterDiagnostic {
  const text = nativeErrorClassifierText(error);
  if (/code.?sign|signature|designated requirement|errsec|cssmerr|different team|team.?id/i.test(text)) {
    return updaterDiagnostic("native-install-signature");
  }
  if (/\benospc\b|no space left|disk (?:is )?full|insufficient (?:disk )?space/i.test(text)) {
    return updaterDiagnostic("native-install-space");
  }
  if (/\b(?:etimedout|timeout)\b|timed out|helper hang/i.test(text)) {
    return updaterDiagnostic("native-install-timeout");
  }
  if (/\b(?:eacces|eperm)\b|permission|operation not permitted|authori[sz]ation/i.test(text)) {
    return updaterDiagnostic("native-install-permission");
  }
  if (/\benoent\b|no such file|update\.zip|downloaded payload|pending[/\\]/i.test(text)) {
    return updaterDiagnostic("native-install-payload");
  }
  if (/shipit|squirrel|install.?state|update state/i.test(text)) {
    return updaterDiagnostic("native-install-state");
  }
  return updaterDiagnostic("native-install-unknown");
}

function isRetryableNativeDiagnostic(diagnostic: UpdaterDiagnostic | undefined): boolean {
  return Boolean(diagnostic && new Set<UpdaterDiagnosticCategory>([
    "native-install-permission",
    "native-install-space",
    "native-install-payload",
    "native-install-state",
    "native-install-timeout",
    // Native/Squirrel errors are localized by macOS. An unfamiliar message is
    // not evidence of an identity or signature failure: those categories are
    // detected explicitly above. Treat the remaining handoff failure as
    // transient so one localized OS error cannot strand every later release.
    "native-install-unknown",
  ]).has(diagnostic.category));
}

function safeMessage(code: UpdaterErrorCode): string {
  switch (code) {
    case "config-missing":
      return "This build has no verified update channel. The installed app was left unchanged.";
    case "check-failed":
      return "The update server could not be reached. The installed app was left unchanged.";
    case "download-failed":
      return "The update could not be downloaded. The installed app was left unchanged.";
    case "install-not-owned":
      return "The macOS updater could not obtain replacement access. The existing app and local Agentlas data were preserved; retry from this app.";
    case "install-source-untrusted":
      return "Agentlas could not finish its internal app repair. The existing app and local data were preserved; retry from this app.";
    case "install-not-applied":
      return "The previous update was not applied, so Agentlas will not repeat the same install. The existing app and local data were preserved.";
    case "install-state-corrupt":
      return "The previous update state could not be verified. Automatic install is paused and the existing app and local data were left unchanged.";
    case "legacy-cleanup-failed":
      return "A previous macOS update instruction could not be removed. Automatic updates are paused to prevent another install loop.";
    case "install-start-failed":
      return "The update could not start safely. The existing app and local data were preserved; retry from this app.";
    case "continuity-backup-failed":
      return "Agentlas could not create the local-state recovery copy, so the update was not applied.";
    case "continuity-violation":
      return "Some local Agentlas state could not be verified after the update. Use the preserved recovery copy in this app.";
    case "compatibility-metadata-missing":
      return "This release does not declare the required Agentlas compatibility boundary. Automatic install was not attempted.";
    case "minimum-app-version":
      // Never promise a bridge. Nothing in this repo picks an intermediate
      // build, and this state is not retryable, so the old wording described a
      // rescue that would never arrive. Reinstalling is the only way out, and
      // it keeps userData.
      return "This app is too old to update itself. Download the latest installer and replace it — your local Agentlas data is kept.";
    case "minimum-runtime-version":
      return "This release needs an automatic Agentlas runtime bridge before it can be applied. The current app and local data remain unchanged.";
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
    // A normal /Applications app may be root-owned and its parent not directly
    // writable by the standard user. Squirrel/ShipIt owns authorization and
    // replacement. This preflight only establishes an inspectable source app;
    // it must not confuse filesystem ownership with signing trust.
    if (!fs.statSync(bundlePath).isDirectory() || !fs.statSync(input.execPath).isFile()) {
      return { ok: false, bundlePath, reason: "app-source-unavailable" };
    }
    fs.accessSync(input.execPath, fs.constants.R_OK);
    return { ok: true, bundlePath };
  } catch {
    return { ok: false, bundlePath, reason: "app-source-unavailable" };
  }
}

export function isValidContinuitySnapshot(value: unknown): value is ContinuitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const rowCounts = raw.rowCounts as Record<string, unknown> | null;
  const tableIdentityHashes = raw.tableIdentityHashes as Record<string, unknown> | null;
  const agentAssetHashes = raw.agentAssetHashes as Record<string, unknown> | null;
  const rowCountEntries = rowCounts && typeof rowCounts === "object" && !Array.isArray(rowCounts)
    ? Object.entries(rowCounts)
    : [];
  const identityHashEntries = tableIdentityHashes && typeof tableIdentityHashes === "object" && !Array.isArray(tableIdentityHashes)
    ? Object.entries(tableIdentityHashes)
    : [];
  const rowCountKeys = rowCountEntries.map(([table]) => table).sort();
  const identityHashKeys = identityHashEntries.map(([table]) => table).sort();
  // A journal is written by the PREVIOUS app version, so a schemaVersion 2
  // protection map must be accepted with whatever table set that version
  // protected — comparing against the current (possibly larger)
  // CONTINUITY_CORE_TABLES quarantines every healthy journal that crosses a
  // release which grew the list (v0.8.32 incident: 31 vs 32 tables bricked
  // auto-update on every machine it touched). Never reintroduce that
  // comparison. schemaVersion 1 keeps its frozen historical set.
  const legacyTableKeys = raw.schemaVersion === 1 ? [...CONTINUITY_V1_TABLES].sort() : null;
  const validProtectedTableMaps =
    (raw.schemaVersion === 1 || raw.schemaVersion === 2) &&
    rowCountKeys.length > 0 &&
    rowCountKeys.length === identityHashKeys.length &&
    rowCountKeys.every((table, index) => table === identityHashKeys[index]) &&
    (legacyTableKeys === null
      ? rowCountKeys.every((table) => /^[A-Za-z][A-Za-z0-9_]*$/.test(table))
      : rowCountKeys.length === legacyTableKeys.length &&
        rowCountKeys.every((table, index) => table === legacyTableKeys[index])) &&
    rowCountEntries.every(([, count]) => asNonNegativeInteger(count) !== null) &&
    identityHashEntries.every(([, hash]) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
  return (
    (raw.schemaVersion === 1 || raw.schemaVersion === 2) &&
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
    validProtectedTableMaps &&
    tableIdentityHashes !== null &&
    typeof tableIdentityHashes === "object" &&
    !Array.isArray(tableIdentityHashes) &&
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
    (raw.continuityGateVersion === undefined || raw.continuityGateVersion === CONTINUITY_GATE_VERSION) &&
    (raw.phase === "install-requested" || raw.phase === "blocked" || raw.phase === "recovery-required") &&
    typeof raw.sourceVersion === "string" &&
    Boolean(parseSemVer(raw.sourceVersion)) &&
    typeof raw.targetVersion === "string" &&
    Boolean(parseSemVer(raw.targetVersion)) &&
    typeof raw.requestedAt === "string" &&
    Number.isFinite(Date.parse(raw.requestedAt)) &&
    (raw.reasonCode === undefined || (typeof raw.reasonCode === "string" && updaterErrorCodes.has(raw.reasonCode as UpdaterErrorCode))) &&
    (raw.diagnostic === undefined || isValidUpdaterDiagnostic(raw.diagnostic)) &&
    (raw.nativeInstallFailures === undefined || asNonNegativeInteger(raw.nativeInstallFailures) !== null) &&
    (raw.retryAfter === undefined || asNonNegativeInteger(raw.retryAfter) !== null) &&
    // ★continuity 는 **선택**이다 — 타입도 그렇고(`continuity?`), 기록 경로도 그렇게 쓴다:
    // 백업을 못 뜨면(바쁜 디스크·일시적 SQLite I/O 오류) `...(continuity ? {continuity} : {})`
    // 로 아예 빼고 저널을 쓴다. "백업 실패가 업데이트를 막으면 안 된다"는 것이 그 분기의
    // 존재 이유였다(실기계에서 업데이트 4연속 차단을 고친 수리).
    //
    // 그런데 여기서만 그걸 **필수**로 요구했다. 그래서 백업이 실패한 순간 앱이 방금 쓴
    // 저널을 스스로 corrupt 로 판정 → corrupt 마커 기록 → 자동 설치 정지, 라는 사슬이 돌았다.
    // 즉 업데이트를 살리려고 만든 자가교정 분기를, 뒤에 있는 fail-closed 단언이 죽였다.
    // 소비자는 전부 이미 `journal.continuity?.` 로 없을 때를 다루고 있다(1378·1385·1434행).
    (raw.continuity === undefined || isValidContinuitySnapshot(raw.continuity))
  );
}

export function inspectInstallJournalFile(file: string): InstallJournalInspection {
  if (!fs.existsSync(file)) return { status: "none" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isValidJournal(parsed)) return { status: "corrupt" };
    // Show this release's wording, not the sentence the journal was written
    // with. The category is what was persisted; the copy is presentation, and a
    // user reading a diagnostic from two versions ago is reading a string the
    // product no longer uses.
    const journal = parsed.diagnostic
      ? { ...parsed, diagnostic: updaterDiagnostic(parsed.diagnostic.category) }
      : parsed;
    return { status: "valid", journal };
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

/**
 * A correctly sealed update contains 0555 runtime directories. Make only an
 * updater-owned stale tree removable before fs.rmSync. Symlinks are never
 * traversed, and this helper must never be used on the installed application.
 */
function makeUpdaterTreeOwnerWritable(target: string): void {
  // Electron's patched fs treats a valid *.asar file as a virtual directory.
  // Walking into it makes chmodSync receive paths such as app.asar/dist, which
  // are not real filesystem entries and fail with ENOTDIR. The archive itself
  // is removed with its containing stale update tree, so never traverse it.
  if (path.extname(target).toLowerCase() === ".asar") return;
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  fs.chmodSync(target, stat.mode | 0o700);
  for (const entry of fs.readdirSync(target)) {
    makeUpdaterTreeOwnerWritable(path.join(target, entry));
  }
}

function mergeCheckedAt(state: UpdaterState, checkedAt: number | undefined): UpdaterState {
  return checkedAt ? { ...state, lastCheckedAt: checkedAt } : state;
}

/** Convert electron-updater feed notes into bounded renderer-safe plain text. */
function normalizeReleaseNotes(value: unknown): string | undefined {
  const notes = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap((entry) => {
          if (typeof entry === "string") return [entry];
          if (!entry || typeof entry !== "object") return [];
          const note = (entry as { note?: unknown }).note;
          return typeof note === "string" ? [note] : [];
        })
      : [];
  const plainText = notes
    .join("\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8)
    .join("\n")
    .slice(0, 1_200)
    .trim();
  return plainText || undefined;
}

export class DesktopUpdaterController {
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly now: () => number;
  private readonly removePath: (target: string, options: { recursive?: boolean; force?: boolean }) => void;
  private readonly runLaunchctl: (args: string[]) => number;
  private state: UpdaterState = { status: "idle" };
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private transientRetryTimer: NodeJS.Timeout | null = null;
  private transientFailureCount = 0;
  private checkPromise: Promise<UpdaterState> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private availablePromise: Promise<void> | null = null;
  private installPromise: Promise<UpdaterActionResult> | null = null;
  /** True from native quitAndInstall handoff until its terminal resolution. */
  private nativeInstallHandedOff = false;
  private availableVersion: string | null = null;
  private availableReleaseNotes: string | undefined;
  private blockedTargetVersion: string | null = null;
  private blockedReasonCode: UpdaterErrorCode = "install-not-applied";
  private blockedDiagnostic: UpdaterDiagnostic | undefined;
  private blockedNativeInstallFailures = 0;
  private blockedRetryAfter: number | undefined;
  private recoveryBackupPath: string | null = null;
  private automaticInstallPaused = false;
  /**
   * When the current hold was taken. Every hold expires: whatever blocked one
   * install (a busy disk, a stuck helper, a damaged journal) is usually gone
   * later, and no failure justifies keeping a user on an old version forever.
   */
  private holdSince: number | undefined;
  private lastCheckedAt: number | undefined;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private deferredSessionRestoreRequested = false;
  private resumeWritersAfterInstallAttempt: (() => void) | null = null;
  private nativeInstallWatchdog: NodeJS.Timeout | null = null;
  private nativeInstallReconcileTimer: NodeJS.Timeout | null = null;
  private nativeInstanceLockReleased = false;
  private readonly listeners: Array<{ event: UpdaterEvent; listener: (...args: any[]) => void }> = [];

  constructor(private readonly deps: UpdaterControllerDependencies) {
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? Date.now;
    this.removePath = deps.removePath ?? ((target, options) => fs.rmSync(target, options));
    this.runLaunchctl = deps.runLaunchctl ?? ((args) => {
      // Cross-platform contract tests may model `deps.platform = darwin` on a
      // non-macOS host. Production always passes the real process platform.
      if (process.platform !== "darwin") return LAUNCHCTL_SERVICE_ABSENT;
      try {
        execFileSync("launchctl", args, { stdio: "ignore", timeout: 5_000 });
        return 0;
      } catch (error) {
        const exitStatus = (error as { status?: unknown }).status;
        return typeof exitStatus === "number" ? exitStatus : -1;
      }
    });
  }

  getState(): UpdaterState {
    return this.state;
  }

  /** Lets the Electron adapter defer consumption until it can actually dispatch. */
  hasDeferredSessionRestoreRequest(): boolean {
    return this.deferredSessionRestoreRequested;
  }

  /** Consumed by the Electron adapter only after a restore was actually dispatched. */
  consumeDeferredSessionRestoreRequest(): boolean {
    const requested = this.deferredSessionRestoreRequested;
    this.deferredSessionRestoreRequested = false;
    return requested;
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

  private clearTransientRetry(): void {
    if (this.transientRetryTimer) clearTimeout(this.transientRetryTimer);
    this.transientRetryTimer = null;
    this.transientFailureCount = 0;
  }

  private armTransientRetry(): void {
    if (this.deps.schedule === false || this.transientRetryTimer) return;
    const baseDelay = asNonNegativeInteger(this.deps.transientRetryBaseDelayMs) ?? TRANSIENT_RETRY_BASE_DELAY_MS;
    const maxDelay = asNonNegativeInteger(this.deps.transientRetryMaxDelayMs) ?? TRANSIENT_RETRY_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * (2 ** Math.min(this.transientFailureCount, 10)), maxDelay);
    this.transientFailureCount += 1;
    this.logger.log(`[updater] transient update failure; retrying in ${delay}ms`);
    this.transientRetryTimer = setTimeout(() => {
      this.transientRetryTimer = null;
      void this.check();
    }, delay);
    this.transientRetryTimer.unref?.();
  }

  private armInstallWriterResume(resume: (() => void) | undefined): void {
    let resumed = false;
    this.resumeWritersAfterInstallAttempt = () => {
      if (resumed) return;
      resumed = true;
      this.resumeWritersAfterInstallAttempt = null;
      try {
        resume?.();
      } catch {
        this.logger.warn("[updater] failed to resume writers after cancelled install");
      }
    };
  }

  private resumeInstallWriters(): void {
    if (this.nativeInstallWatchdog) clearTimeout(this.nativeInstallWatchdog);
    this.nativeInstallWatchdog = null;
    this.resumeWritersAfterInstallAttempt?.();
  }

  private armNativeInstallWatchdog(journal: InstallJournal): void {
    const configured = asNonNegativeInteger(this.deps.nativeInstallWatchdogMs);
    const delayMs = configured ?? NATIVE_INSTALL_WATCHDOG_MS;
    this.nativeInstallWatchdog = setTimeout(() => {
      this.nativeInstallWatchdog = null;
      if (this.state.status !== "installing") return;
      this.blockInstallStart({ code: "ETIMEDOUT", message: "native updater handoff timed out" }, journal);
    }, delayMs);
    this.nativeInstallWatchdog.unref?.();
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
          // ★보류 시계는 **마커에 적힌 시각**에서 센다. `this.now()` 로 다시 시작하면
          // 6시간 만기(HOLD_EXPIRY_MS)가 앱을 껐다 켤 때마다 0으로 돌아가, 6시간 연속
          // 실행하지 않는 보통 사용자에게는 만기가 **영원히 오지 않는다**.
          //
          // 다른 탈출구가 둘 다 이 상태에선 닫혀 있어서 그게 곧 영구 차단이었다:
          //  · 바로 위 분기는 앱 버전이 마커와 **다를 때**만 마커를 지우는데, 자동 설치가
          //    멈춰 있으니 버전이 바뀔 수가 없다.
          //  · check() 의 수동 재시도는 install-start-failed / install-source-untrusted
          //    만 다루고, 이 상태(install-state-corrupt)는 다루지 않는다.
          // detectedAt 은 이미 마커에 있고 재시작을 견딘다 — 그걸 쓰면 만기가 실제로 온다.
          const detectedAt = typeof marker.detectedAt === "string" ? Date.parse(marker.detectedAt) : Number.NaN;
          this.holdSince =
            Number.isFinite(detectedAt) && detectedAt <= this.now() ? detectedAt : this.now();
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
      this.holdSince = this.now();
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
      this.holdSince = this.now();
      this.logger.warn("[updater] install journal could not be read", error);
      return null;
    }
  }

  private writeJournal(journal: InstallJournal): void {
    writeJsonAtomic(this.journalPath(), journal);
  }

  private clearJournal(): boolean {
    let cleared = true;
    // Remove the auxiliary marker first and the authoritative journal last.
    // A crash between those operations therefore leaves a journal that can be
    // verified again, rather than a marker-only false recovery hold.
    for (const file of [this.corruptJournalMarkerPath(), this.journalPath()]) {
      try {
        this.removePath(file, { force: true });
      } catch (error) {
        cleared = false;
        this.logger.warn("[updater] failed to clear install journal", error);
      }
      if (fs.existsSync(file)) cleared = false;
    }
    if (cleared) {
      try {
        const directoryFd = fs.openSync(path.dirname(this.journalPath()), fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      } catch {
        // Directory fsync is unavailable on some platforms. The safe deletion
        // order above still ensures a surviving journal is reverified.
      }
    }
    return cleared;
  }

  /**
   * A native install is in flight the moment installOnce() runs until its journal
   * leaves `install-requested`. While in flight, the pending payload, update.zip,
   * ShipItState.plist, and the ShipIt staging tree are LIVE install material —
   * deleting any of them mid-install is what bricked v0.8.65 on macOS
   * (2026-07-23): cleanup removed ShipItState.plist while launchd still had the
   * ShipIt job scheduled, so ShipIt crash-looped every 2s on "no such file" and
   * the update could never complete on that machine again.
   */
  private nativeInstallGraceMs(): number {
    return asNonNegativeInteger(this.deps.nativeInstallWatchdogMs) ?? NATIVE_INSTALL_WATCHDOG_MS;
  }

  private installInFlight(journal?: InstallJournal): boolean {
    // The in-memory flags cover the originating process. A recent durable
    // install-requested journal covers the cross-process window where ShipIt
    // may have relaunched Agentlas between native retry attempts. In the
    // incident, the replacement process returned and removed the request less
    // than one second after ShipIt's first native failure; treating every
    // restart as a dead install recreates that exact race.
    if (this.installPromise !== null || this.nativeInstallHandedOff) return true;
    // The durable cross-process grace exists only for macOS ShipIt, whose
    // launchd-owned request can outlive the originating Electron process.
    // AppImage/NSIS target relaunches must reconcile their completed journal
    // immediately; delaying them behind the ShipIt grace leaves the new app in
    // a false "installing" state and breaks native updater continuity.
    if (this.deps.platform !== "darwin") return false;
    if (!journal || journal.phase !== "install-requested") return false;
    const requestedAt = Date.parse(journal.requestedAt);
    if (!Number.isFinite(requestedAt)) return false;
    const graceMs = this.nativeInstallGraceMs();
    const elapsedMs = this.now() - requestedAt;
    if (elapsedMs < -graceMs || elapsedMs >= graceMs) return false;
    // A recent journal alone is not proof: a failed helper may already be gone.
    // The cross-process guard is active only while launchd still owns ShipIt.
    // Unknown launchd state fails safe for the bounded grace window.
    return this.shipItServiceStatus() !== LAUNCHCTL_SERVICE_ABSENT;
  }

  private scheduleNativeInstallReconcile(journal: InstallJournal): void {
    if (this.nativeInstallReconcileTimer) return;
    const requestedAt = Date.parse(journal.requestedAt);
    const graceMs = this.nativeInstallGraceMs();
    const remainingMs = Number.isFinite(requestedAt)
      ? Math.max(0, Math.min(graceMs * 2, requestedAt + graceMs - this.now()))
      : graceMs;
    this.nativeInstallReconcileTimer = setTimeout(() => {
      this.nativeInstallReconcileTimer = null;
      void this.reconcileJournal();
    }, remainingMs + 50);
    this.nativeInstallReconcileTimer.unref?.();
  }

  private stopShipItServiceBeforeCleanup(): boolean {
    if (this.deps.platform !== "darwin") return true;
    const service = this.shipItServiceTarget();
    if (!service) return false;
    const initialStatus = this.shipItServiceStatus();
    if (initialStatus === LAUNCHCTL_SERVICE_ABSENT) return true;
    if (initialStatus !== 0) {
      this.logger.warn(`[updater] could not verify ShipIt launchd state (status ${initialStatus})`);
      return false;
    }

    // A service that was present must be proven absent after bootout. Never
    // treat a swallowed launchctl error as permission to remove its request.
    this.runLaunchctl(["bootout", service]);
    const finalStatus = this.runLaunchctl(["print", service]);
    if (finalStatus !== LAUNCHCTL_SERVICE_ABSENT) {
      this.logger.warn(`[updater] ShipIt launchd job is still present after bootout (status ${finalStatus})`);
      return false;
    }
    return true;
  }

  private shipItServiceTarget(): string | null {
    if (this.deps.uid === null) {
      this.logger.warn("[updater] cannot verify ShipIt launchd state without a user id");
      return null;
    }
    return `gui/${this.deps.uid}/com.agentlas.desktop.ShipIt`;
  }

  private shipItServiceStatus(): number {
    const service = this.shipItServiceTarget();
    return service ? this.runLaunchctl(["print", service]) : -1;
  }

  /**
   * Discard install material we no longer trust.
   *
   * `keepDifferentialBaseline` is set only by the accept-after-successful-install
   * path. electron-updater computes a differential download against
   * `<cache>/update.zip` (MacUpdater: `path.join(cacheDir, "update.zip")`, at the
   * cache root, not `pending/`). Sweeping it on success meant every update
   * destroyed the baseline the next one needed, so the log read "Unable to
   * locate previous update.zip … (is this first install?)" on three consecutive
   * updates and every release pulled the full ~340MB. Immediately after an
   * accepted install that file is not untrusted material — it is the payload we
   * just proved. Every other caller is a failure or orphan path and still
   * discards it.
   */
  private clearStaleInstallArtifacts(
    knownJournal?: InstallJournal,
    options?: { keepDifferentialBaseline?: boolean },
  ): boolean {
    // Never touch live install material. Report success so callers do not
    // convert an in-flight install into a blocked/manual state.
    if (this.installInFlight(knownJournal)) return true;
    // On macOS the launchd job owns ShipItState.plist, the staging tree and the
    // proxied updater payload as one transaction. Stop and verify the owner
    // before deleting any member of that transaction.
    const shipIt = this.shipItPath();
    const shipItState = path.join(shipIt, "ShipItState.plist");
    if (this.deps.platform === "darwin") {
      let hasNativeInstallMaterial = fs.existsSync(shipItState);
      try {
        hasNativeInstallMaterial ||= fs.existsSync(shipIt) && fs.readdirSync(shipIt, { withFileTypes: true })
          .some((entry) => entry.isDirectory() && entry.name.startsWith("update."));
      } catch (error) {
        this.logger.warn("[updater] could not inspect stale ShipIt state", error);
        return false;
      }
      if (hasNativeInstallMaterial && !this.stopShipItServiceBeforeCleanup()) return false;
    }
    let cleared = true;
    const updaterCache = this.updaterCachePath();
    const sweepTargets = [path.join(updaterCache, "pending")];
    if (!options?.keepDifferentialBaseline) sweepTargets.push(path.join(updaterCache, "update.zip"));
    for (const candidate of sweepTargets) {
      try {
        makeUpdaterTreeOwnerWritable(candidate);
        this.removePath(candidate, { recursive: true, force: true });
      } catch (error) {
        cleared = false;
        this.logger.warn("[updater] failed to clear stale updater cache", error);
      }
      if (fs.existsSync(candidate)) cleared = false;
    }
    if (this.deps.platform !== "darwin") return cleared;
    try {
      this.removePath(shipItState, { force: true });
      if (fs.existsSync(shipIt)) {
        for (const entry of fs.readdirSync(shipIt, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("update.")) {
            const staleUpdate = path.join(shipIt, entry.name);
            makeUpdaterTreeOwnerWritable(staleUpdate);
            this.removePath(staleUpdate, { recursive: true, force: true });
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

  private cleanupOrBlock(
    version?: string,
    knownJournal?: InstallJournal,
    options?: { keepDifferentialBaseline?: boolean },
  ): boolean {
    if (this.clearStaleInstallArtifacts(knownJournal, options)) return true;
    this.automaticInstallPaused = true;
    this.holdSince = this.now();
    this.blockedTargetVersion = version ?? null;
    this.blockedReasonCode = "legacy-cleanup-failed";
    this.blockedDiagnostic = undefined;
    this.blockedNativeInstallFailures = 0;
    this.blockedRetryAfter = undefined;
    this.publish(this.manualState(version, "legacy-cleanup-failed"));
    return false;
  }

  private manualState(
    version: string | undefined,
    code: UpdaterErrorCode,
    diagnostic?: UpdaterDiagnostic,
    nativeInstallFailures = 0,
    retryAfter?: number,
  ): UpdaterState {
    const nativeRetryable =
      code === "install-start-failed" &&
      isRetryableNativeDiagnostic(diagnostic);
    // `install-not-applied` means the native handoff ended without replacing the
    // bundle and without reporting an error, so there is no diagnostic to
    // classify. That is precisely the case that must stay retryable: staying on
    // an old build is permanent, while whatever stopped one handoff is not.
    // Leaving it out of this set is what turned a single silent handoff into a
    // dead end whose only exit was a manual reinstall.
    const canRetry = code === "continuity-backup-failed"
      || code === "legacy-cleanup-failed"
      || code === "install-source-untrusted"
      || code === "install-not-applied"
      || nativeRetryable;
    return {
      status: "manual-required",
      version,
      code,
      error: safeMessage(code),
      ...(diagnostic ? { diagnostic } : {}),
      canRetry,
      ...(canRetry && retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  private incompatibleState(
    version: string | undefined,
    code: UpdaterErrorCode,
    compatibility?: UpdaterCompatibility,
  ): UpdaterState {
    return {
      status: "incompatible",
      version,
      code,
      error: safeMessage(code),
      canRetry: code === "compatibility-metadata-missing",
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
    // The database schema deliberately does not gate the update.
    //
    // It never could. initStore() runs its migrations before initAutoUpdater()
    // (main.ts), and those migrations cover every version from 1 upward, so by
    // the time the updater reads user_version it is always exactly this app's
    // SCHEMA_VERSION. "Too old to migrate" cannot be observed here.
    //
    // The one input that ever reached this check was a value NEWER than the
    // release — written by a development build sharing the same profile. That
    // means the user needs a NEWER app, so refusing the update pointed away
    // from the only thing that fixes it, and the code was not retryable, which
    // held the install permanently.
    //
    // Desktop apps that version their SQLite the same way (Signal, VS Code,
    // Joplin) never gate the updater on the schema. At worst the running app
    // refuses to open a future database and tells the user to update.
    return null;
  }

  private async verifyInstalledAppTrustOrBlock(
    version: string,
    access: InstallAccessResult,
  ): Promise<boolean> {
    if (this.deps.platform !== "darwin") return true;
    let trust: InstalledAppTrustResult;
    try {
      trust = access.bundlePath
        ? await this.deps.inspectInstalledAppTrust(access.bundlePath)
        : { ok: false, diagnostic: updaterDiagnostic("source-verification-unavailable") };
    } catch {
      trust = { ok: false, diagnostic: updaterDiagnostic("source-verification-unavailable") };
    }
    if (trust.ok) return true;
    if (
      access.bundlePath &&
      trust.diagnostic.category === "source-seal" &&
      this.deps.repairInstalledAppTrust
    ) {
      try {
        const repaired = await this.deps.repairInstalledAppTrust(access.bundlePath, trust.diagnostic);
        if (repaired) {
          const verified = await this.deps.inspectInstalledAppTrust(access.bundlePath);
          if (verified.ok) {
            this.logger.log("[updater] repaired generated Python cache files and restored the official app seal");
            return true;
          }
          trust = verified;
        }
      } catch {
        // Fall through to a retryable in-app repair state. Raw paths/errors stay Main-only.
      }
    }
    if (!this.cleanupOrBlock(version)) return false;
    this.blockedTargetVersion = version;
    this.blockedReasonCode = "install-source-untrusted";
    this.blockedDiagnostic = trust.diagnostic;
    this.blockedNativeInstallFailures = 0;
    this.blockedRetryAfter = undefined;
    this.publish(this.manualState(version, "install-source-untrusted", trust.diagnostic));
    return false;
  }

  private blockInstallStart(error: unknown, knownJournal?: InstallJournal): UpdaterState {
    // The native handoff has terminally failed; cleanup below may run (the
    // pre-delete launchd bootout keeps a lingering ShipIt job from crash-looping).
    this.nativeInstallHandedOff = false;
    if (this.nativeInstanceLockReleased) {
      this.nativeInstanceLockReleased = false;
      try {
        if (this.deps.reacquireInstanceLockAfterInstallFailure?.() === false) {
          this.logger.warn("[updater] native install failed and the single-instance lock could not be restored");
        }
      } catch {
        this.logger.warn("[updater] native install failed and restoring the single-instance lock threw");
      }
    }
    const diagnostic = redactNativeUpdaterDiagnostic(error);
    this.logger.warn(`[updater] native install start failed (${diagnostic.category})`);
    this.resumeInstallWriters();

    const version = this.state.version ?? knownJournal?.targetVersion;
    if (
      this.state.status === "manual-required" &&
      this.state.code === "install-start-failed" &&
      this.blockedTargetVersion === (version ?? null)
    ) {
      return this.state;
    }

    const journal = knownJournal ?? this.readJournal();
    const nativeInstallFailures = (journal?.nativeInstallFailures ?? 0) + 1;
    const retryable = isRetryableNativeDiagnostic(diagnostic);
    const baseDelay = asNonNegativeInteger(this.deps.nativeInstallRetryBaseDelayMs) ?? NATIVE_INSTALL_RETRY_BASE_DELAY_MS;
    const retryAfter = retryable
      ? this.now() + Math.min(
        baseDelay * (2 ** Math.min(Math.max(0, nativeInstallFailures - 1), 16)),
        NATIVE_INSTALL_RETRY_MAX_DELAY_MS,
      )
      : undefined;

    // A timeout cannot prove that ShipIt/helper stopped. Do not race a live
    // helper by deleting its staging state here. Explicit retry performs stale
    // cleanup only after the bounded backoff. Definite native errors can be
    // cleaned immediately.
    if (diagnostic.category !== "native-install-timeout" && !this.cleanupOrBlock(version)) return this.state;

    if (journal) {
      try {
        this.writeJournal({
          ...journal,
          phase: "blocked",
          reasonCode: "install-start-failed",
          diagnostic,
          nativeInstallFailures,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        });
      } catch {
        this.logger.warn("[updater] failed to persist redacted install diagnostic");
      }
    }
    this.blockedTargetVersion = version ?? null;
    this.blockedReasonCode = "install-start-failed";
    this.blockedDiagnostic = diagnostic;
    this.blockedNativeInstallFailures = nativeInstallFailures;
    this.blockedRetryAfter = retryAfter;
    return this.publish(this.manualState(
      version,
      "install-start-failed",
      diagnostic,
      nativeInstallFailures,
      retryAfter,
    ));
  }

  private async verifyJournalContinuity(snapshot: ContinuitySnapshot): Promise<ContinuityVerification> {
    const verifyOnce = () => this.deps.verifyContinuity(snapshot).catch((error) => {
      this.logger.warn("[updater] continuity verification failed", error);
      return { ok: false, violations: ["verification-failed"] };
    });
    const retryDelay = asNonNegativeInteger(this.deps.recoverySessionRetryDelayMs) ?? RECOVERY_SESSION_RETRY_DELAY_MS;
    const retryAttempts = asNonNegativeInteger(this.deps.recoverySessionRetryAttempts) ?? RECOVERY_SESSION_RETRY_ATTEMPTS;
    const wait = this.deps.waitForRecoveryRetry ?? ((delayMs: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }));

    let verification = await verifyOnce();
    let lastSessionRefresh: void | RecoverySessionRefreshResult = this.deps.initialSessionRestore;
    let sawPermanentSessionRestoreFailure =
      lastSessionRefresh?.status === "missing"
      || lastSessionRefresh?.status === "expired"
      || lastSessionRefresh?.status === "invalid";
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      if (lastSessionRefresh?.status === "native-unavailable") break;
      const onlyAuthRestoreIsPending =
        !verification.ok &&
        verification.violations.length === 1 &&
        verification.violations[0] === "account-session-not-restored";
      if (!onlyAuthRestoreIsPending) break;
      await wait(retryDelay);
      try {
        lastSessionRefresh = await this.deps.refreshSessionForRecovery?.();
        if (
          lastSessionRefresh?.status === "missing"
          || lastSessionRefresh?.status === "expired"
          || lastSessionRefresh?.status === "invalid"
        ) {
          sawPermanentSessionRestoreFailure = true;
        }
      } catch (error) {
        this.logger.warn("[updater] account session recovery refresh failed", error);
      }
      verification = await verifyOnce();
    }
    const onlyUnavailableAuthRestoreIsPending =
      !verification.ok &&
      verification.violations.length === 1 &&
      verification.violations[0] === "account-session-not-restored" &&
      (lastSessionRefresh?.status === "temporarily-unavailable" || lastSessionRefresh?.status === "native-unavailable") &&
      !sawPermanentSessionRestoreFailure;
    if (onlyUnavailableAuthRestoreIsPending) {
      // The encrypted cookie still exists and every durable local-state check
      // passed. Complete only local update continuity; authentication remains
      // unavailable and native storage recovery requires explicit user action.
      // Missing/corrupt auth and every DB/agent/route violation stay fail-closed.
      const mayRetryAutomatically = lastSessionRefresh?.status === "temporarily-unavailable";
      this.logger.warn(mayRetryAutomatically
        ? "[updater] local continuity passed; temporary account restoration deferred"
        : "[updater] local continuity passed; account restoration awaits user action");
      this.deferredSessionRestoreRequested = mayRetryAutomatically;
      return { ok: true, violations: [] };
    }
    return verification;
  }

  private reconcileJournal(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileJournalOnce().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async reconcileJournalOnce(): Promise<void> {
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
    this.blockedDiagnostic = journal.diagnostic;
    this.blockedNativeInstallFailures = journal.nativeInstallFailures ?? 0;
    this.blockedRetryAfter = journal.retryAfter;
    this.recoveryBackupPath = journal.continuity?.backupPath ?? null;
    const comparison = compareSemVer(this.deps.currentVersion(), journal.targetVersion);
    if (this.installInFlight(journal)) {
      this.publish({
        status: "installing",
        version: journal.targetVersion,
        progress: 100,
        recoveryBackupAvailable: Boolean(journal.continuity && fs.existsSync(journal.continuity.backupPath)),
      });
      this.scheduleNativeInstallReconcile(journal);
      return;
    }
    if (comparison !== null && comparison >= 0) {
      // A recovery hold from any journal generation is released here: the
      // continuity gate no longer blocks installs, so an old verdict must not
      // outlive it.
      if (journal.phase === "recovery-required") {
        // CONTINUITY GATE DISABLED (owner decision, 2026-07-26). A prior
        // verdict must not keep an install held forever. The recovery copy
        // stays on disk; only the hold is released.
        this.logger.warn(
          "[updater] continuity gate disabled; releasing a prior recovery hold "
            + `(target ${journal.targetVersion}; recovery copy preserved)`,
        );
        if (!this.clearJournal()) {
          // The hold is released either way. A journal we could not delete is a
          // disk problem, not a continuity verdict, and re-raising the recovery
          // notice for it is exactly the permanent-brick behaviour this change
          // removes. The next launch retries the delete.
          this.logger.warn(
            "[updater] could not delete the install journal while releasing a "
              + "recovery hold; the hold stays released and the next launch retries",
          );
        }
        this.blockedTargetVersion = null;
        this.blockedReasonCode = "install-not-applied";
        this.blockedDiagnostic = undefined;
        this.blockedNativeInstallFailures = 0;
        this.blockedRetryAfter = undefined;
        this.publish({ status: "updated", version: journal.targetVersion });
        return;
      }
      // CONTINUITY GATE DISABLED (owner decision, 2026-07-26). The post-install
      // verification is skipped entirely; the update is never held for it.
      //
      // Why: the gate compared every protected row byte-for-byte against a
      // pre-install snapshot, so ordinary app activity failed it. On the
      // owner's machine 10/10 violations were benign — 9x
      // hub_agent_bookmarks.server_updated_at (Hub sync timestamps written
      // minutes after the snapshot) and 1x a built-in agent's system_prompt
      // reseeded by the new version. Every row count and the schema version
      // matched. The gate blocked healthy updates permanently instead of
      // catching data loss, so it is off. The recovery copy is still written at
      // install time and stays on disk for manual use.
      this.logger.log(
        `[updater] accepting ${journal.targetVersion} `
          + (journal.continuity
            ? `(recovery copy kept at ${journal.continuity.backupPath})`
            : "(installed without a recovery copy)"),
      );
      if (!this.cleanupOrBlock(journal.targetVersion, journal, { keepDifferentialBaseline: true })) {
        this.writeJournal({ ...journal, phase: "blocked", reasonCode: "legacy-cleanup-failed" });
        return;
      }
      if (!this.clearJournal()) {
        this.automaticInstallPaused = true;
        this.holdSince = this.now();
        this.blockedTargetVersion = journal.targetVersion;
        this.blockedReasonCode = "install-state-corrupt";
        this.blockedDiagnostic = undefined;
        this.blockedNativeInstallFailures = 0;
        this.blockedRetryAfter = undefined;
        if (fs.existsSync(this.journalPath())) {
          try {
            this.writeJournal({ ...journal, phase: "blocked", reasonCode: "install-state-corrupt" });
          } catch (error) {
            this.logger.warn("[updater] failed to preserve the journal cleanup block", error);
          }
        }
        this.publish(this.manualState(journal.targetVersion, "install-state-corrupt"));
        return;
      }
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.blockedDiagnostic = undefined;
      this.blockedNativeInstallFailures = 0;
      this.blockedRetryAfter = undefined;
      this.publish({ status: "updated", version: journal.targetVersion });
      return;
    }
    // Reached only after the accepted-install branch above returned: the target
    // version is NOT running, so this payload is exactly what we no longer
    // trust. Discard the baseline with it.
    if (!this.cleanupOrBlock(journal.targetVersion, journal)) {
      this.writeJournal({ ...journal, phase: "blocked", reasonCode: "legacy-cleanup-failed" });
      return;
    }
    const reasonCode = journal.reasonCode ?? "install-not-applied";
    this.blockedReasonCode = reasonCode;
    // A silent non-apply carries no native diagnostic, so nothing else would
    // ever give it a retry deadline. Stamp one here: the immediate next check
    // still refuses to re-pull the failed target, and once the backoff expires
    // the update resumes on its own instead of waiting for a manual reinstall.
    const nativeInstallFailures = (journal.nativeInstallFailures ?? 0) + (reasonCode === "install-not-applied" ? 1 : 0);
    const baseDelay = asNonNegativeInteger(this.deps.nativeInstallRetryBaseDelayMs) ?? NATIVE_INSTALL_RETRY_BASE_DELAY_MS;
    const retryAfter = reasonCode === "install-not-applied" && journal.retryAfter === undefined
      ? this.now() + Math.min(
        baseDelay * (2 ** Math.min(Math.max(0, nativeInstallFailures - 1), 16)),
        NATIVE_INSTALL_RETRY_MAX_DELAY_MS,
      )
      : journal.retryAfter;
    this.blockedNativeInstallFailures = nativeInstallFailures;
    this.blockedRetryAfter = retryAfter;
    this.writeJournal({
      ...journal,
      phase: "blocked",
      reasonCode,
      nativeInstallFailures,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
    this.publish(this.manualState(
      journal.targetVersion,
      reasonCode,
      journal.diagnostic,
      nativeInstallFailures,
      retryAfter,
    ));
  }

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (this.initialized) return Promise.resolve();
    this.initialized = true;
    this.initPromise = this.initOnce()
      .catch((error) => {
        this.initialized = false;
        throw error;
      })
      .finally(() => {
        this.initPromise = null;
      });
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
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
      this.clearTransientRetry();
      this.publish({ status: "not-available" });
    });
    this.listen("download-progress", (progress: { percent?: number }) => {
      if (!this.availableVersion || terminalStates.has(this.state.status)) return;
      const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent!))) : 0;
      this.publish({
        status: "downloading",
        version: this.availableVersion,
        progress: percent,
        releaseNotes: this.availableReleaseNotes,
      });
    });
    this.listen("update-downloaded", (info: UpdateInfoLike) => {
      const version = typeof info?.version === "string" ? info.version : this.availableVersion ?? undefined;
      if (!version || !this.isNewer(version)) {
        if (!this.cleanupOrBlock(version)) return;
        this.publish({ status: "not-available" });
        return;
      }
      this.availableVersion = version;
      this.availableReleaseNotes = normalizeReleaseNotes(info.releaseNotes) ?? this.availableReleaseNotes;
      this.clearTransientRetry();
      this.publish({
        status: "downloaded",
        version,
        progress: 100,
        releaseNotes: this.availableReleaseNotes,
        compatibility: this.state.compatibility,
      });
    });
    this.listen("error", (error: unknown) => {
      if (this.state.status === "installing") {
        this.blockInstallStart(error);
        return;
      }
      if (this.state.status === "manual-required" && this.state.code === "install-start-failed") return;
      this.logger.warn("[updater] electron-updater failed outside install handoff");
      if (this.state.status === "downloaded") return;
      this.publish(this.errorState(this.downloadPromise ? "download-failed" : "check-failed"));
      this.armTransientRetry();
    });

    await this.reconcileJournal();
    // A hold must never stop the app from looking for updates. Skipping the
    // timer here is what turned a single failed install into a permanently
    // frozen version: nothing else re-arms it. `check()` owns hold expiry, so
    // scheduling always happens and a stuck install heals on the next tick.
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
    this.nativeInstallHandedOff = false;
    this.deferredSessionRestoreRequested = false;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    if (this.transientRetryTimer) clearTimeout(this.transientRetryTimer);
    this.initialTimer = null;
    this.timer = null;
    this.transientRetryTimer = null;
    this.transientFailureCount = 0;
    if (this.nativeInstallWatchdog) clearTimeout(this.nativeInstallWatchdog);
    this.nativeInstallWatchdog = null;
    if (this.nativeInstallReconcileTimer) clearTimeout(this.nativeInstallReconcileTimer);
    this.nativeInstallReconcileTimer = null;
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
      this.publish(this.manualState(
        version,
        this.blockedReasonCode,
        this.blockedDiagnostic,
        this.blockedNativeInstallFailures,
        this.blockedRetryAfter,
      ));
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
    if (!(await this.verifyInstalledAppTrustOrBlock(version, access))) return;

    this.availableVersion = version;
    this.availableReleaseNotes = normalizeReleaseNotes(info.releaseNotes);
    this.publish({ status: "available", version, releaseNotes: this.availableReleaseNotes, compatibility });
    this.publish({ status: "downloading", version, progress: 0, releaseNotes: this.availableReleaseNotes, compatibility });
    this.downloadPromise = this.deps.updater
      .downloadUpdate()
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn("[updater] download failed", error);
        this.publish(this.errorState("download-failed"));
        this.armTransientRetry();
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    await this.downloadPromise;
  }

  check(): Promise<UpdaterState> {
    if (this.checkPromise) return this.checkPromise;
    const isNativeRetry =
      this.state.status === "manual-required" &&
      this.state.code === "install-start-failed" &&
      this.state.canRetry === true;
    const isSourceRepairRetry =
      this.state.status === "manual-required" &&
      this.state.code === "install-source-untrusted" &&
      this.state.canRetry === true;
    if (isNativeRetry) {
      if (this.state.retryAfter !== undefined && this.now() < this.state.retryAfter) {
        return Promise.resolve(this.state);
      }
      if (!this.cleanupOrBlock(this.state.version)) return Promise.resolve(this.state);
      // Preserve the recovery copy and durable retry counter in the journal,
      // while the stale native payload/state is cleared. The next check obtains
      // fresh bytes; handoff still requires a new explicit install action.
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.blockedDiagnostic = undefined;
      this.blockedNativeInstallFailures = 0;
      this.blockedRetryAfter = undefined;
      this.availableVersion = null;
      this.availableReleaseNotes = undefined;
      this.publish({ status: "idle" });
    }
    if (isSourceRepairRetry) {
      if (!this.cleanupOrBlock(this.state.version)) return Promise.resolve(this.state);
      this.automaticInstallPaused = false;
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.blockedDiagnostic = undefined;
      this.blockedNativeInstallFailures = 0;
      this.blockedRetryAfter = undefined;
      this.availableVersion = null;
      this.availableReleaseNotes = undefined;
      this.publish({ status: "idle" });
    }
    // A handoff that ended without replacing the bundle and without raising a
    // native error lands here with no diagnostic and no failure counter, so
    // neither the native-retry branch above nor the hold-expiry branch below
    // could ever reach it. That left exactly one exit: telling the user to
    // reinstall by hand, while the app re-fetched the same package on every
    // launch. Both halves are wrong. The immediate next check must NOT pull the
    // failed target again — that is the apply-loop this contract has always
    // forbidden — but the failure must still age out, because staying on an old
    // build is permanent and whatever stopped one handoff is not.
    if (this.state.status === "manual-required" && this.state.code === "install-not-applied") {
      if (this.state.retryAfter !== undefined && this.now() < this.state.retryAfter) {
        return Promise.resolve(this.state);
      }
      this.logger.log("[updater] previous install did not apply; discarding it and retrying from a clean state");
      this.clearStaleInstallArtifacts();
      this.clearJournal();
      this.automaticInstallPaused = false;
      this.holdSince = undefined;
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.blockedDiagnostic = undefined;
      this.blockedNativeInstallFailures = 0;
      this.blockedRetryAfter = undefined;
      this.availableVersion = null;
      this.availableReleaseNotes = undefined;
      this.publish({ status: "idle" });
    }
    if (this.automaticInstallPaused) {
      // Two ways out, and every hold has one. Either the specific blocker is
      // gone now, or the hold simply aged out — the conditions that break an
      // install (a busy disk, a stuck helper, a half-written journal) are
      // transient, while staying on an old build is permanent.
      const cleared = this.state.code === "legacy-cleanup-failed" && this.clearStaleInstallArtifacts();
      const expired = this.holdSince !== undefined && this.now() - this.holdSince >= HOLD_EXPIRY_MS;
      if (!cleared && !expired) return Promise.resolve(this.state);
      if (expired && !cleared) {
        this.logger.log("[updater] update hold expired; discarding it and retrying from a clean state");
        // Aged-out holds start over rather than resuming a payload whose state
        // we no longer trust; a failure to sweep must not re-arm the hold.
        this.clearStaleInstallArtifacts();
        this.clearJournal();
      }
      this.automaticInstallPaused = false;
      this.holdSince = undefined;
      this.blockedTargetVersion = null;
      this.blockedReasonCode = "install-not-applied";
      this.blockedDiagnostic = undefined;
      this.blockedNativeInstallFailures = 0;
      this.blockedRetryAfter = undefined;
      this.availableVersion = null;
      this.availableReleaseNotes = undefined;
      this.publish({ status: "idle" });
    }
    if (this.state.status === "installing" || this.state.status === "downloaded") {
      return Promise.resolve(this.state);
    }
    this.checkPromise = (async () => {
      this.publish({ status: "checking" });
      try {
        const result = await this.deps.updater.checkForUpdates();
        const info = result?.updateInfo;
        if (result?.isUpdateAvailable && info) {
          if (this.availablePromise) await this.availablePromise;
          else await this.handleUpdateAvailable(info);
        } else if (this.state.status === "checking") {
          this.publish({ status: "not-available" });
        }
        if (this.state.status !== "error") this.clearTransientRetry();
      } catch (error) {
        this.logger.warn("[updater] check failed", error);
        if (!terminalStates.has(this.state.status)) {
          this.publish(this.errorState("check-failed"));
          this.armTransientRetry();
        }
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

  /**
   * Is the payload we are about to install still the one the feed offers?
   *
   * The target version was chosen when the check ran. Between that moment and
   * the user pressing install, the release it names can be withdrawn — which is
   * exactly what happened to 1.0.31/1.0.32: they were pulled hours after
   * publication, but an app that had already downloaded one installed it
   * anyway, and the resulting build could not start, so it could not update
   * itself back out. Re-reading the feed here is one small request that turns a
   * dead end into a re-download.
   *
   * Fail-closed: an unreadable feed is not permission to proceed. Replacing the
   * app on days-old information is the risk this guard exists to remove, and
   * refusing costs the user a retry, not their installation.
   */
  private async confirmStillOffered(version: string): Promise<boolean> {
    let offered: string | null;
    try {
      offered = await this.deps.offeredVersion();
    } catch (error) {
      this.logger.warn("[updater] could not re-read the update feed before installing", error);
      offered = null;
    }
    if (offered === version) return true;

    if (offered === null) {
      this.publish(this.errorState("check-failed"));
      return false;
    }

    // The feed names a different version: the payload we hold was superseded or
    // withdrawn. Drop it and let the normal flow fetch what is offered now.
    this.logger.warn(
      `[updater] the downloaded payload (${version}) is no longer what the feed offers (${offered}); discarding it`,
    );
    this.availableVersion = null;
    this.availableReleaseNotes = undefined;
    if (!this.cleanupOrBlock(version)) return false;
    this.publish({ status: "checking" });
    void this.check();
    return false;
  }

  private async installOnce(): Promise<UpdaterActionResult> {
    const version = this.state.version;
    if (!version) return { accepted: false, state: this.state };
    // Before anything irreversible: is this still the version being offered?
    if (!(await this.confirmStillOffered(version))) {
      return { accepted: false, state: this.state };
    }
    const access = evaluateInstallAccess({ platform: this.deps.platform, execPath: this.deps.execPath, uid: this.deps.uid });
    if (!(await this.verifyInstalledAppTrustOrBlock(version, access))) {
      return { accepted: false, state: this.state };
    }

    // Writer quiescence is retired (owner decision, 2026-08-03). Its only
    // purpose was to make the continuity snapshot's row-identity hashes
    // consistent, and those hashes are no longer computed or compared by
    // anything. On a machine with live automations the drain reliably failed —
    // "Active automation did not drain before update continuity capture" — so
    // the product paid a stall and an alarming warning to tidy a fingerprint
    // nobody reads. The app is about to be replaced and restarted either way,
    // and SQLite's crash safety does not depend on us pausing writers.
    const resumeWriters: (() => void) | undefined = undefined;

    this.armInstallWriterResume(resumeWriters);
    let installHandedOff = false;
    try {
      // Best effort. A backup that cannot be taken (a busy disk, a transient
      // SQLite I/O error) must never cost the user the update itself — that
      // trade blocked four consecutive updates on a real machine. What actually
      // protects data during a schema change is the migration transaction, and
      // the previous app version is retained by the native updater.
      let continuity: ContinuitySnapshot | undefined;
      try {
        continuity = await this.deps.captureContinuity(version);
        this.recoveryBackupPath = continuity.backupPath;
      } catch (error) {
        this.logger.warn("[updater] continuity backup failed; installing without a recovery copy", error);
        this.recoveryBackupPath = null;
      }

      const journal: InstallJournal = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        continuityGateVersion: CONTINUITY_GATE_VERSION,
        phase: "install-requested",
        sourceVersion: this.deps.currentVersion(),
        targetVersion: version,
        requestedAt: new Date(this.now()).toISOString(),
        ...(() => {
          const prior = this.readJournal();
          return prior &&
            prior.sourceVersion === this.deps.currentVersion() &&
            prior.targetVersion === version &&
            prior.reasonCode === "install-start-failed"
            ? { nativeInstallFailures: prior.nativeInstallFailures ?? 0 }
            : {};
        })(),
        ...(continuity ? { continuity } : {}),
      };
      // The journal drives post-install cleanup and retry accounting. Losing it
      // costs diagnostics on the next boot, not correctness, so a write failure
      // does not cancel an install the user is already waiting for.
      try {
        this.writeJournal(journal);
      } catch (error) {
        this.logger.warn("[updater] install journal write failed; installing without it", error);
      }

      this.publish({
        status: "installing",
        version,
        progress: 100,
        compatibility: this.state.compatibility,
        recoveryBackupAvailable: Boolean(continuity),
      });
      try {
        // Windows updates must reuse the existing installation without opening
        // the NSIS setup wizard. The second flag relaunches Agentlas afterward.
        // Release immediately before native spawn. Waiting for the later
        // before-quit event races the replacement: NSIS/AppImageUpdater can
        // launch it while this process still owns Electron's instance lock.
        this.deps.releaseInstanceLockForInstall?.();
        this.nativeInstanceLockReleased = Boolean(this.deps.releaseInstanceLockForInstall);
        this.nativeInstallHandedOff = true;
        this.deps.updater.quitAndInstall(true, true);
        if (this.state.status !== "installing") {
          if (this.nativeInstanceLockReleased) {
            this.nativeInstanceLockReleased = false;
            this.deps.reacquireInstanceLockAfterInstallFailure?.();
          }
          return { accepted: false, state: this.state };
        }
        // AppImageUpdater unlinks the old image and moves the verified target
        // into its final path synchronously before this call returns. There is
        // no asynchronous installer verdict to wait for (unlike NSIS/ShipIt),
        // so the originating process can durably acknowledge that atomic
        // replacement before it quits. This also avoids depending on an
        // AppImage wrapper process reaching Electron merely to delete a marker.
        if (this.deps.platform === "linux") {
          if (!this.clearJournal()) {
            this.logger.warn("[updater] AppImage replacement completed but its install journal could not be cleared");
          } else {
            this.logger.log(`[updater] AppImage replacement for ${version} completed; install journal cleared`);
          }
        }
        installHandedOff = true;
        this.armNativeInstallWatchdog(journal);
        return { accepted: true, state: this.state };
      } catch (error) {
        return { accepted: false, state: this.blockInstallStart(error, journal) };
      }
    } finally {
      if (!installHandedOff) this.resumeInstallWriters();
    }
  }

  async openManualDownload(): Promise<UpdaterActionResult> {
    // Kept for preload ABI compatibility with older renderer bundles. Update
    // recovery is now exclusively in-app and this method never opens a URL.
    return { accepted: false, state: this.state };
  }

  /**
   * Kept for preload ABI compatibility. Updates no longer hand the user a
   * recovery copy to inspect, so this only ever succeeds if a copy happens to
   * exist and something still asks for it.
   */
  revealRecoveryBackup(): UpdaterActionResult {
    if (!this.recoveryBackupPath || !fs.existsSync(this.recoveryBackupPath)) {
      return { accepted: false, state: this.state };
    }
    this.deps.revealPath(this.recoveryBackupPath);
    return { accepted: true, state: this.state };
  }
}
