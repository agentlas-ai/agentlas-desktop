/**
 * 실행이 끝나면 알린다 — 소리·앱 흔들기·알림.
 *
 * ★왜 (오너 2026-09-07): "설정에 알람 만들어라 작업 완료되거나 턴 종료되면 알람 나오게",
 *   "소리알람, 그냥 앱 흔들리기 등등 (윈도우도 다 되야한다)".
 *
 * 긴 실행은 몇 분에서 몇 시간이 걸린다. 그동안 다른 창을 보고 있으면 끝난 줄 모른다.
 *
 * ★플랫폼 — "앱 흔들기"는 OS마다 이름이 다르다. 하나만 부르면 다른 쪽이 조용히 아무 일도
 *   안 한다(그리고 그것은 화면에 안 보인다):
 *     macOS  → app.dock.bounce("critical")   — Dock 아이콘이 튄다
 *     Windows/Linux → BrowserWindow.flashFrame(true) — 작업표시줄 단추가 깜빡인다
 *   둘 다 부르되 **그 OS에 없는 API는 부르지 않는다**(dock 은 macOS 에만 있다).
 *
 * ★조용해야 할 때 — 기본값은 "창이 안 보고 있을 때만". 이미 보고 있는데 소리가 나면
 *   그건 알림이 아니라 소음이고, 소음은 곧 꺼진다. 사용자가 원하면 항상 켤 수 있다.
 */
import { app, BrowserWindow, Notification } from "electron";
import { getMeta, setMeta } from "./store/meta";
import { retainNotification } from "./notification-target";

const META_KEY = "run_alerts.v1";

export interface RunAlertSettings {
  /** 전체 스위치. 끄면 아래 값과 무관하게 아무 일도 하지 않는다. */
  enabled: boolean;
  /** OS 알림(제목·본문). 소리는 이 알림에 실린다. */
  notification: boolean;
  /** 알림에 소리를 넣을지. false면 조용한 알림. */
  sound: boolean;
  /** Dock 바운스(macOS) / 작업표시줄 깜빡임(Windows·Linux). */
  bounce: boolean;
  /** 창이 이미 앞에 있고 포커스가 있으면 알리지 않는다(기본 켬). */
  onlyWhenUnfocused: boolean;
  /**
   * 이보다 짧게 끝난 턴은 알리지 않는다(초).
   * 2초짜리 대화마다 소리가 나면 알림이 아니라 소음이다. 0이면 언제나 알린다.
   */
  minSeconds: number;
  /** 실패·취소로 끝난 실행도 알릴지(기본 켬 — 실패야말로 알아야 한다). */
  alsoOnFailure: boolean;
}

export const DEFAULT_RUN_ALERTS: RunAlertSettings = {
  enabled: true,
  notification: true,
  sound: true,
  bounce: true,
  onlyWhenUnfocused: true,
  minSeconds: 20,
  alsoOnFailure: true,
};

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/** 저장본은 사용자 데이터라 무엇이든 들어올 수 있다 — 칸마다 좁혀서 읽는다. */
export function normalizeRunAlerts(raw: unknown): RunAlertSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const seconds = Number(value.minSeconds);
  return {
    enabled: bool(value.enabled, DEFAULT_RUN_ALERTS.enabled),
    notification: bool(value.notification, DEFAULT_RUN_ALERTS.notification),
    sound: bool(value.sound, DEFAULT_RUN_ALERTS.sound),
    bounce: bool(value.bounce, DEFAULT_RUN_ALERTS.bounce),
    onlyWhenUnfocused: bool(value.onlyWhenUnfocused, DEFAULT_RUN_ALERTS.onlyWhenUnfocused),
    // 상한을 둔다 — 한 시간짜리 문턱은 알림을 영영 안 나오게 만드는 것과 같다.
    minSeconds: Number.isFinite(seconds) ? Math.min(600, Math.max(0, Math.round(seconds))) : DEFAULT_RUN_ALERTS.minSeconds,
    alsoOnFailure: bool(value.alsoOnFailure, DEFAULT_RUN_ALERTS.alsoOnFailure),
  };
}

export function getRunAlerts(): RunAlertSettings {
  try {
    const raw = getMeta(META_KEY);
    return normalizeRunAlerts(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_RUN_ALERTS };
  }
}

export function setRunAlerts(patch: unknown): RunAlertSettings {
  const next = normalizeRunAlerts({ ...getRunAlerts(), ...(patch && typeof patch === "object" ? patch : {}) });
  setMeta(META_KEY, JSON.stringify(next));
  return next;
}

export interface RunAlertInput {
  status: string;
  startedAt?: string;
  finishedAt?: string;
  /** 창이 지금 사용자 눈앞에 있는가(포커스). */
  focused: boolean;
  /** 호스트가 관측한 '사람 입력 대기' — 상태 어휘가 아니라 별도 신호로 온다. */
  pendingQuestion?: boolean;
}

export type RunAlertDecision =
  | { alert: false; reason: "disabled" | "focused" | "too-short" | "failure-muted" | "not-terminal" }
  | { alert: true; kind: "done" | "failed" | "attention" };

/**
 * 알릴지 말지 — **순수 함수**. 게이트가 값으로 단언하고, 알림 배관 없이도 검사된다.
 * 실행 시간은 영수증의 두 시각으로 잰다. 못 재면 0초로 보고 문턱을 적용하지 않는다
 * (모르는 것을 짧다고 단정해 조용히 삼키지 않는다).
 */
