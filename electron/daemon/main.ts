// `agentlasd` — Agentlas Desktop이 켜져 있는 동안만 함께 도는 내부 호스트 헬퍼.
// 이름은 기존 제어면 호환을 위해 유지하지만 독립 제품이나 OS 서비스가 아니다.
// Desktop 부모 PID를 필수로 받고, 정상 종료·크래시 어느 쪽이든 부모가 끝나면
// 제어 소켓, 모바일 브리지, 로컬 자식 프로세스를 정리한 뒤 함께 종료한다.
//
// ★실행 방법 — **Electron 의 node 로 돈다**(GUI 없음):
//     ELECTRON_RUN_AS_NODE=1 electron dist/electron/daemon/main.js
//
//   순수 `node` 로 돌리면 첫 DB 접근에서 죽는다(실측 2026-08-19):
//     better_sqlite3.node was compiled against NODE_MODULE_VERSION 148,
//     this version of Node.js requires NODE_MODULE_VERSION 141
//   네이티브 모듈이 Electron ABI 로 빌드돼 있기 때문이다. 기획서가 "Electron ABI 결합"
//   으로 적어 둔 비용이 바로 이것이고, 데몬이 그걸 없애 주지는 않는다 — 다만
//   `ELECTRON_RUN_AS_NODE` 는 창도 app 객체도 없는 순수 Node 런타임이므로,
//   "GUI 없이 돈다" 는 목표는 그대로 달성된다(app 이 없으니 위 주입 경로가 쓰인다).
//   네이티브 모듈을 두 ABI 로 빌드하는 것은 별건이고, 그 전까지 이 명령이 정본이다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHostShutdownHooks } from "../host-lifecycle";
import { setUserDataDir, userDataDir } from "../runtime-paths";
import { withRunPriority } from "../runtime/run-priority";
import {
  AGENT_RESIDENCY_IDLE_REAP_MS,
  agentResidencySnapshot,
  sweepIdleAgentResidency,
} from "../runtime/agent-residency";
import { sweepOrphanedRunChildren } from "../runtime/spawn-registry";
import { startControlSocket, type ControlSocketHandle } from "./control-socket";
import { WarmProcessPool } from "./process-pool";

/**
 * 데몬이 쓸 사용자 데이터 경로. **추측하지 않는다** — 잘못 고르면 사용자의 실제 DB 가
 * 아닌 빈 DB 를 열어 놓고 "데이터가 없다" 고 말하게 된다.
 *
 * 우선순위:
 *  1. `--user-data <dir>` 또는 `AGENTLAS_USER_DATA`  — 호스트가 명시한 값.
 *  2. 이 플랫폼에서 Electron 이 쓰는 관례 경로. 데스크탑 앱과 **같은 곳**이어야
 *     데몬과 앱이 한 DB 를 본다(다르면 같은 머신에 두 세계가 생긴다).
 */
export function resolveDaemonUserDataDir(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const flagIndex = argv.indexOf("--user-data");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1]?.trim() : "";
  if (fromFlag) return path.resolve(fromFlag);
  const fromEnv = env.AGENTLAS_USER_DATA?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  // Electron 의 app.getPath("userData") 관례. 앱 이름은 package.json 의 productName 이
  // 아니라 Electron 이 쓰는 이름을 따른다 — 여기가 어긋나면 두 프로세스가 다른 DB 를 연다.
  const appName = "Agentlas";
  if (platform === "darwin") return path.join(home, "Library", "Application Support", appName);
  if (platform === "win32") {
    return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), appName);
  }
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), appName);
}

/**
 * 데몬이 보고하는 버전. Electron 의 `app.getVersion()` 을 못 쓰므로 package.json 을
 * 읽는다 — 모바일이 호환성을 이 값으로 판단하므로 "unknown" 을 보내면 안 된다.
 */
