// preload.ts가 contextBridge로 노출한 window.agentlas / window.agentlasEvents 타이핑.
import type {
  AgentlasIpc,
  AgentlasUpdaterEvents,
  McpInvocationEvent,
  BrowserApprovalRequestEvent,
} from "./types";

interface AgentlasEvents {
  on: (
    channel: string,
    handler: (event: McpInvocationEvent) => void,
  ) => () => void;
  /** 실행 중 chatId 목록 방송 구독 — 사이드바 "실행 중" 인디케이터. unsubscribe 반환. */
  onActiveChats: (handler: (chatIds: string[]) => void) => () => void;
  /** Browser 승인 요청 구독 — 경량 바텀시트. unsubscribe 반환. */
  onBrowserApproval: (handler: (req: BrowserApprovalRequestEvent) => void) => () => void;
}

interface AgentlasFilesBridge {
  /** 드래그&드롭/선택된 File(폴더 포함)의 실제 디스크 경로 */
  pathForFile: (file: File) => string;
}

declare global {
  interface Window {
    agentlas: AgentlasIpc;
    agentlasEvents: AgentlasEvents;
    agentlasUpdater: AgentlasUpdaterEvents;
    agentlasFiles?: AgentlasFilesBridge;
  }
}

/**
 * Renderer 어디서나 호출. SSR 시점에는 window가 없으므로 client-only.
 * 안전하게 typeof check.
 */
export function ipc(): AgentlasIpc | null {
  if (typeof window === "undefined") return null;
  return window.agentlas ?? null;
}

export function ipcEvents(): AgentlasEvents | null {
  if (typeof window === "undefined") return null;
  return window.agentlasEvents ?? null;
}

export function updaterEvents(): AgentlasUpdaterEvents | null {
  if (typeof window === "undefined") return null;
  return window.agentlasUpdater ?? null;
}

/** 드롭된 File의 디스크 경로를 얻는다 — 폴더 드래그 임포트용. */
export function pathForDroppedFile(file: File): string | null {
  if (typeof window === "undefined") return null;
  return window.agentlasFiles?.pathForFile(file) ?? null;
}
