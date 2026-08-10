// preload.ts가 contextBridge로 노출한 window.agentlas / window.agentlasEvents 타이핑.
import type {
  AgentlasIpc,
  AgentlasUpdaterEvents,
  McpInvocationEvent,
  BrowserApprovalRequestEvent,
  FsPathGrant,
} from "./types";
import type { SiteActivityEvent } from "@shared/site-studio";

interface AgentlasEvents {
  on: (
    channel: string,
    handler: (event: McpInvocationEvent) => void,
  ) => () => void;
  /** 실행 중 chatId 목록 방송 구독 — 사이드바 "실행 중" 인디케이터. unsubscribe 반환. */
  onActiveChats: (handler: (chatIds: string[]) => void) => () => void;
  /** Pairing/device lifecycle notification. Contains no nonce, token, or certificate. */
  onMobileBridgeChanged?: (handler: (event: { reason: string }) => void) => () => void;
  /** Browser 승인 요청 구독 — 경량 바텀시트. unsubscribe 반환. */
  onBrowserApproval: (handler: (req: BrowserApprovalRequestEvent) => void) => () => void;
  /** Site Copilot의 사용자용 처리 단계·타이핑 피드백 구독. */
  onSiteActivity: (handler: (event: SiteActivityEvent) => void) => () => void;
}

interface AgentlasFilesBridge {
  /** webUtils가 확인한 드롭 항목에 대해 main이 발급한 세션 권한. */
  grantForFile: (file: File) => Promise<FsPathGrant | null>;
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
  // Surface-specific components own their own failure UX. A Work IPC failure
  // must never be converted into a hidden One turn or One decision request.
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

/** 드롭된 File에 대한 exact-file/폴더 권한을 얻는다. */
export async function grantForDroppedFile(file: File): Promise<FsPathGrant | null> {
  if (typeof window === "undefined") return null;
  return window.agentlasFiles?.grantForFile(file) ?? null;
}
