// 앱 → 데몬 자동 기동 (Phase 2 의 "앱이 켜지면 데몬을 찾고, 없으면 자기가 띄운다").
//
// ★수명 계약:
//  - 앱이 뜨면 제어 소켓에 daemon.ping 을 시도한다. 응답이 없으면 데몬을
//    **detached 자식**으로 스폰하고 unref 한다 — 앱이 꺼져도 데몬은 산다
//    (그게 데몬의 존재 이유다). exec.ts 의 trackRunChild/host-lifecycle 에는
//    절대 등록하지 않는다 — 등록하는 순간 앱 종료가 데몬을 죽인다.
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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  callControlSocket,
  defaultControlSocketPath,
} from "./control-socket";
import {
  installAutostart,
  isAutostartInstalled,
  planAutostart,
  removeAutostart,
  type AutostartCommand,
} from "./autostart";

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

function spawnDaemonDetached(opts: EnsureDaemonOptions): number | null {
  const entry = opts.daemonEntry ?? defaultDaemonEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`daemon entry not found: ${entry}`);
  }
  const child = spawn(opts.execPath ?? process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AGENTLAS_USER_DATA: opts.userDataDir,
      // 사다리는 앱이 이미 돌렸다. 데몬은 절대 두 번째 마이그레이션 주인이 되지 않는다.
      AGENTLAS_STORE_MIGRATION_ROLE: "follower",
    },
  });
  // 앱의 이벤트 루프/종료와 완전히 분리한다 — 앱이 꺼져도 데몬은 남는다.
  child.unref();
  return child.pid ?? null;
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
      if (daemonVersion === opts.appVersion) {
        return { status: "already-running", pid: ping.pid ?? -1, version: daemonVersion };
      }
      // 버전 스큐 — 옛 데몬을 정중히 내려보내고 재스폰한다. 강제 kill 은 마지막 수단도
      // 아니다: PID 를 모르는 채 소켓만 아는 상태라, 부탁이 안 통하면 그냥 두고 보고한다
      // (다음 앱 실행이 다시 시도한다. 옛 데몬이 계속 돌더라도 스키마는 follower 라 안전).
      log(`[daemon] version skew (daemon ${daemonVersion} vs app ${opts.appVersion}) — asking it to shut down`);
      try {
        await callControlSocket(socketPath, "daemon.shutdown", undefined, 3_000);
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
      const pid = spawnDaemonDetached(opts);
      log(`[daemon] respawned v${opts.appVersion} (pid ${pid ?? "?"})`);
      return { status: "respawned", pid, previousVersion: daemonVersion };
    }

    const pid = spawnDaemonDetached(opts);
    log(`[daemon] spawned v${opts.appVersion} (pid ${pid ?? "?"})`);
    return { status: "spawned", pid, version: opts.appVersion };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 앱이 나갈 때 **데몬이 붙든 상주 CLI 를 놓게** 한다(오너 규칙 2026-08-20:
 * "상주는 앱이 켜져 있는 동안"). 데몬 자신은 죽이지 않는다 — 예약 자동화는 계속
 * 돌아야 한다. 데몬이 없거나 옛 바이너리라 이 메서드를 모르면 조용히 지나간다:
 * 상주가 없는 상태가 예전과 똑같은 정상 동작이므로 앱 종료를 막을 이유가 없다.
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

/**
 * 자동 시작(로그인 시 데몬 기동) 설정을 파일시스템과 정합시킨다.
 *
 * 기본은 **off** — 사용자 머신의 부팅 동작은 명시적 선택 없이는 바꾸지 않는다.
 * store 의 daemon_autostart(electron/store/daemon-autostart.ts)가 켜져 있을 때만
 * 설치하고, 꺼져 있는데 우리 파일이 남아 있으면 걷는다(설정과 부팅 동작이 어긋난 채
 * 남는 것이 최악이다). 설정 UI 토글은 아직 없다 — store 함수가 그 자리다.
 */
export function reconcileDaemonAutostart(
  enabled: boolean,
  command: AutostartCommand,
): { installed: boolean; changed: boolean } {
  const plan = planAutostart(command);
  const already = isAutostartInstalled(plan);
  if (enabled) {
    // 멱등 덮어쓰기 — 앱 경로가 바뀌었을 수 있다(업데이트/이동).
    installAutostart(plan);
    return { installed: true, changed: !already };
  }
  if (already) {
    removeAutostart(plan);
    return { installed: false, changed: true };
  }
  return { installed: false, changed: false };
}
