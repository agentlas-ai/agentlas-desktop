// Desktop attaches to a persistent local agentlasd service. Its identity is the
// installation and canonical store, not whichever GUI process is currently open.
// Before GUI migrations, quiesceDaemonBeforeStoreMigration proves that an older
// service has exited. After migrations, ensureDaemonRunning attaches or starts
// the follower service. Ordinary GUI quit detaches; update/user stop is explicit.
//
// 이 모듈은 의도적으로 electron 을 import 하지 않는다 — 버전·경로를 인자로 받아
// 게이트(scripts/test-daemon-autospawn.cjs)가 순수 Node(ELECTRON_RUN_AS_NODE)에서
// 실제 스폰/스큐 시나리오를 잴 수 있다.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import {
  callControlSocket,
} from "./control-socket";
import {
  isAutostartInstalled,
  planAutostart,
  removeAutostart,
  type AutostartCommand,
} from "./autostart";
import {
  OFFICIAL_INSTALL_IDENTITY,
  serializeInstallIdentity,
  type InstallIdentity,
} from "../install-identity";
import { DaemonDiagnosticLog, type DaemonDiagnosticFields, validAppInstanceId } from "./diagnostic-log";
import { serializeRuntimeAppMetadata } from "../runtime-paths";
import {
  canonicalDaemonPath,
  daemonControlSocketPath,
  resolveDaemonServiceIdentity,
  type DaemonServiceIdentity,
  type DaemonServiceOptions,
} from "./service-identity";

export interface EnsureDaemonOptions extends DaemonServiceOptions {
  /** 앱과 데몬이 같은 DB 를 보게 하는 단일 진실 — 앱의 userData 디렉터리. */
  userDataDir: string;
  /** 앱 버전(app.getVersion()). 데몬 핑의 version 과 다르면 스큐로 판정한다. */
  appVersion: string;
  /** 데몬 진입점 js. 기본: 이 파일 옆의 main.js (dist/electron/daemon/main.js). */
  daemonEntry?: string;
  /** 데몬을 띄울 실행 파일. 기본: process.execPath (Electron 바이너리). */
  execPath?: string;
  log?: (line: string) => void;
  /** Attached GUI client. Its exit does not terminate the service. */
  parentPid?: number;
  /** The already-resolved identity of this Desktop install. */
  installIdentity?: InstallIdentity;
  /** Upper bound for the spawned helper to establish its control socket. */
  startupTimeoutMs?: number;
  /** Main-owned process instance, never a Goal progress indicator. */
  appInstanceId?: string;
  /** Legacy per-GUI diagnostic digest; never the service ownership identity. */
  expectedStoreIdentity?: string | null;
}

export type EnsureDaemonStatus =
  | { status: "disabled" }
  | { status: "already-running"; pid: number; version: string }
  | { status: "spawned"; pid: number | null; version: string }
  | { status: "respawned"; pid: number | null; previousVersion: string }
  | { status: "failed"; reason: string; mobileBridgeFallbackSafe?: boolean };

interface DaemonPing {
  ok?: boolean;
  version?: string;
  pid?: number;
  storePath?: string;
  parentPid?: number | null;
  lastHeartbeatAt?: string;
  bootId?: string;
  appInstanceId?: string | null;
  storeIdentity?: string | null;
  serviceIdentity?: string;
  serviceProtocolVersion?: number;
  storeSchemaVersion?: number;
}

function logDaemonIdentity(log: (line: string) => void, ping: DaemonPing): void {
  const appId = validAppInstanceId(ping.appInstanceId) ? ping.appInstanceId : "unbound";
  const bootId = typeof ping.bootId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ping.bootId)
    ? ping.bootId : "unavailable";
  const pid = Number.isSafeInteger(ping.pid) && Number(ping.pid) > 1 ? ping.pid : "unknown";
  log(`[daemon] control ready processRole=desktop-daemon appInstanceId=${appId} bootId=${bootId} pid=${pid}`);
}

let spawnCount = 0;
let lastExitReason: DaemonDiagnosticFields["reason"] = "unknown";

function diagnosticLog(userDataDir: string): DaemonDiagnosticLog | null {
  try { return new DaemonDiagnosticLog(userDataDir); }
  catch {
    // Diagnostics are supplementary; do not stop Desktop or echo the private path.
    console.warn("[daemon] private diagnostics unavailable");
    return null;
  }
}

