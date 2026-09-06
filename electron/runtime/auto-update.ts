// Usage 스냅샷에 설치 CLI 버전을 결합하고, 공식 최신 버전이 확인된 경우에만
// 백그라운드 업데이트한다. 실행/대기 중 작업을 절대 선점하지 않으며 업데이트 후
// 실제 버전을 다시 감지해 목표 버전 도달을 확인해야 성공으로 기록한다.
import fs from "node:fs";
import path from "node:path";
import type {
  CliRuntimeUpdateState,
  CliRuntimeVersionStatus,
  RuntimeStatus,
} from "../../shared/types";
import { compareSemVer, parseSemVer } from "../../shared/semver";
import { detectRuntimes } from "./detect";
import { clearCliVersionProbeCache, probeCliVersion } from "./exec";
import { updateCli, type InstallableCli, type ManageableCli } from "./install-cli";
import { tryAcquireRuntimeMaintenance } from "./run-slots";
import { disposeAcpSessionPool } from "./acp";
import { disposeClaudeSessionPool } from "./claude-session";
import { disposeCodexSessionPool } from "./codex-session";
import { userDataPath } from "../runtime-paths";
import { emitDesktopStoreChange } from "../store/change-bus";

const CLI_KINDS: ManageableCli[] = ["claude-code", "codex", "antigravity", "kimi", "grok"];
const PACKAGE_BY_KIND: Record<InstallableCli, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  kimi: "@moonshot-ai/kimi-code",
  grok: "@xai-official/grok",
};
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const FAILURE_RETRY_MS = 6 * 60 * 60_000;
// `agy update` is source-owned and idempotent. A transient network/feed failure
// should not leave the user on a stale CLI for six hours, while still avoiding
// a tight retry loop from usage polling.
const SOURCE_UPDATE_RETRY_MS = 15 * 60_000;
const REGISTRY_TIMEOUT_MS = 8_000;
const PERSISTED_STATE_VERSION = 2;
const STARTUP_CHECK_DELAY_MS = 8_000;

interface InternalVersionRecord extends CliRuntimeVersionStatus {
  source: string | null;
  attemptedAt: number | null;
}

interface PersistedVersionState {
  version: number;
  records: Partial<Record<ManageableCli, InternalVersionRecord>>;
}

const records = new Map<ManageableCli, InternalVersionRecord>();
let stateLoaded = false;
let cycleInFlight: Promise<void> | null = null;
let runtimeAutoUpdateStop: (() => void) | null = null;

function isManagedKind(kind: unknown): kind is ManageableCli {
  return typeof kind === "string" && CLI_KINDS.includes(kind as ManageableCli);
}

function isUpdateState(value: unknown): value is CliRuntimeUpdateState {
  return [
    "not-installed",
    "checking",
    "current",
    "update-available",
    "updating",
    "updated",
    "deferred-active-runs",
    "check-failed",
    "update-failed",
    "unverifiable",
  ].includes(String(value));
}

function stateFile(): string | null {
  const override = process.env.AGENTLAS_CLI_UPDATE_STATE_PATH?.trim();
  if (override) return path.resolve(override);
  try {
    // Dynamic require keeps pure Node regression scripts from needing a live Electron app.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (!app || typeof app.getPath !== "function") return null;
    return userDataPath("cli-auto-update.v1.json");
  } catch {
    return null;
  }
}

function loadState(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  const file = stateFile();
  if (!file) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedVersionState;
    if (![1, PERSISTED_STATE_VERSION].includes(parsed?.version) || !parsed.records || typeof parsed.records !== "object") return;
    const legacyState = parsed.version === 1;
    for (const [kind, candidate] of Object.entries(parsed.records)) {
      if (!isManagedKind(kind) || !candidate || !isUpdateState(candidate.state)) continue;
      records.set(kind, {
        kind,
        installedVersion: typeof candidate.installedVersion === "string" ? candidate.installedVersion : null,
        latestVersion: typeof candidate.latestVersion === "string" ? candidate.latestVersion : null,
        // A process cannot still be checking/updating after restart. Recheck instead of lying.
        // Version 1 also predates the Antigravity updater contract: it may contain
        // a Gemini target and an `update-failed` result produced by a non-interactive
        // invocation. Force one fresh source-owned check after this fix ships.
        state: legacyState && kind === "antigravity"
          ? "checking"
          : candidate.state === "checking" || candidate.state === "updating"
          ? "checking"
          : candidate.state,
        checkedAt: legacyState && kind === "antigravity"
          ? null
          : typeof candidate.checkedAt === "number" ? candidate.checkedAt : null,
        attemptedAt: legacyState && kind === "antigravity"
          ? null
          : typeof candidate.attemptedAt === "number" ? candidate.attemptedAt : null,
        source: typeof candidate.source === "string" ? candidate.source : null,
      });
    }
  } catch {
    // Missing/corrupt state is not converted into a fake "current" result; a fresh check runs.
  }
}

