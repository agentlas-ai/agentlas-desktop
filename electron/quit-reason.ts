import { app } from "electron";
import { appendLaunchTrace } from "./logging";

/*
 * 앱이 왜 꺼졌는지를 기계가 읽을 수 있는 코드로 남긴다.
 *
 * 실측(2026-09-25 1.2.43 dev E2E, pid 96164): 격리 앱이 10:02:33Z 에 "[shutdown] cleanup deadline armed"
 * 만 남기고 꺼졌고, 앱 로그 어디에도 원인이 없었다. macOS 통합 로그로 재구성한 진실:
 *   19:02:30.997 Dock 이 DockHelper 를 띄움(Dock 아이콘 우클릭 메뉴)
 *   19:02:33.011 remoting_me2me_host "Chrome Remote Desktop connection active" (원격 사용자 입력)
 *   19:02:33.357 DockHelper "perform action for menu item"
 *   19:02:33.359 Electron[96164] "Handling Quit AppleEvent" → applicationShouldTerminate → before-quit
 * 즉 원격 데스크탑으로 들어온 사람이 Dock 의 "Electron" 아이콘 메뉴에서 종료를 골랐다. 개발·QA 인스턴스는
 * 전부 Dock 에 "Electron" 으로 뜨고, 공유 로그(Agentlas-QA/main.log)는 여러 앱이 섞여 쓰는데 줄에 pid 도 없어
 * 앱 안에서는 "외부 신호인지, 메뉴인지, 업데이트인지" 를 가를 방법이 없었다.
 *
 * 규칙: 종료를 일으키는 모든 자리는 먼저 noteQuitIntent(코드) 를 부르고, before-quit 에서 한 번
 * recordQuitStarted() 가 그 코드(없으면 OS 가 보낸 종료 요청 — Dock/AppleEvent/로그아웃)를 pid·ppid·가동시간과
 * 함께 main.log 와 launches.log 에 동기로 적는다. app.exit() 경로(before-quit 이 안 뜬다)는 recordImmediateExit().
 * process 'exit' 에서 종료 코드까지 한 줄 더 적는다.
 */

export type QuitReasonCode =
  | "menu-quit" // 앱 메뉴의 종료(Cmd-Q)
  | "signal" // SIGTERM/SIGINT/SIGHUP — detail.signal, detail.parentAlive
  | "window-all-closed" // 비-macOS 마지막 창 닫힘
  | "update-install" // 자동 업데이트 설치를 위한 종료
  | "relaunch" // 복구·잠금 재시도 후 재시작
  | "single-instance-rejected" // 다른 인스턴스가 잠금을 가짐
  | "startup-refused" // 신원·런타임 봉인 등으로 시작 거부
  | "startup-failed" // 시작 실패
  | "headless-done" // --graph-surface / --headless-automations 작업 종료
  | "cleanup-deadline" // 정리 시한 초과로 강제 종료
  | "os-shutdown" // powerMonitor shutdown(재부팅·전원 끄기)
  | "os-quit-request"; // 앱 밖에서 온 종료 요청(Dock 메뉴의 종료, osascript quit, 로그아웃 AppleEvent)

interface QuitIntent { code: QuitReasonCode; detail?: Record<string, unknown>; at: number }

let intent: QuitIntent | null = null;
let recorded = false;
let exitRecorded = false;
let systemShutdown = false;

/** 종료를 일으키기 직전에 부른다. 처음 적힌 의도가 이긴다(신호 뒤의 before-quit 이 덮지 않게). */
export function noteQuitIntent(code: QuitReasonCode, detail?: Record<string, unknown>): void {
  if (intent) return;
  intent = { code, ...(detail ? { detail } : {}), at: Date.now() };
}

export function noteSystemShutdown(active: boolean): void {
  systemShutdown = active;
}

function parentAlive(): boolean {
  try { process.kill(process.ppid, 0); return true; } catch { return false; }
}