function recordDiagnostic(
  log: DaemonDiagnosticLog | null,
  event: Parameters<DaemonDiagnosticLog["record"]>[0],
  fields?: DaemonDiagnosticFields,
): void {
  try { log?.record(event, fields); }
  catch { /* A log failure must not prevent daemon control. */ }
}

interface MobileBridgeLeaseReply {
  ok?: boolean;
  ownerPid?: number | null;
}

function defaultDaemonEntry(): string {
  // 컴파일 산출물 기준 이 파일은 dist/electron/daemon/app-launcher.js — 데몬 진입점은 옆.
  return path.join(__dirname, "main.js");
}

async function pingDaemon(socketPath: string, timeoutMs = 2_000): Promise<DaemonPing | null> {
  try {
    const result = await callControlSocket(socketPath, "daemon.ping", undefined, timeoutMs);
    return (result ?? null) as DaemonPing | null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hands the single Mobile Bridge listener from agentlasd to the live Desktop
 * process. A newly spawned daemon exposes its control socket before every
 * optional service is ready, so this bounded retry is also the startup handoff
 * barrier: Desktop never opens a second endpoint merely because the daemon
 * needed another few hundred milliseconds to boot.
 */
export async function claimDaemonMobileBridge(
  userDataDir: string,
  ownerPid: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return false;
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) {
    throw new Error("Mobile Bridge lease owner pid is invalid");
  }
  const socketPath = daemonControlSocketPath(userDataDir);
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  do {
    try {
      const result = (await callControlSocket(
        socketPath,
        "mobileBridge.claim",
        { ownerPid },
        Math.min(3_000, Math.max(1_000, deadline - Date.now())),
      )) as MobileBridgeLeaseReply | null;
      return result?.ok === true && result.ownerPid === ownerPid;
    } catch {
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  } while (Date.now() < deadline);
  return false;
}

/** Returns Mobile Bridge ownership during handoff, GUI quit or rollback. */
export async function releaseDaemonMobileBridge(
  userDataDir: string,
  ownerPid: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return false;
  try {
    const result = (await callControlSocket(
      daemonControlSocketPath(userDataDir),
      "mobileBridge.release",
      { ownerPid },
      timeoutMs,
    )) as MobileBridgeLeaseReply | null;
    return result?.ok === true && result.ownerPid === null;
  } catch {
    return false;
  }
}

interface SpawnedDaemon {
  child: ChildProcess;
  pid: number | null;
}

function spawnDaemonForDesktop(
  opts: EnsureDaemonOptions & DaemonServiceIdentity,
  diagnostics: DaemonDiagnosticLog | null,
  reason: "initial" | "version_skew" | "owner_mismatch",
): SpawnedDaemon {
  const entry = opts.daemonEntry ?? defaultDaemonEntry();
  if (!fs.existsSync(entry)) {
    throw new Error("daemon_entry_not_found");
  }
  const restartCount = spawnCount++;
  recordDiagnostic(diagnostics, "spawn_requested", {
    parentPid: opts.parentPid ?? process.pid, restartCount, reason,
    appInstanceId: opts.appInstanceId,
  });
  const child = spawn(opts.execPath ?? process.execPath, [entry], {
    detached: true,
    // Raw runtime output can contain private tool arguments. The service writes
    // structured lifecycle diagnostics itself; no pipe depends on the GUI.
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AGENTLAS_USER_DATA: opts.userDataDir,
      AGENTLAS_STORE_PATH: opts.storePath,
      AGENTLAS_DAEMON_SERVICE_IDENTITY: opts.serviceIdentity,
      AGENTLAS_RUNTIME_APP_METADATA: serializeRuntimeAppMetadata(opts.appVersion),
      // The headless child cannot read the packaged app marker itself. Pass
      // the identity resolved by Desktop so it can configure protected storage
      // before opening the shared store.
      AGENTLAS_INSTALL_IDENTITY: serializeInstallIdentity(
        opts.installIdentity ?? OFFICIAL_INSTALL_IDENTITY,
      ),
      // 사다리는 앱이 이미 돌렸다. 데몬은 절대 두 번째 마이그레이션 주인이 되지 않는다.
      AGENTLAS_STORE_MIGRATION_ROLE: "follower",
      AGENTLAS_DESKTOP_PARENT_PID: String(opts.parentPid ?? process.pid),
      AGENTLAS_DAEMON_RESTART_COUNT: String(restartCount),
      AGENTLAS_DAEMON_LAST_EXIT_REASON: lastExitReason ?? "unknown",
      AGENTLAS_APP_INSTANCE_ID: validAppInstanceId(opts.appInstanceId) ? opts.appInstanceId : "",
      AGENTLAS_EXPECTED_STORE_IDENTITY: opts.expectedStoreIdentity ?? "",
    },
  });
  const pid = child.pid ?? null;
  (opts.log ?? console.log)(`[daemon] spawn requested pid=${pid ?? "?"} parent=${opts.parentPid ?? process.pid}`);
  child.once("exit", (exitCode, signal) => {
    lastExitReason = signal ? "signal" : exitCode === 0 ? "exited" : "error";
    recordDiagnostic(diagnostics, "spawn_exit", { pid, exitCode, signal, reason: lastExitReason,
      appInstanceId: opts.appInstanceId });
    (opts.log ?? console.log)(`[daemon] child exited pid=${pid ?? "?"} reason=${lastExitReason}`);
  });
  child.once("error", () => {
    lastExitReason = "error";
    recordDiagnostic(diagnostics, "spawn_error", { pid, reason: "error", appInstanceId: opts.appInstanceId });
  });
  // The control socket remains the graceful service-control channel after the
  // GUI process exits. The detached child owns its own event loop and logs.
  child.unref();
  return { child, pid };
}

/**
 * A spawn acknowledgement is not a readiness acknowledgement. In a packaged
 * app the helper can fail before it creates the control socket (for example a
 * stale bundle missing a runtime dependency). Waiting for the Mobile Bridge
 * lease in that case makes Desktop look frozen for the full lease timeout.
 * Observe the child during the normal socket probe so an early exit becomes a
 * failed startup immediately; a healthy helper still follows the existing
 * asynchronous handoff path.
 */
async function waitForSpawnedDaemonReadiness(
  spawned: SpawnedDaemon,
  socketPath: string,
  diagnostics: DaemonDiagnosticLog | null,
  timeoutMs = 30_000,
  expectedServiceIdentity?: string,
  appInstanceId?: string,
  lifecycleLog?: (line: string) => void,
): Promise<"ready" | "exited" | "timeout" | "store_mismatch"> {
  let exited = spawned.child.exitCode !== null || spawned.child.signalCode !== null;
  const markExited = () => { exited = true; };
  spawned.child.once("exit", markExited);
  spawned.child.once("error", markExited);
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  try {
    while (Date.now() < deadline) {
      if (exited || spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
        return "exited";
      }
      const ping = await pingDaemon(socketPath, Math.min(800, Math.max(250, deadline - Date.now())));
      if (ping?.ok && ping.pid === spawned.pid) {
        if (expectedServiceIdentity && ping.serviceIdentity !== expectedServiceIdentity) return "store_mismatch";
        const heartbeatAgeMs = ping.lastHeartbeatAt
          ? Math.max(0, Date.now() - Date.parse(ping.lastHeartbeatAt)) : undefined;
        recordDiagnostic(diagnostics, "spawn_ready", { pid: spawned.pid, heartbeatAgeMs,
          bootId: ping.bootId, appInstanceId: ping.appInstanceId });
        if (lifecycleLog) logDaemonIdentity(lifecycleLog, ping);
        return "ready";
      }
      if (exited || spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
        return "exited";
      }
      await sleep(100);
    }
    return "timeout";
  } finally {
    spawned.child.removeListener("exit", markExited);
    spawned.child.removeListener("error", markExited);
  }
}

/** A failed ping can mean a live server with a broken optional service. Only
 * connection refusal/absence proves that no helper owns the socket. */
async function controlSocketIsAbsent(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (absent: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(absent);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED"));
  });
}

