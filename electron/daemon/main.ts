// `agentlasd` — Electron 없이 도는 Agentlas 호스트 프로세스.
//
// ★무엇을 위한 것인가 (docs/DAEMON-ARCHITECTURE-DESIGN §6 Phase 1).
// 지금은 데스크탑 앱이 켜져 있어야만 실행·자동화·모바일 브리지가 산다. 앱을 닫으면
// 예약된 자동화도, 폰에서 보낸 요청도 갈 곳이 없다. 그 상태를 끝내려면 store 와
// 러너를 **GUI 없는 프로세스**가 소유해야 한다.
//
// 이 파일은 그 프로세스의 진입점이고, 지금 단계에서 하는 일은 **경계를 증명하는 것**이다:
//   1. Electron 없이 사용자 데이터 경로를 정한다(runtime-paths 주입).
//   2. store 를 연다 — 여기까지 오면 "데몬이 DB 를 열 수 있다" 가 실증된다.
//   3. 종료 신호를 호스트 정리 계약에 연결한다(host-lifecycle).
//
// 아직 하지 않는 것: 제어 서버(Phase 2), 터미널 클라이언트(Phase 3), 자동 시작(Phase 4).
// 그것들은 이 세 가지가 실제로 도는 것을 확인한 뒤에 얹는다 — 순서를 바꾸면
// "데몬이 떴다" 는 로그만 있고 DB 는 못 여는 상태를 발견하지 못한다.
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

/**
 * 제어 소켓의 메서드 처리. **터미널이 실제로 필요로 하는 것부터** 연다 —
 * 쓰이지 않을 메서드를 미리 만드는 것은 배선이 아니라 선언이다.
 */
async function handleControlMethod(method: string, params: unknown): Promise<unknown> {
  if (method === "daemon.ping") {
    const { openedStorePath } = await import("../store/db");
    return {
      ok: true,
      version: daemonVersion(),
      pid: process.pid,
      // ★어느 DB 를 열었는지 말한다. 터미널은 `AGENTLAS_STORE_PATH` 로 사본을 열 수 있는데
      //   그 값은 이 프로세스까지 오지 않는다 — 서로 다른 DB 를 보면서 일을 주고받으면
      //   한쪽은 사본에, 다른 쪽은 라이브에 쓰는 상태가 조용히 성립한다. 넘기기 전에
      //   비교할 수 있게 이 값을 실어 보낸다(경로는 비밀이 아니다).
      storePath: openedStorePath(),
      // 풀 관측 — 붙든 프로세스 수/유휴 수. "재사용이 실제로 되고 있나"의 유일한 창.
      warmProcesses: processPool.size(),
      warmIdle: processPool.idleCount(),
    };
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
    return runGraph(
      { ...(automation as object), graph } as never,
      graph as never,
      { ...(initialVars ? { initialVars } : {}) } as never,
    );
  }
  throw new Error(`unknown method: ${method}`);
}

/** 프로세스를 살려 두는 핸들. 종료 시 풀어 준다 — 안 그러면 exit 이 걸린다. */
let keepAlive: NodeJS.Timeout | null = null;

/** 종료 신호 한 벌 — 어느 신호로 죽든 자식 CLI 가 함께 정리돼야 한다. */
function installSignalHandlers(): void {
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[agentlasd] ${signal} — running shutdown hooks`);
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
    // 정리가 끝난 뒤에만 나간다. 여기서 즉시 exit 하면 자식 트리 킬이 잘린다.
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => shutdown(signal));
  }
}

export async function startDaemon(): Promise<void> {
  const dir = resolveDaemonUserDataDir();
  fs.mkdirSync(dir, { recursive: true });
  setUserDataDir(dir);
  installSignalHandlers();
  console.log(`[agentlasd] user data: ${userDataDir()}`);

  // store 를 여는 것이 이 단계의 증명이다 — 열리면 Electron 없이 DB 를 소유할 수 있다.
  // 마이그레이션 권위는 Phase 0 에서 이미 하나로 정리했고, 스키마가 낮으면 이 경로는
  // 조용히 승급하지 않고 **거절한다**(store/db.ts). 데몬이 앱보다 먼저 떠서 사다리를
  // 돌리면 앱이 자기 DB 를 못 알아본다.
  const { initStore } = await import("../store/db");
  initStore();
  console.log("[agentlasd] store ready");

  /*
   * ★모바일 브리지 — Phase 2 의 첫 조각이자, 데몬이 존재하는 이유 그 자체.
   *
   * 지금은 데스크탑 앱이 켜져 있어야만 폰에서 보낸 요청이 도착한다. 앱을 닫으면
   * 브리지도 함께 죽는다. 이 서버가 데몬 안에서 돌면 창 없이도 폰이 붙는다.
   *
   * 새 프로토콜을 만들지 않는다 — 이미 60개 메서드 계약(invoke/chats/projects/
   * automations/runtime/build)이 모바일용으로 살아 있고, 기획서가 데몬 제어면으로
   * 그걸 재사용하기로 정했다. 페어링·TLS·리플레이 방지가 이미 그 안에 있다.
   *
   * 실패해도 데몬은 산다: 브리지가 못 떠도 store 는 열려 있고 자동화는 돈다.
   * 여기서 죽으면 폰이 안 붙는 것보다 나쁜 일이 된다.
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
  try {
    const socket = await startControlSocket(dir, { handle: handleControlMethod });
    controlSocket = socket;
    console.log(`[agentlasd] control socket: ${socket.address}`);
  } catch (error) {
    // 소켓이 없으면 터미널이 예전처럼 자기 안에서 코어를 돌린다 — 느릴 뿐 막히지 않는다.
    console.error("[agentlasd] control socket failed to start:", error);
  }

  try {
    const { startAgentlasMobileBridge } = await import("../mobile-bridge/runtime");
    await startAgentlasMobileBridge({ userDataPath: userDataDir(), appVersion: daemonVersion() });
    console.log("[agentlasd] mobile bridge ready");
  } catch (error) {
    console.error("[agentlasd] mobile bridge failed to start:", error);
  }

  /*
   * ★살아 있어야 데몬이다.
   *
   * 실측 2026-08-19: 이 줄이 없을 때 데몬은 store 를 열고 "ready" 를 찍은 뒤 **스스로
   * 종료했다**. 이벤트 루프에 붙잡을 것이 없으면 Node 는 그냥 나간다. 그래서 종료
   * 신호를 재던 테스트는 이미 죽은 프로세스를 재고 있었고, 핸들러가 안 돈 게 아니라
   * 부를 프로세스가 없었다 — "떴다" 는 로그만 보고 넘어갔으면 못 봤을 결함이다.
   *
   * Phase 2 에서 제어 서버가 뜨면 그 소켓이 프로세스를 붙잡으므로 이 타이머는 사라진다.
   * 그때까지는 이것이 "데몬은 요청을 기다린다" 의 최소 구현이다.
   */
  keepAlive = setInterval(() => {}, 60_000);
}

// 직접 실행됐을 때만 시작한다(테스트는 위 함수들만 부른다).
if (require.main === module) {
  startDaemon().catch((error) => {
    console.error("[agentlasd] failed to start:", error);
    process.exit(1);
  });
}
