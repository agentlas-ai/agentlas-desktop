import { app } from "electron";
import { appendLaunchTrace } from "./logging";




















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

/** The quit intent noted so far (null: none, e.g. a programmatic app.quit()). */
export function currentQuitIntentCode(): QuitReasonCode | null {
  return intent?.code ?? null;
}

/** A quit the person cancelled (quit prompt, background tray) is no longer the reason for a later quit. */
export function clearQuitIntent(): void {
  if (!recorded) intent = null;
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







export function rearmQuitSignalHandlers(): void {
  if (!signalHandlersInstalled) return installQuitSignalHandlers();
  for (const signal of QUIT_SIGNALS) {
    const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
    process.removeAllListeners(signal);
    for (const listener of listeners) process.on(signal, listener);
  }
}