/** A timed-out helper may still finish booting later. Stop our exact child and
 * prove its exit before allowing Desktop to open a fallback listener. */
async function stopUnreadyDaemon(spawned: SpawnedDaemon): Promise<boolean> {
  const exited = () => spawned.child.exitCode !== null || spawned.child.signalCode !== null;
  if (exited()) return true;
  spawned.child.kill("SIGTERM");
  for (let attempt = 0; attempt < 90 && !exited(); attempt += 1) await sleep(100);
  if (!exited()) {
    spawned.child.kill("SIGKILL");
    for (let attempt = 0; attempt < 20 && !exited(); attempt += 1) await sleep(100);
  }
  return exited();
}

function matchesService(ping: DaemonPing, identity: DaemonServiceIdentity): boolean {
  if (ping.serviceIdentity) return ping.serviceIdentity === identity.serviceIdentity;
  // One-time compatibility with the old parent-bound helper, which reported
  // its opened store but had no service identity. Never replace a foreign DB.
  try { return Boolean(ping.storePath && canonicalDaemonPath(ping.storePath) === identity.storePath); }
  catch { return false; }
}

function serviceControlGuard(ping: DaemonPing): Record<string, unknown> {
  return ping.serviceIdentity
    ? { serviceIdentity: ping.serviceIdentity, bootId: ping.bootId }
    : { parentPid: ping.parentPid };
}

function processHasExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function anotherDesktopIsAttached(ping: DaemonPing, requestingPid = process.pid): boolean {
  const attachedPid = Number(ping.parentPid);
  // Stopping a daemon does not stop a still-running older GUI writer. Require
  // that client to exit before version replacement or schema migration; never
  // terminate a GUI process for which this launcher has no child handle.
  return Number.isSafeInteger(attachedPid) && attachedPid > 1
    && attachedPid !== requestingPid && !processHasExited(attachedPid);
}

async function stopObservedDaemon(socketPath: string, ping: DaemonPing, timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(ping.pid) || Number(ping.pid) <= 1) return false;
  const pid = Number(ping.pid);
  try { await callControlSocket(socketPath, "daemon.shutdown", serviceControlGuard(ping), 3_000); }
  catch { /* A closed response alone does not prove the process exited. */ }
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    if (processHasExited(pid) && await controlSocketIsAbsent(socketPath)) return true;
    await sleep(100);
  }
  return false;
}

async function attachDesktop(socketPath: string, ping: DaemonPing, opts: EnsureDaemonOptions): Promise<void> {
  await callControlSocket(socketPath, "daemon.attach", {
    ...serviceControlGuard(ping),
    parentPid: opts.parentPid ?? process.pid,
    appInstanceId: opts.appInstanceId ?? null,
    expectedStoreIdentity: opts.expectedStoreIdentity ?? null,
  }, 3_000);
}

/** Attach to the same service across GUI restarts, or start its follower after
 * the GUI has completed migration. Version replacement drains the old process. */