function saveState(): void {
  const file = stateFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    const payload: PersistedVersionState = {
      version: PERSISTED_STATE_VERSION,
      records: Object.fromEntries(records),
    };
    fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // Runtime update remains valid in memory; persistence is best effort and contains no secret.
  }
}

function runtimeOf(runtimes: readonly RuntimeStatus[], kind: ManageableCli): RuntimeStatus | null {
  return runtimes.find((runtime) => runtime.kind === kind) ?? null;
}

function retryDelayFor(kind: ManageableCli): number {
  return kind === "antigravity" ? SOURCE_UPDATE_RETRY_MS : FAILURE_RETRY_MS;
}

/** Antigravity is a distinct source-owned runtime with its own updater. */
export function isAntigravityRuntimeSource(source: string | null | undefined): boolean {
  return /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(String(source ?? ""));
}

export type CliVersionRelation = "current" | "outdated" | "unverifiable";

/** Exact SemVer relation. Invalid/unknown versions never fall through to an update. */
export function cliVersionRelation(installed: unknown, latest: unknown): CliVersionRelation {
  const compared = compareSemVer(installed, latest);
  if (compared === null) return "unverifiable";
  return compared < 0 ? "outdated" : "current";
}

export async function fetchLatestNpmVersion(
  packageName: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REGISTRY_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { headers: { Accept: "application/json" }, signal: controller.signal },
    );
    if (!response.ok) throw new Error(`registry status ${response.status}`);
    const raw = await response.text();
    if (raw.length > 64 * 1024) throw new Error("registry payload too large");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version !== "string" || !parseSemVer(version)) throw new Error("invalid registry version");
    return version;
  } finally {
    clearTimeout(timer);
  }
}

function publicRecord(record: InternalVersionRecord): CliRuntimeVersionStatus {
  return {
    kind: record.kind,
    installedVersion: record.installedVersion,
    latestVersion: record.latestVersion,
    state: record.state,
    checkedAt: record.checkedAt,
  };
}

function reconcileRecords(runtimes: readonly RuntimeStatus[], now: number): void {
  loadState();
  for (const kind of CLI_KINDS) {
    const runtime = runtimeOf(runtimes, kind);
    const previous = records.get(kind);
    if (!runtime) {
      records.set(kind, {
        kind,
        installedVersion: null,
        latestVersion: null,
        state: "not-installed",
        checkedAt: previous?.checkedAt ?? null,
        attemptedAt: previous?.attemptedAt ?? null,
        source: null,
      });
      continue;
    }

    const installedVersion = runtime.version && parseSemVer(runtime.version) ? runtime.version : null;
    const sourceChanged = previous?.source !== runtime.source;
    const sourceOwned = kind === "antigravity";
    // Antigravity does not have a registry "latest" version. Older builds
    // persisted the Gemini CLI target (or an older agy probe) under this slot,
    // which produced misleading arrows such as `1.1.13 -> 1.1.12` and kept a
    // stale `update-failed` state alive after the runtime had already migrated.
    // Treat a mismatched target as a one-time migration check; the updater will
    // replace it with the version measured after `agy update`.
    const sourceOwnedStateStale = sourceOwned &&
      !!installedVersion &&
      !!previous &&
      previous.latestVersion !== installedVersion;
    let state = previous?.state ?? "checking";
    let latestVersion = sourceOwned
      ? installedVersion
      : sourceChanged ? null : previous?.latestVersion ?? null;
    let checkedAt = sourceChanged || sourceOwnedStateStale ? null : previous?.checkedAt ?? null;
    let attemptedAt = sourceChanged || sourceOwnedStateStale ? null : previous?.attemptedAt ?? null;

    if (!installedVersion) {
      state = "unverifiable";
      latestVersion = null;
      checkedAt = now;
    } else if (sourceOwned) {
      if (sourceChanged || !previous || sourceOwnedStateStale) {
        state = "checking";
      } else if (previous.state === "update-failed") {
        // A source-owned updater has no registry target to compare against.
        // Once its retry cooldown expires, force a fresh `agy update` check
        // instead of accidentally turning the record into a quiet `current`.
        const retryDue = now - (previous.attemptedAt ?? 0) >= retryDelayFor(kind);
        state = retryDue ? "checking" : "update-failed";
        if (retryDue) checkedAt = null;
      } else if (previous.state === "updating" || previous.state === "checking") {
        // A process cannot still be updating after a restart; re-enter the
        // single-flight check rather than presenting a permanent spinner.
        state = "checking";
        checkedAt = null;
      } else if (previous.state === "deferred-active-runs") {
        state = "deferred-active-runs";
      } else if (previous.state === "updated") {
        state = "updated";
      } else {
        state = "current";
      }
    } else if (previous?.state === "updating") {
      state = "updating";
    } else if (
      previous?.state === "update-failed" &&
      (!latestVersion || cliVersionRelation(installedVersion, latestVersion) === "outdated") &&
      now - (previous.attemptedAt ?? 0) < FAILURE_RETRY_MS
    ) {
      // Keep the failed-attempt cooldown authoritative. Reconciliation must not turn it
      // back into update-available and retry every usage poll.
      state = "update-failed";
    } else if (latestVersion) {
      const relation = cliVersionRelation(installedVersion, latestVersion);
      state = relation === "outdated"
        ? (previous?.state === "deferred-active-runs" ? "deferred-active-runs" : "update-available")
        : relation === "current"
          ? (previous?.state === "updated" ? "updated" : "current")
          : "unverifiable";
    } else if (state !== "check-failed" || now - (checkedAt ?? 0) >= FAILURE_RETRY_MS) {
      state = "checking";
    }

    records.set(kind, {
      kind,
      installedVersion,
      latestVersion,
      state,
      checkedAt,
      attemptedAt,
      source: runtime.source,
    });
  }
}

