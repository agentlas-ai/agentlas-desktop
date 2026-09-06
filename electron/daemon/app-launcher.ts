// 앱 → 내부 호스트 기동. 이름은 기존 제어면 호환을 위해 agentlasd를 유지하지만,
// 수명은 Desktop 프로세스에 종속된다.
//
// ★수명 계약:
//  - 앱이 뜨면 제어 소켓에 daemon.ping 을 시도한다. 응답이 없으면 내부 호스트를
//    띄우고 Desktop 부모 PID를 넘긴다. 앱이 정상 종료하면 RPC로 내리고, 앱이
//    크래시하면 내부 호스트의 부모 감시기가 스스로 종료한다.
//  - 버전 스큐: 핑이 응답했는데 버전이 앱과 다르면(업데이트 직후의 옛 바이너리)
//    daemon.shutdown 을 부탁해 정중히 내려보내고 새 바이너리로 재스폰한다.
//  - 마이그레이션 권위: 이 함수는 **앱이 initStore() 로 사다리를 다 돌린 뒤**에만
//    불러야 한다(main.ts 배선 참조). 데몬은 AGENTLAS_STORE_MIGRATION_ROLE=follower 로
//    띄운다 — 스키마가 이미 맞으므로 follower 로 그냥 열리고, 만에 하나 어긋나 있으면
//    승급을 시도하는 대신 정직하게 거절한다(store/db.ts 의 owner/follower 계약).
//    앱과 데몬이 동시에 사다리를 돌려 DB 를 태우는 조합이 원천적으로 없다.
//
// 이 모듈은 의도적으로 electron 을 import 하지 않는다 — 버전·경로를 인자로 받아
// 게이트(scripts/test-daemon-autospawn.cjs)가 순수 Node(ELECTRON_RUN_AS_NODE)에서
// 실제 스폰/스큐 시나리오를 잴 수 있다.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  callControlSocket,
  defaultControlSocketPath,
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

export interface EnsureDaemonOptions {
  /** 앱과 데몬이 같은 DB 를 보게 하는 단일 진실 — 앱의 userData 디렉터리. */
  userDataDir: string;
  /** 앱 버전(app.getVersion()). 데몬 핑의 version 과 다르면 스큐로 판정한다. */
  appVersion: string;
  /** 데몬 진입점 js. 기본: 이 파일 옆의 main.js (dist/electron/daemon/main.js). */
  daemonEntry?: string;
  /** 데몬을 띄울 실행 파일. 기본: process.execPath (Electron 바이너리). */
  execPath?: string;
  log?: (line: string) => void;
  /** Desktop owner. The helper exits when this process is no longer alive. */
  parentPid?: number;
  /** The already-resolved identity of this Desktop install. */
  installIdentity?: InstallIdentity;
}

export type EnsureDaemonStatus =
  | { status: "disabled" }
  | { status: "already-running"; pid: number; version: string }
  | { status: "spawned"; pid: number | null; version: string }
  | { status: "respawned"; pid: number | null; previousVersion: string }
  | { status: "failed"; reason: string };