function resolvedReason(): QuitIntent {
  if (intent) return intent;
  if (systemShutdown) return { code: "os-shutdown", at: Date.now() };
  // macOS: 앱 안의 모든 종료 자리는 의도를 남기므로, 남은 것은 NSApplication 이 받은 Quit AppleEvent 다.
  return { code: "os-quit-request", detail: { source: process.platform === "darwin" ? "quit_apple_event" : "unattributed" }, at: Date.now() };
}

function payload(reason: QuitIntent, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: reason.code,
    ...(reason.detail ? { detail: reason.detail } : {}),
    pid: process.pid,
    ppid: process.ppid,
    parentAlive: parentAlive(),
    uptimeSec: Math.round(process.uptime()),
    ...extra,
  };
}

/** before-quit 첫 회에서 부른다. 두 번째 before-quit(정리 뒤 재진입)은 아무것도 안 한다. */
export function recordQuitStarted(): void {
  if (recorded) return;
  recorded = true;
  const line = payload(resolvedReason());
  console.info(`[quit] reason ${JSON.stringify(line)}`);
  appendLaunchTrace("quit", line);
}

/** before-quit 을 거치지 않는 app.exit() 직전에 부른다. */
export function recordImmediateExit(code: QuitReasonCode, exitCode: number, detail?: Record<string, unknown>): void {
  noteQuitIntent(code, detail);
  if (!recorded) {
    recorded = true;
    const line = payload(resolvedReason(), { immediateExit: exitCode });
    console.info(`[quit] reason ${JSON.stringify(line)}`);
    appendLaunchTrace("quit", line);
  }
}

const QUIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
let signalHandlersInstalled = false;

/**
 * SIGTERM/SIGINT/SIGHUP 을 이유와 함께 받는다. Node 핸들러를 걸면 Chromium 의 기본 종료 처리 대신 이 함수가
 * 불리므로, 여기서 같은 우아한 종료(app.quit)를 직접 시작한다. 두 번째 신호는 이미 도는 정리(시한 있음)에 맡긴다.
 * 보낸 프로세스 pid 는 Node 가 주지 않는다 — 대신 부모 생존 여부를 적는다(부모 셸이 죽으며 그룹에 보낸 신호 구분).
 */
export function installQuitSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of QUIT_SIGNALS) {
    process.on(signal, () => {
      const alreadyQuitting = recorded;
      noteQuitIntent("signal", { signal, parentAlive: parentAlive() });
      if (alreadyQuitting) {
        console.info(`[quit] ${signal} received while quitting — cleanup deadline owns the exit`);
        return;
      }
      app.quit();
    });
  }
  process.once("exit", (exitCode) => {
    if (exitRecorded) return;
    exitRecorded = true;
    appendLaunchTrace("exit", { exitCode, code: (intent ?? resolvedReason()).code, uptimeSec: Math.round(process.uptime()) });
  });
}

/*
 * 실측(2026-09-25, 격리 앱 nf-quit): whenReady 안에서 건 Node 핸들러가 시작 도중 네이티브 쪽에서 다시 설치된 기본 종료
 * 처리에 덮여, SIGTERM 이 Node 에 오지 않고 곧장 before-quit 으로 가 "os-quit-request" 로 잘못 적혔다(최소 Electron
 * 앱에서는 재현 안 됨 — 앱 시작 중 무언가가 sigaction 을 다시 건다). 리스너를 모두 떼었다 다시 붙이면 Node 가 신호
 * 핸들을 새로 열며 sigaction 을 다시 건다. 시작이 끝난 뒤 한 번 부른다(이후 신호는 이름과 함께 기록된다).
 */
export function rearmQuitSignalHandlers(): void {
  if (!signalHandlersInstalled) return installQuitSignalHandlers();
  for (const signal of QUIT_SIGNALS) {
    const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
    process.removeAllListeners(signal);
    for (const listener of listeners) process.on(signal, listener);
  }
}