export async function ensureDaemonRunning(options: EnsureDaemonOptions): Promise<EnsureDaemonStatus> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return { status: "disabled" };
  const log = options.log ?? console.log;
  const diagnostics = diagnosticLog(options.userDataDir);
  try {
    const opts = { ...options, ...resolveDaemonServiceIdentity(options) };
    const socketPath = daemonControlSocketPath(opts.userDataDir);
    const ping = await pingDaemon(socketPath);
    let previousVersion: string | null = null;
    if (ping?.ok) {
      if (!matchesService(ping, opts)) return { status: "failed", reason: "daemon_service_identity_mismatch" };
      if (ping.version === opts.appVersion && ping.serviceProtocolVersion === 2) {
        await attachDesktop(socketPath, ping, opts);
        recordDiagnostic(diagnostics, "already_running", { pid: ping.pid, bootId: ping.bootId,
          parentPid: opts.parentPid ?? process.pid, appInstanceId: opts.appInstanceId });
        logDaemonIdentity(log, ping);
        return { status: "already-running", pid: ping.pid ?? -1, version: ping.version };
      }
      if (anotherDesktopIsAttached(ping, opts.parentPid ?? process.pid)) {
        return { status: "failed", reason: "daemon_attached_desktop_alive" };
      }
      previousVersion = ping.version ?? "0.0.0";
      recordDiagnostic(diagnostics, "version_skew", { pid: ping.pid });
      if (!await stopObservedDaemon(socketPath, ping, 25_000)) {
        return { status: "failed", reason: "old_daemon_shutdown_timeout" };
      }
      lastExitReason = "version_skew";
    } else if (!await controlSocketIsAbsent(socketPath)) {
      return { status: "failed", reason: "daemon_control_owner_unconfirmed" };
    }

    const spawned = spawnDaemonForDesktop(opts, diagnostics, previousVersion ? "version_skew" : "initial");
    const readiness = await waitForSpawnedDaemonReadiness(spawned, socketPath, diagnostics,
      opts.startupTimeoutMs, opts.serviceIdentity, opts.appInstanceId, log);
    if (readiness !== "ready") {
      const stopped = await stopUnreadyDaemon(spawned);
      // Another GUI may have won publication during our spawn. Reuse that
      // exact service; never stop a process for which we have no child handle.
      const winner = await pingDaemon(socketPath);
      if (winner?.ok && matchesService(winner, opts) && winner.version === opts.appVersion
        && winner.serviceProtocolVersion === 2) {
        await attachDesktop(socketPath, winner, opts);
        return { status: "already-running", pid: winner.pid ?? -1, version: winner.version };
      }
      recordDiagnostic(diagnostics, "spawn_unready", { pid: spawned.pid,
        reason: readiness === "store_mismatch" ? "error" : readiness });
      return { status: "failed", reason: `daemon_${readiness}_before_control_ready`,
        mobileBridgeFallbackSafe: stopped && await controlSocketIsAbsent(socketPath) };
    }
    const ready = await pingDaemon(socketPath);
    if (!ready?.ok || ready.pid !== spawned.pid || ready.version !== opts.appVersion || !matchesService(ready, opts)) {
      await stopUnreadyDaemon(spawned);
      return { status: "failed", reason: "daemon_ready_identity_changed" };
    }
    await attachDesktop(socketPath, ready, opts);
    return previousVersion
      ? { status: "respawned", pid: spawned.pid, previousVersion }
      : { status: "spawned", pid: spawned.pid, version: opts.appVersion };
  } catch {
    recordDiagnostic(diagnostics, "spawn_error", { reason: "error" });
    return { status: "failed", reason: "daemon_launcher_failed" };
  }
}

export type DaemonMigrationQuiescence =
  | { status: "absent" | "compatible" | "stopped"; pid: number | null }
  | { status: "failed"; reason: string; pid: number | null };

/** MUST run before initStore/migration. Socket disappearance is insufficient:
 * stopObservedDaemon also proves the old writer process exited. */
export async function quiesceDaemonBeforeStoreMigration(
  options: DaemonServiceOptions & { appVersion: string; requiredSchemaVersion: number; timeoutMs?: number },
): Promise<DaemonMigrationQuiescence> {
  try {
    const identity = resolveDaemonServiceIdentity(options);
    const socketPath = daemonControlSocketPath(identity.userDataDir);
    const ping = await pingDaemon(socketPath);
    if (!ping?.ok) return await controlSocketIsAbsent(socketPath)
      ? { status: "absent", pid: null }
      : { status: "failed", reason: "daemon_control_owner_unconfirmed", pid: null };
    if (!matchesService(ping, identity)) return { status: "failed", reason: "daemon_service_identity_mismatch", pid: ping.pid ?? null };
    if (ping.serviceProtocolVersion === 2 && ping.version === options.appVersion
      && ping.storeSchemaVersion === options.requiredSchemaVersion) return { status: "compatible", pid: ping.pid ?? null };
    if (anotherDesktopIsAttached(ping)) return { status: "failed", reason: "daemon_attached_desktop_alive", pid: ping.pid ?? null };
    return await stopObservedDaemon(socketPath, ping, options.timeoutMs ?? 25_000)
      ? { status: "stopped", pid: ping.pid ?? null }
      : { status: "failed", reason: "daemon_migration_quiescence_timeout", pid: ping.pid ?? null };
  } catch { return { status: "failed", reason: "daemon_migration_quiescence_failed", pid: null }; }
}