function checkDue(record: InternalVersionRecord, now: number, kind: ManageableCli): boolean {
  if (!record.installedVersion) return false;
  if (record.state === "check-failed") return now - (record.checkedAt ?? 0) >= retryDelayFor(kind);
  if (record.state === "update-failed") return now - (record.attemptedAt ?? 0) >= retryDelayFor(kind);
  if (record.state === "unverifiable") return false;
  return record.checkedAt == null || now - record.checkedAt >= CHECK_INTERVAL_MS;
}

function updateRetryAllowed(record: InternalVersionRecord, now: number, kind: ManageableCli): boolean {
  if (record.state !== "update-failed") return true;
  return now - (record.attemptedAt ?? 0) >= retryDelayFor(kind);
}

async function verifyUpdatedRuntime(
  kind: ManageableCli,
  expectedLatest: string | null,
  expectedSource: string,
): Promise<{ installedVersion: string | null; verified: boolean }> {
  clearCliVersionProbeCache();
  const measured = await probeCliVersion(expectedSource);
  const installedVersion = measured && parseSemVer(measured) ? measured : null;
  if (!installedVersion) return { installedVersion: null, verified: false };
  if (!expectedLatest) return { installedVersion, verified: true };
  return {
    installedVersion,
    verified: cliVersionRelation(installedVersion, expectedLatest) === "current",
  };
}