interface DaemonPing {
  ok?: boolean;
  version?: string;
  pid?: number;
  storePath?: string;
  parentPid?: number | null;
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
  const socketPath = defaultControlSocketPath(userDataDir);
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

/** Returns Mobile Bridge ownership during an in-app handoff or startup rollback.
 * Full app shutdown calls shutdownDaemon instead; no listener survives exit. */
export async function releaseDaemonMobileBridge(
  userDataDir: string,
  ownerPid: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return false;
  try {
    const result = (await callControlSocket(
      defaultControlSocketPath(userDataDir),
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

function spawnDaemonForDesktop(opts: EnsureDaemonOptions): SpawnedDaemon {
  const entry = opts.daemonEntry ?? defaultDaemonEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`daemon entry not found: ${entry}`);
  }
  const child = spawn(opts.execPath ?? process.execPath, [entry], {
    detached: false,
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AGENTLAS_USER_DATA: opts.userDataDir,
      // The headless child cannot read the packaged app marker itself. Pass
      // the identity resolved by Desktop so it can configure protected storage
      // before opening the shared store.
      AGENTLAS_INSTALL_IDENTITY: serializeInstallIdentity(
        opts.installIdentity ?? OFFICIAL_INSTALL_IDENTITY,
      ),
      // 사다리는 앱이 이미 돌렸다. 데몬은 절대 두 번째 마이그레이션 주인이 되지 않는다.
      AGENTLAS_STORE_MIGRATION_ROLE: "follower",
      AGENTLAS_DESKTOP_PARENT_PID: String(opts.parentPid ?? process.pid),
    },
  });
  // The control socket is the graceful owner channel. unref keeps startup from
  // blocking, while the helper's parent watchdog enforces the crash path.
  child.unref();
  return { child, pid: child.pid ?? null };
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
  timeoutMs = 30_000,
): Promise<"ready" | "exited" | "timeout"> {
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
      if (ping?.ok) return "ready";
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

/**
 * 데몬이 떠 있게 만든다(있으면 그대로, 스큐면 교체, 없으면 스폰).
 * 실패는 앱 기능을 막지 않는다 — 데몬 없는 앱은 예전과 똑같이 동작하므로,
 * 호출자는 결과를 로그만 하고 지나간다.
 */
export async function ensureDaemonRunning(opts: EnsureDaemonOptions): Promise<EnsureDaemonStatus> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return { status: "disabled" };
  const socketPath = defaultControlSocketPath(opts.userDataDir);

  try {
    const ping = await pingDaemon(socketPath);
    if (ping?.ok) {
      const daemonVersion = ping.version ?? "0.0.0";
      const expectedParentPid = opts.parentPid ?? process.pid;
      if (daemonVersion === opts.appVersion && ping.parentPid === expectedParentPid) {
        return { status: "already-running", pid: ping.pid ?? -1, version: daemonVersion };
      }
      // 버전 스큐 — 옛 데몬을 정중히 내려보내고 재스폰한다. 강제 kill 은 마지막 수단도
      // 아니다: PID 를 모르는 채 소켓만 아는 상태라, 부탁이 안 통하면 그냥 두고 보고한다
      // (다음 앱 실행이 다시 시도한다. 옛 데몬이 계속 돌더라도 스키마는 follower 라 안전).
      log(`[daemon] version skew (daemon ${daemonVersion} vs app ${opts.appVersion}) — asking it to shut down`);
      try {
        // The daemon is owner-bound. Reuse the parent pid reported by the
        // ping so its shutdown authorization is explicit; an unparameterized
        // RPC is rejected by the same owner check used during Desktop quit.
        const shutdownParams = Number.isSafeInteger(ping.parentPid) && Number(ping.parentPid) > 1
          ? { parentPid: Number(ping.parentPid) }
          : undefined;
        await callControlSocket(socketPath, "daemon.shutdown", shutdownParams, 3_000);
      } catch {
        /* 응답 전에 소켓이 닫히는 것도 정상 종료의 모양이다 */
      }
      // 소켓이 실제로 죽을 때까지 기다린다(최대 ~10s). 살아 있는 채 스폰하면
      // 새 데몬이 "another daemon is already listening" 으로 못 뜬다.
      let gone = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(500);
        if (!(await pingDaemon(socketPath, 800))) { gone = true; break; }
      }
      if (!gone) {
        return { status: "failed", reason: `old daemon (v${daemonVersion}) did not shut down` };
      }
      const spawned = spawnDaemonForDesktop(opts);
      const readiness = await waitForSpawnedDaemonReadiness(spawned, socketPath);
      if (readiness === "exited") {
        return {
          status: "failed",
          reason: `daemon exited before control socket became ready (pid ${spawned.pid ?? "?"})`,
        };
      }
      log(`[daemon] respawned v${opts.appVersion} (pid ${spawned.pid ?? "?"})`);
      return { status: "respawned", pid: spawned.pid, previousVersion: daemonVersion };
    }

    const spawned = spawnDaemonForDesktop(opts);
    const pid = spawned.pid;
    const readiness = await waitForSpawnedDaemonReadiness(
      spawned,
      socketPath,
    );
    if (readiness === "exited") {
      return {
        status: "failed",
        reason: `daemon exited before control socket became ready (pid ${pid ?? "?"})`,
      };
    }
    log(`[daemon] spawned v${opts.appVersion} (pid ${pid ?? "?"})`);
    return { status: "spawned", pid, version: opts.appVersion };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 앱이 나가거나 업데이트 교체를 시작할 때 헬퍼의 상주 CLI를 먼저 놓게 한다.
 * 최종 종료는 shutdownDaemon이 담당하며 헬퍼 자체도 Desktop과 함께 끝난다.
 */
export async function releaseDaemonAgentResidency(
  userDataDir: string,
  timeoutMs = 3_000,
): Promise<{ released: number } | null> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return null;
  try {
    const result = (await callControlSocket(
      defaultControlSocketPath(userDataDir),
      "agents.releaseResidency",
      undefined,
      timeoutMs,
    )) as { released?: number } | null;
    return { released: Number(result?.released ?? 0) };
  } catch {
    return null;
  }
}

/** Stop the exact helper bound to this Desktop instance. */
export async function shutdownDaemon(
  userDataDir: string,
  expectedParentPid: number,
  timeoutMs = 10_000,
): Promise<{ stopped: boolean; pid: number | null }> {
  if (process.env.AGENTLAS_DISABLE_DAEMON === "1") return { stopped: true, pid: null };
  const socketPath = defaultControlSocketPath(userDataDir);
  const ping = await pingDaemon(socketPath, Math.min(timeoutMs, 2_000));
  if (!ping?.ok) return { stopped: true, pid: null };
  if (ping.parentPid !== expectedParentPid) {
    throw new Error(`daemon_owner_mismatch:${ping.parentPid ?? "none"}`);
  }
  const pid = Number.isSafeInteger(ping.pid) && Number(ping.pid) > 1 ? Number(ping.pid) : null;
  try {
    await callControlSocket(socketPath, "daemon.shutdown", { parentPid: expectedParentPid }, 3_000);
  } catch {
    // Closing the socket before the reply is a valid graceful-shutdown shape.
  }
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const current = await pingDaemon(socketPath, 500);
    if (!current?.ok) return { stopped: true, pid };
    await sleep(100);
  }
  return { stopped: false, pid };
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
  // Desktop local work is deliberately app-scoped. Remove legacy login items
  // even if an older build stored the preference as enabled.
  if (already) {
    removeAutostart(plan);
    return { installed: false, changed: true };
  }
  return { installed: false, changed: false };
}