/** Explicit service stop for update or user request, independent of GUI PID. */
export async function stopDaemonService(options: DaemonServiceOptions, timeoutMs = 25_000): Promise<{ stopped: boolean; pid: number | null }> {
  const identity = resolveDaemonServiceIdentity(options);
  const socketPath = daemonControlSocketPath(identity.userDataDir);
  const ping = await pingDaemon(socketPath);
  if (!ping?.ok) return { stopped: await controlSocketIsAbsent(socketPath), pid: null };
  if (!matchesService(ping, identity)) throw new Error("daemon_service_identity_mismatch");
  return { stopped: await stopObservedDaemon(socketPath, ping, timeoutMs), pid: ping.pid ?? null };
}

/** Ordinary GUI quit releases its attachment, leaving autonomous work alive. */
export async function detachDaemonDesktop(userDataDir: string, parentPid: number): Promise<boolean> {
  const socketPath = daemonControlSocketPath(userDataDir);
  const ping = await pingDaemon(socketPath);
  if (!ping?.ok) return await controlSocketIsAbsent(socketPath);
  if (ping.serviceProtocolVersion !== 2) return false;
  const reply = await callControlSocket(socketPath, "daemon.detach", { ...serviceControlGuard(ping), parentPid }, 3_000) as { ok?: boolean };
  return reply?.ok === true;
}

/**
 * Explicitly release idle residency during service maintenance. GUI quit must
 * only detach, since daemon-owned autonomous work may still be running.
 */
export async function releaseDaemonAgentResidency(
  userDataDir: string,
  timeoutMs = 3_000,
): Promise<{ released: number } | null> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return null;
  try {
    const result = (await callControlSocket(
      daemonControlSocketPath(userDataDir),
      "agents.releaseResidency",
      undefined,
      timeoutMs,
    )) as { released?: number } | null;
    return { released: Number(result?.released ?? 0) };
  } catch {
    return null;
  }
}

/** Legacy explicit stop entrypoint, retained for callers bound to a GUI PID. */
export async function shutdownDaemon(
  userDataDir: string,
  expectedParentPid: number,
  timeoutMs = 10_000,
): Promise<{ stopped: boolean; pid: number | null }> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return { stopped: true, pid: null };
  const socketPath = daemonControlSocketPath(userDataDir);
  const diagnostics = diagnosticLog(userDataDir);
  const ping = await pingDaemon(socketPath, Math.min(timeoutMs, 2_000));
  if (!ping?.ok) return { stopped: await controlSocketIsAbsent(socketPath), pid: null };
  if (ping.parentPid !== expectedParentPid) {
    throw new Error(`daemon_owner_mismatch:${ping.parentPid ?? "none"}`);
  }
  const pid = Number.isSafeInteger(ping.pid) && Number(ping.pid) > 1 ? Number(ping.pid) : null;
  recordDiagnostic(diagnostics, "shutdown_requested", { pid, parentPid: expectedParentPid });
  const stopped = await stopObservedDaemon(socketPath, ping, timeoutMs);
  if (!stopped) recordDiagnostic(diagnostics, "shutdown_timeout", { pid, reason: "timeout" });
  return { stopped, pid };
}

/**
 * 자동 시작(로그인 시 데몬 기동) 설정을 파일시스템과 정합시킨다.
 *
 * 기본은 **off** — 사용자 머신의 부팅 동작은 명시적 선택 없이는 바꾸지 않는다.
 * store 의 daemon_autostart(electron/store/daemon-autostart.ts)가 켜져 있을 때만
 * 설치하고, 꺼져 있는데 우리 파일이 남아 있으면 걷는다(설정과 부팅 동작이 어긋난 채
 * 남는 것이 최악이다). 설정 UI 토글은 아직 없다 — store 함수가 그 자리다.
 */
export function reconcileDaemonAutostart(
  _enabled: boolean,
  command: AutostartCommand,
  runtime?: { platform?: NodeJS.Platform; home?: string },
): { installed: boolean; changed: boolean } {
  const plan = planAutostart(command, runtime?.platform, runtime?.home);
  const already = isAutostartInstalled(plan);
  // These legacy login definitions omit the installation/store identity needed
  // by a persistent service. Supervised autostart uses a separate integration;
  // never reactivate a stale definition against a guessed production store.
  if (already) {
    removeAutostart(plan);
    return { installed: false, changed: true };
  }
  return { installed: false, changed: false };
}