function daemonVersion(): string {
  try {
    // dist/electron/daemon/main.js 기준 저장소 루트.
    const pkg = path.join(__dirname, "..", "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let controlSocket: ControlSocketHandle | null = null;
let desktopParentPid: number | null = null;
let desktopParentWatch: NodeJS.Timeout | null = null;

/*
 * ★웜 프로세스 풀 (Phase 5). 데몬이 CLI 프로세스를 붙들었다가 다음 턴에 재사용하는
 * 메커니즘. 데몬이 소유하므로 (1) host-lifecycle 종료 훅에 dispose 가 걸려 데몬이 죽으면
 * 붙든 프로세스가 함께 죽고(좀비 없음), (2) 제어 소켓의 daemon.ping 이 풀 상태를 실어
 * 관측 가능하다. 재사용 자체의 안전성(체크아웃 배타성·서명 분리·유휴 축출·죽은 프로세스
 * 차단)은 process-pool.ts 가 설계로 보장하고 test-process-pool.cjs 가 실측한다.
 *
 * 일회성 `-p` CLI 실행(claude/codex 의 현재 형태)은 끝나면 스스로 죽으므로 이 풀로 이득이
 * 없다 — 다음 턴에 이어 쓰려면 양방향 stream-json 입력(claude·kimi 전용)이 필요하고,
 * 그건 별도 기능이다. 이 풀은 그 기능이 붙을 자리에서 이미 대기하고 있다.
 */
const processPool = new WarmProcessPool();

/*
 * Exactly one app-scoped process may own the physical Mobile Bridge listener
 * for a user-data directory. Desktop claims a pid-bound lease so its Settings
 * IPC and bridge state events stay authoritative. A dead Desktop parent causes
 * the entire helper to shut down; it never restores service after app exit.
 */
let mobileBridgeLeaseOwnerPid: number | null = null;
let mobileBridgeLeaseWatch: NodeJS.Timeout | null = null;
let mobileBridgeStartPromise: Promise<void> | null = null;
let mobileBridgeRecoveryFailureLogged = false;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function startDaemonMobileBridge(): Promise<void> {
  if (mobileBridgeLeaseOwnerPid !== null) return Promise.resolve();
  if (mobileBridgeStartPromise) return mobileBridgeStartPromise;
  mobileBridgeStartPromise = (async () => {
    const { mobileBridgeRuntimeStatus, startAgentlasMobileBridge } =
      await import("../mobile-bridge/runtime");
    // The owner can change while the dynamic import is resolving. Never race a
    // late daemon start against a Desktop that already received the lease.
    if (mobileBridgeLeaseOwnerPid !== null || mobileBridgeRuntimeStatus().running) return;
    await startAgentlasMobileBridge({ userDataPath: userDataDir(), appVersion: daemonVersion() });
    mobileBridgeRecoveryFailureLogged = false;
  })().finally(() => {
    mobileBridgeStartPromise = null;
  });
  return mobileBridgeStartPromise;
}

function ensureMobileBridgeLeaseWatch(): void {
  if (mobileBridgeLeaseWatch) return;
  mobileBridgeLeaseWatch = setInterval(() => {
    const ownerPid = mobileBridgeLeaseOwnerPid;
    if (ownerPid !== null && processIsAlive(ownerPid)) return;
    if (ownerPid !== null) {
      mobileBridgeLeaseOwnerPid = null;
      console.warn(`[agentlasd] Desktop Mobile Bridge owner ${ownerPid} exited; restoring daemon listener`);
    }
    // Also repairs a failed graceful release/start. A one-shot restart left the
    // daemon as nominal owner with no listener forever; the bounded interval
    // keeps retrying while coalescing overlapping starts.
    void startDaemonMobileBridge().catch((error) => {
      if (!mobileBridgeRecoveryFailureLogged) {
        mobileBridgeRecoveryFailureLogged = true;
        console.error("[agentlasd] Mobile Bridge recovery failed; retrying:", error);
      }
    });
  }, 1_000);
  mobileBridgeLeaseWatch.unref?.();
}

/**
 * 제어 소켓의 메서드 처리. **터미널이 실제로 필요로 하는 것부터** 연다 —
 * 쓰이지 않을 메서드를 미리 만드는 것은 배선이 아니라 선언이다.
 */
async function handleControlMethod(method: string, params: unknown): Promise<unknown> {
  if (method === "daemon.ping") {
    const { openedStorePath } = await import("../store/db");
    const { mobileBridgeRuntimeStatus } = await import("../mobile-bridge/runtime");
    const mobileBridge = mobileBridgeRuntimeStatus();
    return {
      ok: true,
      version: daemonVersion(),
      pid: process.pid,
      parentPid: desktopParentPid,
      // ★어느 DB 를 열었는지 말한다. 터미널은 `AGENTLAS_STORE_PATH` 로 사본을 열 수 있는데
      //   그 값은 이 프로세스까지 오지 않는다 — 서로 다른 DB 를 보면서 일을 주고받으면
      //   한쪽은 사본에, 다른 쪽은 라이브에 쓰는 상태가 조용히 성립한다. 넘기기 전에
      //   비교할 수 있게 이 값을 실어 보낸다(경로는 비밀이 아니다).
      storePath: openedStorePath(),
      // 풀 관측 — 붙든 프로세스 수/유휴 수. "재사용이 실제로 되고 있나"의 유일한 창.
      warmProcesses: processPool.size(),
      warmIdle: processPool.idleCount(),
      // 상주 관측 — 이 프로세스가 들고 있는 에이전트 수(자세한 목록은 agents.residency).
      residentAgents: agentResidencySnapshot().holding,
      mobileBridge: {
        owner: mobileBridgeLeaseOwnerPid === null ? "daemon" : "desktop",
        ownerPid: mobileBridgeLeaseOwnerPid ?? process.pid,
        running: mobileBridge.running,
        endpoint: mobileBridge.endpoint,
      },
    };
  }
  if (method === "mobileBridge.claim") {
    const ownerPid = Number((params as { ownerPid?: unknown } | null)?.ownerPid);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !processIsAlive(ownerPid)) {
      throw new Error("mobileBridge.claim requires a live owner pid");
    }
    const existingOwner = mobileBridgeLeaseOwnerPid;
    if (existingOwner !== null && existingOwner !== ownerPid && processIsAlive(existingOwner)) {
      throw new Error(`Mobile Bridge is already leased to Desktop pid ${existingOwner}`);
    }
    mobileBridgeLeaseOwnerPid = ownerPid;
    ensureMobileBridgeLeaseWatch();
    const { mobileBridgeRuntimeStatus, stopAgentlasMobileBridge } =
      await import("../mobile-bridge/runtime");
    try {
      await stopAgentlasMobileBridge();
    } catch (error) {
      // A failed claim must not strand ownership on a live Desktop that never
      // received the lease. Roll back first; the watcher provides further
      // retries if immediate daemon restoration also fails.
      if (mobileBridgeLeaseOwnerPid === ownerPid) mobileBridgeLeaseOwnerPid = null;
      await startDaemonMobileBridge().catch((restoreError) => {
        console.error("[agentlasd] Mobile Bridge claim rollback failed; retrying:", restoreError);
      });
      throw error;
    }
    return {
      ok: true,
      ownerPid,
      daemonBridgeRunning: mobileBridgeRuntimeStatus().running,
    };
  }
  if (method === "mobileBridge.release") {
    const ownerPid = Number((params as { ownerPid?: unknown } | null)?.ownerPid);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) {
      throw new Error("mobileBridge.release requires an owner pid");
    }
    if (mobileBridgeLeaseOwnerPid !== ownerPid) {
      throw new Error("Mobile Bridge lease owner does not match");
    }
    mobileBridgeLeaseOwnerPid = null;
    await startDaemonMobileBridge();
    return { ok: true, ownerPid: null };
  }
  if (method === "agents.residency") {
    /*
     * ★상주 관측 — "앱이 켜져 있는 동안 유지된다"를 **실측 가능한 사실**로 만든다.
     *
     * 경계를 분명히 해 둔다: 이 응답은 **이 프로세스(데몬)가 들고 있는 상주**다.
     * 데스크탑 앱이 자기 프로세스에서 돌리는 채팅 세션은 앱의 등록소에 있고, 여기서는
     * 보이지 않는다. 두 프로세스의 목록을 합쳐 하나인 척하면 그 숫자는 아무도 못 고친다.
     */
    const { agentResidencySnapshot: snapshot } = await import("../runtime/agent-residency");
    return { ...snapshot(), pid: process.pid, warmProcesses: processPool.size() };
  }
  if (method === "agents.releaseResidency") {
    /*
     * ★상주는 "앱이 켜져 있는 동안"이다 — 오너 규칙(2026-08-20).
     *
     * 헬퍼와 상주 CLI 모두 Desktop 앱 수명에 묶인다. 이 메서드는 앱 종료 전 정리나
     * 업데이트 교체 중 상주 세션만 먼저 놓아야 할 때 쓰는 멱등 경계다.
     * 연속성은 손실되지 않는다: 다음 턴은 지금처럼 세션 id + 히스토리로 이어진다.
     */
    const { agentResidencySnapshot: snapshot, disposeAgentResidency } =
      await import("../runtime/agent-residency");
    const before = snapshot().holding;
    disposeAgentResidency();
    return { ok: true, pid: process.pid, released: before, holding: snapshot().holding };
  }
  if (method === "daemon.shutdown") {
    /*
     * ★정중한 종료 — 버전 스큐 교체용 (앱 app-launcher.ts 가 부른다).
     *
     * 앱이 업데이트되면 소켓 너머의 데몬은 옛 바이너리다. 그 데몬을 SIGKILL 로 치우면
     * 붙들고 있던 자식 CLI 들이 고아가 된다 — 그래서 소켓으로 부탁하고, 데몬은 정상
     * 종료 경로(shutdown hooks → 풀 dispose → exit)를 그대로 돈다. 응답을 먼저 쓰고
     * 다음 틱에 죽는다 — 그래야 요청자가 "부탁이 접수됐다"를 안다.
     */
    const requestedParentPid = Number((params as { parentPid?: unknown } | null)?.parentPid);
    if (desktopParentPid !== null && requestedParentPid !== desktopParentPid) {
      throw new Error("daemon.shutdown owner mismatch");
    }
    setTimeout(() => performShutdown("daemon.shutdown rpc"), 50).unref?.();
    return { ok: true, pid: process.pid, version: daemonVersion() };
  }
  if (method === "automations.get") {
    const id = (params as { id?: string })?.id;
    if (!id) throw new Error("automations.get requires an id");
    const { getAutomation } = await import("../store/automations");
    return getAutomation(id) ?? null;
  }
  if (method === "graph.run") {
    /*
     * ★터미널이 코어를 로드하는 **유일한 무거운 이유**가 이 호출이다(graph.cjs:509).
     * 터미널은 완주를 기다렸다가 결과 JSON 을 찍는다 — 이 소켓의 요청/응답 형태와
     * 정확히 일치해서, 스트리밍 채널 없이도 손실 없이 옮겨진다.
     * (라이브 이벤트가 필요한 채팅 실행은 다르다 — 그건 여기로 옮기지 않았다.)
     */
    const { automationId, automation: fallbackRow, graph, initialVars } = (params ?? {}) as {
      automationId?: string;
      automation?: Record<string, unknown>;
      graph?: unknown;
      initialVars?: Record<string, unknown>;
    };
    if (!graph) throw new Error("graph.run requires a graph");
    const { getAutomation } = await import("../store/automations");
    const stored = automationId ? getAutomation(automationId) : null;
    const automation = stored ?? fallbackRow;
    if (!automation) throw new Error("graph.run requires automationId or an automation row");
    const { runGraph } = await import("../workflow/run-graph");
    // 데몬으로 들어온 그래프 실행은 정의상 무인 작업이다 — 실행 슬롯 2단 큐와 자식 nice
    // 차등이 이 문맥 표식으로 동작한다(사람이 기다리는 채팅 턴이 항상 앞선다).
    return withRunPriority("background", () =>
      runGraph(
        { ...(automation as object), graph } as never,
        graph as never,
        { ...(initialVars ? { initialVars } : {}) } as never,
      ),
    );
  }
  throw new Error(`unknown method: ${method}`);
}

/** 프로세스를 살려 두는 핸들. 종료 시 풀어 준다 — 안 그러면 exit 이 걸린다. */
let keepAlive: NodeJS.Timeout | null = null;

let closing = false;

/**
 * 단일 종료 경로 — 신호(SIGTERM/SIGINT/SIGHUP)든 RPC(daemon.shutdown)든 같은 정리를
 * 정확히 한 번 돈다. 두 경로가 각자 정리를 들고 있으면 언젠가 한쪽만 고쳐진다.
 */
function performShutdown(reason: string): void {
  if (closing) return;
  closing = true;
  console.log(`[agentlasd] ${reason} — running shutdown hooks`);
  try {
    runHostShutdownHooks();
  } catch (error) {
    console.error("[agentlasd] shutdown hooks failed:", error);
  }
  if (controlSocket) {
    // 유닉스 소켓 파일을 남기면 다음 데몬이 EADDRINUSE 로 못 뜬다.
    void controlSocket.close();
    controlSocket = null;
  }
  // 붙든 프로세스를 전부 죽인다(host-lifecycle 도 부르지만, 순서와 무관하게 멱등).
  processPool.dispose();
  if (keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
  if (mobileBridgeLeaseWatch) {
    clearInterval(mobileBridgeLeaseWatch);
    mobileBridgeLeaseWatch = null;
  }
  if (desktopParentWatch) {
    clearInterval(desktopParentWatch);
    desktopParentWatch = null;
  }
  // 정리가 끝난 뒤에만 나간다. 여기서 즉시 exit 하면 자식 트리 킬이 잘린다.
  process.exit(0);
}

/** 종료 신호 한 벌 — 어느 신호로 죽든 자식 CLI 가 함께 정리돼야 한다. */
function installSignalHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => performShutdown(signal));
  }
}

