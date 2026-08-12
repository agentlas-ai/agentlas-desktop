"use client";

/**
 * 텔레그램 ↔ One 연결 팝업의 화면 밖 상태.
 *
 * 자동 연결은 사용자가 텔레그램 웹에서 QR 로그인할 때까지 기다린다(분 단위).
 * 그동안 팝업을 닫거나 다른 메뉴로 가면 컴포넌트가 언마운트되는데, Main의 작업은
 * 계속 돌고 있다. 진행 상태를 컴포넌트에 두면 그 사실이 화면에서 통째로 사라진다.
 * 그래서 열림 여부·busy·로그를 모듈 스코프에 둔다(빌드·클라우드 업로드와 같은 방식).
 */
export type TelegramOneLogTone = "info" | "success" | "error";

export interface TelegramOneLogRow {
  id: string;
  at: string;
  text: string;
  tone: TelegramOneLogTone;
}

export interface TelegramOneDialogState {
  open: boolean;
  busy: string | null;
  logs: TelegramOneLogRow[];
  /** 정리 결과 영수증. 토스트와 달리 팝업을 닫을 때까지 남는다. */
  receipt: string | null;
}

const EMPTY: TelegramOneDialogState = { open: false, busy: null, logs: [], receipt: null };

let state: TelegramOneDialogState = EMPTY;
let snapshot: TelegramOneDialogState = state;
const listeners = new Set<() => void>();

function emit(next: TelegramOneDialogState): void {
  state = next;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeTelegramOneDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTelegramOneDialogSnapshot(): TelegramOneDialogState {
  return snapshot;
}

/** SSR 스냅샷 — useSyncExternalStore 가 서버에서도 안전하게 읽는다. */
export function getTelegramOneDialogServerSnapshot(): TelegramOneDialogState {
  return EMPTY;
}

export function openTelegramOneDialog(): void {
  if (state.open) return;
  emit({ ...state, open: true });
}

export function closeTelegramOneDialog(): void {
  if (!state.open) return;
  // busy/로그는 일부러 남긴다 — 다시 열면 진행 중인 연결이 그대로 보여야 한다.
  emit({ ...state, open: false });
}

export function setTelegramOneBusy(busy: string | null): void {
  emit({ ...state, busy });
}

export function pushTelegramOneLog(row: TelegramOneLogRow): void {
  emit({ ...state, logs: [row, ...state.logs].slice(0, 24) });
}

export function setTelegramOneReceipt(receipt: string | null): void {
  emit({ ...state, receipt });
}

export function telegramOneLogId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function telegramOneNowLabel(locale: string): string {
  return new Date().toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** IPC 에러 문자열에서 Electron 래퍼 접두어를 걷어낸다. */
export function friendlyTelegramError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
}