export function decideRunAlert(settings: RunAlertSettings, input: RunAlertInput): RunAlertDecision {
  if (!settings.enabled) return { alert: false, reason: "disabled" };
  /*
   * ★상태 어휘는 shared/types.ts 의 InvocationRunStatus 가 정본이다:
   *   running | cancelling | completed | failed | cancelled | interrupted
   * 처음에 "succeeded" 로 지어 썼다가 실제 타입과 달라 알림이 영영 안 나올 뻔했다 —
   * 어휘를 짐작하면 이 함수는 조용히 항상 false 를 돌려준다.
   * "입력 대기"는 상태가 아니라 별도 신호(pendingQuestion)로 온다.
   */
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
  if (!terminal.has(input.status)) return { alert: false, reason: "not-terminal" };
  const failed = input.status === "failed" || input.status === "cancelled" || input.status === "interrupted";
  const waiting = input.pendingQuestion === true;
  if (failed && !settings.alsoOnFailure) return { alert: false, reason: "failure-muted" };
  if (settings.onlyWhenUnfocused && input.focused) return { alert: false, reason: "focused" };
  const started = Date.parse(input.startedAt ?? "");
  const finished = Date.parse(input.finishedAt ?? "");
  const elapsedSeconds = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? (finished - started) / 1000
    : null;
  // 기다릴 만큼 걸린 일만 알린다. 다만 실패와 '입력 대기'는 길이와 무관하게 알린다 —
  // 짧게 실패한 실행이야말로 사람이 모르면 그대로 멈춰 있는다.
  if (!failed && !waiting && settings.minSeconds > 0 && elapsedSeconds !== null && elapsedSeconds < settings.minSeconds) {
    return { alert: false, reason: "too-short" };
  }
  return { alert: true, kind: failed ? "failed" : waiting ? "attention" : "done" };
}

/** The part of a BrowserWindow the "is the person looking at it" rule reads (plain objects in the gates). */
export interface WatchableWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

/**
 * The person is looking at this window: it has focus, is shown, and is not minimized. Focus alone is not that.
 * Windows can leave a minimized window as the active window (SW_MINIMIZE activates the next top-level window; when no
 * other window can take activation ours stays active, and IsWindowVisible stays true while iconic), so `isFocused()`
 * alone can answer "watching" for an app sitting minimized in the taskbar. Windows 11 VM 2026-10-24: a 50 s Work run
 * ended while the window was minimized and no completion alert appeared. macOS (measured on Electron 43.7.6): a minimized
 * window and a window behind another app already report isFocused() false; the extra checks change nothing there.
 */
export function windowWatched(win: WatchableWindow | null | undefined): boolean {
  try {
    return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused());
  } catch {
    return false; // a window closing under us is not being looked at
  }
}

export function anyWindowWatched(windows: Iterable<WatchableWindow | null | undefined>): boolean {
  for (const win of windows) if (windowWatched(win)) return true;
  return false;
}

/**
 * 앱을 흔든다 — OS마다 이름이 다른 같은 뜻.
 * 없는 API 는 부르지 않는다: `app.dock` 은 macOS 에만 있고, 다른 OS 에서 만지면 예외다.
 */
export function bounceApp(win: BrowserWindow | null): void {
  try {
    if (process.platform === "darwin") {
      app.dock?.bounce("critical");
      return;
    }
    // Windows·Linux: 작업표시줄 단추 깜빡임. 창이 없으면 흔들 대상도 없다.
    win?.flashFrame(true);
  } catch {
    // 알림은 부가 기능이다. 어떤 OS 에서 실패하든 실행 결과를 건드리지 않는다.
  }
}

export interface RunAlertText { title: string; body: string }

export function runAlertText(kind: "done" | "failed" | "attention", locale: string, goal: string): RunAlertText {
  const ko = locale === "ko";
  const subject = goal.trim().split(/\r?\n/)[0].slice(0, 80);
  const title = kind === "failed"
    ? (ko ? "실행 실패" : "Run failed")
    : kind === "attention"
      ? (ko ? "확인이 필요합니다" : "Needs your input")
      : (ko ? "작업 완료" : "Work finished");
  return { title: `Agentlas · ${title}`, body: subject || (ko ? "실행이 끝났습니다." : "The run has ended.") };
}

/** 실제로 알린다. 어떤 실패도 실행 결과에 영향을 주지 않는다. */
export function fireRunAlert(input: {
  decision: Extract<RunAlertDecision, { alert: true }>;
  settings: RunAlertSettings;
  locale: string;
  goal: string;
  onClick?: () => void;
  /** The window whose taskbar button flashes (Windows/Linux). getAllWindows()[0] could be a hidden
   *  helper (Business console, print helper), so the flash was invisible (Windows audit ui.md #18). */
  flashWindow?: () => BrowserWindow | null;
}): void {
  const text = runAlertText(input.decision.kind, input.locale, input.goal);
  try {
    if (input.settings.notification && Notification.isSupported()) {
      const notification = new Notification({
        title: text.title,
        body: text.body,
        // silent:true 면 OS 알림음이 안 난다 — "소리 알람" 스위치가 사는 곳이 여기다.
        silent: !input.settings.sound,
      });
      if (input.onClick) notification.on("click", input.onClick);
      retainNotification(notification).show();
    }
  } catch {
    // 알림이 막혀 있어도 흔들기는 따로 시도한다.
  }
  if (input.settings.bounce) {
    const preferred = input.flashWindow?.() ?? null;
    bounceApp(preferred && !preferred.isDestroyed() ? preferred
      : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible()) ?? null);
  }
}