export async function startDaemon(): Promise<void> {
  const dir = resolveDaemonUserDataDir();
  fs.mkdirSync(dir, { recursive: true });
  setUserDataDir(dir);
  const rawParentPid = Number(process.env.AGENTLAS_DESKTOP_PARENT_PID);
  if (!Number.isSafeInteger(rawParentPid) || rawParentPid <= 1) {
    throw new Error("agentlasd requires a live Desktop parent pid");
  }
  desktopParentPid = rawParentPid;
  if (!processIsAlive(desktopParentPid)) {
    throw new Error("Desktop parent exited before agentlasd startup");
  }

  // Unlike the GUI process, this Electron child cannot read app.asar metadata
  // through `app.getAppPath()`. The Desktop parent passes its already-resolved
  // immutable identity over the private child environment. Configure it before
  // initStore or any model/Keychain-backed code can touch protected storage.
  const { configureInstallIdentity, deserializeInstallIdentity } =
    await import("../install-identity");
  const rawIdentity = process.env.AGENTLAS_INSTALL_IDENTITY?.trim();
  if (!rawIdentity) {
    throw new Error("agentlasd requires AGENTLAS_INSTALL_IDENTITY from its Desktop parent");
  }
  const installIdentity = deserializeInstallIdentity(rawIdentity);
  if (installIdentity.channel === "qa" && installIdentity.userDataOverride !== dir) {
    throw new Error("agentlasd QA identity does not match its user-data directory");
  }
  configureInstallIdentity(installIdentity);
  installSignalHandlers();
  console.log(`[agentlasd] identity ready: ${installIdentity.channel}`);
  console.log(`[agentlasd] user data: ${userDataDir()}`);
  desktopParentWatch = setInterval(() => {
    const ownerPid = desktopParentPid;
    if (ownerPid !== null && !processIsAlive(ownerPid)) {
      performShutdown("Desktop parent exited");
    }
  }, 500);

  // store 를 여는 것이 이 단계의 증명이다 — 열리면 Electron 없이 DB 를 소유할 수 있다.
  // 마이그레이션 권위는 Phase 0 에서 이미 하나로 정리했고, 스키마가 낮으면 이 경로는
  // 조용히 승급하지 않고 **거절한다**(store/db.ts). 데몬이 앱보다 먼저 떠서 사다리를
  // 돌리면 앱이 자기 DB 를 못 알아본다.
  const { initStore } = await import("../store/db");
  initStore();
  console.log("[agentlasd] store ready");

  /*
   * ★모바일 브리지 — Desktop 앱 수명 안에서만 내부 헬퍼와 GUI가 단일 리스너를
   * 교대 소유한다. 앱이 완전히 종료되면 브리지도 함께 종료된다.
   *
   * 새 프로토콜을 만들지 않는다 — 이미 60개 메서드 계약(invoke/chats/projects/
   * automations/runtime/build)이 모바일용으로 살아 있고, 기획서가 데몬 제어면으로
   * 그걸 재사용하기로 정했다. 페어링·TLS·리플레이 방지가 이미 그 안에 있다.
   *
   * 브리지 시작 실패는 다른 Desktop 기능을 막지 않는다.
   */
  /*
   * ★로컬 제어 소켓 — 같은 머신의 터미널·데스크탑이 데몬에 일을 시키는 문(Phase 3).
   *
   * 터미널은 지금 데스크탑 코어를 **자기 프로세스에서** 돌린다(64MB 벤더 사본).
   * 그래서 같은 머신에 코어가 두 벌 있고, DB 를 여는 주인도 둘이다. 이 소켓이 있으면
   * 터미널은 코어를 로드하지 않고 "이거 해 줘" 라고 말하기만 하면 된다.
   *
   * 모바일 브리지를 안 쓰는 이유는 그게 **다른 기기**용이라 페어링·TLS 가 붙기 때문이다.
   * 같은 사용자의 CLI 한 줄에 그 절차를 요구하면 아무도 안 쓰고, 그러면 벤더 사본이
   * 영원히 남는다. 경계는 파일 권한이 맡는다(control-socket.ts 주석 참조).
   */
  ensureMobileBridgeLeaseWatch();
  try {
    const socket = await startControlSocket(dir, { handle: handleControlMethod });
    controlSocket = socket;
    console.log(`[agentlasd] control socket: ${socket.address}`);
  } catch (error) {
    // 소켓이 없으면 터미널이 예전처럼 자기 안에서 코어를 돌린다 — 느릴 뿐 막히지 않는다.
    console.error("[agentlasd] control socket failed to start:", error);
  }

  try {
    await startDaemonMobileBridge();
    console.log("[agentlasd] mobile bridge ready");
  } catch (error) {
    console.error("[agentlasd] mobile bridge failed to start:", error);
  }

  /*
   * ★Desktop 부모가 살아 있는 동안만 헬퍼 이벤트 루프를 유지하고 정리한다.
   *
   * 실측 2026-08-19: keepAlive 인터벌이 없을 때 데몬은 store 를 열고 "ready" 를 찍은 뒤
   * 스스로 종료했다(이벤트 루프에 붙잡을 것이 없으면 Node 는 그냥 나간다). 이 인터벌은
   * 그 keepAlive 역할을 유지하면서(절대 unref 하지 않는다), 같은 주기에 스위퍼 둘을 돈다:
   *
   *  (a) 12h 유휴 리퍼 — 자기가 붙든 상주/워밍 프로세스 중 마지막 활동 후 12시간 지난
   *      것을 종료한다. WarmProcessPool 의 짧은 idle TTL(5분)은 일회용 워밍용이고, 이
   *      리퍼는 resident 로 붙든 상주 세션(추후 기능)의 상한이다. One 관련 프로세스는
   *      acquire 의 reaperExempt 표식으로 면제된다(process-pool.ts 계약 참조).
   *
   *  (b) 고아 수거 — 앱/데몬이 크래시로 죽으면 host-lifecycle 훅이 못 돌아 자식 CLI/MCP
   *      트리가 살아남는다. exec.ts 의 trackRunChild 가 스폰 사실을 디스크 원장
   *      (spawn-registry)에 남기므로, 여기서 "호스트 PID 는 죽었는데 자식은 살아 있는"
   *      항목을 확인 사살한다(정체 확인 후 SIGTERM → 다음 패스 SIGKILL).
   */
  const SWEEP_INTERVAL_MS = 10 * 60_000;
  const RESIDENT_IDLE_REAP_MS = 12 * 60 * 60_000;
  keepAlive = setInterval(() => {
    try {
      const reaped = processPool.sweepIdle(RESIDENT_IDLE_REAP_MS);
      if (reaped > 0) console.log(`[agentlasd] idle reaper: terminated ${reaped} process(es) idle >12h`);
    } catch (error) {
      console.error("[agentlasd] idle reaper failed:", error);
    }
    try {
      // 같은 12시간 규칙을 상주 에이전트 세션(ACP 세션 풀)에도 적용한다 — 프로세스 풀과
      // 상주 등록소가 각자 다른 시계를 들면 하나만 고쳐지고 다른 하나는 영영 안 죽는다.
      const closed = sweepIdleAgentResidency(AGENT_RESIDENCY_IDLE_REAP_MS);
      if (closed > 0) console.log(`[agentlasd] residency reaper: closed ${closed} agent session(s) idle >12h`);
    } catch (error) {
      console.error("[agentlasd] residency reaper failed:", error);
    }
    void sweepOrphanedRunChildren()
      .then((sweep) => {
        if (sweep.signaled > 0 || sweep.prunedMismatched > 0) {
          console.log(
            `[agentlasd] orphan sweep: signaled=${sweep.signaled} prunedDead=${sweep.prunedDead} ` +
            `keptLive=${sweep.keptLive} prunedMismatched=${sweep.prunedMismatched}`,
          );
        }
      })
      .catch((error) => console.error("[agentlasd] orphan sweep failed:", error));
  }, SWEEP_INTERVAL_MS);
  // 부팅 직후 한 번은 빨리 돈다 — 직전 크래시의 고아를 10분씩 기다리게 하지 않는다.
  const firstSweep = setTimeout(() => {
    void sweepOrphanedRunChildren().catch(() => { /* 다음 주기가 다시 시도한다 */ });
  }, 30_000);
  firstSweep.unref?.();
}

// 직접 실행됐을 때만 시작한다(테스트는 위 함수들만 부른다).
if (require.main === module) {
  startDaemon().catch((error) => {
    console.error("[agentlasd] failed to start:", error);
    process.exit(1);
  });
}