async function runCycle(initialRuntimes: readonly RuntimeStatus[]): Promise<void> {
  let runtimes = [...initialRuntimes];
  for (const kind of CLI_KINDS) {
    let runtime = runtimeOf(runtimes, kind);
    let record = records.get(kind);
    if (!runtime || !record || !record.installedVersion) continue;
    const now = Date.now();
    const antigravity = kind === "antigravity";

    if (!antigravity && checkDue(record, now, kind)) {
      record.state = "checking";
      records.set(kind, record);
      try {
        record.latestVersion = await fetchLatestNpmVersion(PACKAGE_BY_KIND[kind as InstallableCli]);
        record.checkedAt = Date.now();
        const relation = cliVersionRelation(record.installedVersion, record.latestVersion);
        record.state = relation === "outdated"
          ? "update-available"
          : relation === "current"
            ? "current"
            : "unverifiable";
      } catch {
        record.state = "check-failed";
        record.checkedAt = Date.now();
        record.latestVersion = null;
        records.set(kind, record);
        saveState();
        continue;
      }
      records.set(kind, record);
      saveState();
    }

    // Antigravity owns its update feed. Run its exact source updater once per interval,
    // then treat the post-update measured version as both installed and latest.
    const sourceOwnedCheckDue = antigravity && checkDue(record, now, kind);
    const shouldUpdate = sourceOwnedCheckDue || (
      record.latestVersion != null &&
      cliVersionRelation(record.installedVersion, record.latestVersion) === "outdated" &&
      updateRetryAllowed(record, now, kind)
    );
    if (!shouldUpdate) continue;

    const releaseMaintenance = tryAcquireRuntimeMaintenance();
    if (!releaseMaintenance) {
      record.state = "deferred-active-runs";
      records.set(kind, record);
      saveState();
      continue;
    }

    try {
      record.state = "updating";
      record.attemptedAt = Date.now();
      records.set(kind, record);
      saveState();
      const beforeVersion = record.installedVersion;
      const result = await updateCli(kind, runtime.source);
      if (!result.ok) {
        record.state = "update-failed";
        if (antigravity) record.latestVersion = record.installedVersion;
        record.checkedAt = Date.now();
        records.set(kind, record);
        saveState();
        continue;
      }
      const verified = await verifyUpdatedRuntime(kind, antigravity ? null : record.latestVersion, runtime.source);
      record.installedVersion = verified.installedVersion;
      if (antigravity && verified.installedVersion) record.latestVersion = verified.installedVersion;
      record.checkedAt = Date.now();
      record.state = verified.verified
        ? (antigravity && verified.installedVersion === beforeVersion ? "current" : "updated")
        : "update-failed";
      records.set(kind, record);
      saveState();
      if (verified.verified) {
        /*
         * ★상주 세션은 자기가 뜰 때의 **바이너리**를 평생 쓴다.
         *
         * 파일을 갈아 끼워도 이미 떠 있는 ACP 에이전트는 옛 실행본 그대로 돌고, 다음 턴이
         * 그 세션을 이어 쓰면 사용자는 업데이트했는데도 옛 CLI 를 계속 쓴다 — One 소유
         * 세션은 12h 리퍼 면제라 그 상태가 영원할 수도 있다. 그래서 갱신이 검증된 순간
         * 붙든 세션을 놓는다(사용 중인 실행은 없다 — 유지보수 잠금이 그것을 보장한다).
         */
        disposeAcpSessionPool();
        // claude-code 도 같은 병을 앓는다 — 상주 CLI 는 자기가 뜰 때의 바이너리를 평생 쓴다.
        disposeClaudeSessionPool();
        // codex 상주(`codex app-server`)도 같은 병 — 갱신된 바이너리는 새 세션부터 쓴다.
        disposeCodexSessionPool();
        runtimes = await detectRuntimes();
        // 자동 업데이트도 수동 업데이트와 같은 renderer 무효화 계약을 지킨다.
        // 그렇지 않으면 화면의 runtime/listModels 스냅샷이 TTL 동안 남아 모델을
        // 다시 눌러야만 연결이 살아나는 것처럼 보인다.
        emitDesktopStoreChange({ entity: "runtime" });
      }
    } catch {
      record.state = "update-failed";
      if (antigravity) record.latestVersion = record.installedVersion;
      record.checkedAt = Date.now();
      records.set(kind, record);
      saveState();
    } finally {
      releaseMaintenance();
    }
  }
}

/**
 * 현재 상태를 즉시 반환하고 네트워크 확인/업데이트는 single-flight
 * 백그라운드로 진행해 사용량 UI와 앱 부팅을 막지 않는다.
 */
export function runtimeVersionsWithAutoUpdate(
  runtimes: readonly RuntimeStatus[],
  now = Date.now(),
): CliRuntimeVersionStatus[] {
  reconcileRecords(runtimes, now);
  saveState();
  if (process.env.AGENTLAS_DISABLE_CLI_AUTO_UPDATE !== "1" && !cycleInFlight) {
    cycleInFlight = runCycle(runtimes)
      .catch((error) => {
        // A store/maintenance probe failure must not become an unhandled
        // rejection that takes down the main process. The next scheduled or
        // renderer-triggered check reconciles the durable record again.
        console.warn("[runtime-update] cycle failed", error instanceof Error ? error.message : "unknown error");
      })
      .finally(() => {
        cycleInFlight = null;
      });
  }
  return CLI_KINDS.map((kind) => publicRecord(records.get(kind)!));
}

/**
 * Start the CLI updater from Main, not from a particular renderer card.
 * The usage panel still reports the same persisted state, but a person no
 * longer has to open Dashboard for an installed Antigravity CLI to be checked.
 */
export function startCliRuntimeAutoUpdate(): void {
  if (runtimeAutoUpdateStop || process.env.AGENTLAS_DISABLE_CLI_AUTO_UPDATE === "1") return;

  let disposed = false;
  let initialTimer: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  const run = async (): Promise<void> => {
    if (disposed) return;
    try {
      const runtimes = await detectRuntimes();
      if (!disposed) runtimeVersionsWithAutoUpdate(runtimes);
    } catch (error) {
      // A runtime probe must never make Desktop startup fail. The renderer will
      // continue to show the last safe persisted state and retry on its normal
      // usage poll.
      console.warn("[runtime-update] background check skipped", error instanceof Error ? error.message : "unknown error");
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void run();
  }, STARTUP_CHECK_DELAY_MS);
  initialTimer.unref?.();
  interval = setInterval(() => void run(), CHECK_INTERVAL_MS);
  interval.unref?.();
  runtimeAutoUpdateStop = () => {
    disposed = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (interval) clearInterval(interval);
    initialTimer = null;
    interval = null;
    runtimeAutoUpdateStop = null;
  };
}

export function stopCliRuntimeAutoUpdate(): void {
  runtimeAutoUpdateStop?.();
}
